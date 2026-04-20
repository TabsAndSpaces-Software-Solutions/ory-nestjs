/**
 * Unit tests for `IamModule` — the DynamicModule consumers wire into
 * their `AppModule`.
 *
 * Covers the full contract:
 *   - `forRoot` with valid config inits a Nest app; all exported providers
 *     resolve from DI.
 *   - `forRoot` with invalid config (e.g. missing kratos.publicUrl) throws
 *     `IamConfigurationError` synchronously.
 *   - When `global !== false` (default), `APP_GUARD` is registered so an
 *     unauthenticated request to a non-Public route receives 401.
 *   - When `global: false`, NO `APP_GUARD` is registered; the same route
 *     returns 200 without credentials.
 *   - `@Public()` on a handler bypasses the global guard.
 *   - `forRootAsync` with a factory that returns valid config → app inits,
 *     DI resolves.
 *   - `forRootAsync` with a factory that returns invalid config → init
 *     throws `IamConfigurationError`.
 *   - Consumer-provided `auditSink` (as a Provider binding for `AUDIT_SINK`)
 *     wins over the default `LoggerAuditSink`.
 */
import 'reflect-metadata';
import {
  Controller,
  Get,
  INestApplication,
  Injectable,
  Module,
  UseGuards,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import * as http from 'node:http';

import {
  AUDIT_SINK,
  type AuditSink,
  LoggerAuditSink,
} from '../../../src/audit';
import type { IamOptions } from '../../../src/config';
import { Public } from '../../../src/decorators/public.decorator';
import { IamConfigurationError } from '../../../src/errors';
import {
  SessionGuard,
  OptionalSessionGuard,
  RoleGuard,
  PermissionGuard,
  OAuth2Guard,
} from '../../../src/guards';
import { IamHealthIndicator } from '../../../src/health';
import {
  IdentityService,
  SessionService,
  PermissionService,
  TokenService,
  FlowService,
} from '../../../src/services';
import { TransportFactory } from '../../../src/transport/transport.factory';
import { IamModule } from '../../../src/module/ory-nestjs.module';

/**
 * Build a valid options object for a single-tenant self-hosted deployment.
 */
function validOptions(): IamOptions {
  return {
    tenants: {
      customer: {
        mode: 'self-hosted',
        transport: 'cookie',
        kratos: { publicUrl: 'https://kratos.test' },
      },
    },
  };
}

/**
 * Force every transport to return null (unauthenticated) so the global
 * SessionGuard rejects without actually hitting Ory.
 *
 * Spies the prototype method so every `TransportFactory` instance built by
 * the module is affected.
 */
function stubTransportAlwaysNull(): jest.SpyInstance {
  return jest
    .spyOn(TransportFactory.prototype, 'forTenant')
    .mockReturnValue({ resolve: async () => null });
}

@Controller()
class PingController {
  @Get('/ping')
  ping(): string {
    return 'ok';
  }

  @Get('/public-ping')
  @Public()
  publicPing(): string {
    return 'public';
  }
}

@Module({ controllers: [PingController] })
class PingModule {}

/**
 * A controller that opts in to `SessionGuard` per-route via `@UseGuards`.
 * Used to verify the "global: false + @UseGuards(SessionGuard)" path —
 * SessionGuard (which lives inside IamModule) must still be resolvable
 * via DI when the consumer wires it manually.
 */
@Controller()
class GuardedController {
  @Get('/ping')
  ping(): string {
    return 'ok';
  }

  @Get('/guarded')
  @UseGuards(SessionGuard)
  guarded(): string {
    return 'guarded';
  }
}

@Module({ controllers: [GuardedController] })
class GuardedModule {}

async function requestStatus(
  app: INestApplication,
  path: string,
): Promise<number> {
  const server = app.getHttpServer() as http.Server;
  await new Promise<void>((resolve) => {
    if (server.listening) return resolve();
    server.listen(0, () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') {
    throw new Error('server has no address');
  }
  return new Promise<number>((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: addr.port, path, method: 'GET' },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('IamModule', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('forRoot — sync registration', () => {
    it('inits a Nest app and resolves exported providers from DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [IamModule.forRoot(validOptions())],
      }).compile();

      expect(moduleRef.get(SessionGuard)).toBeInstanceOf(SessionGuard);
      expect(moduleRef.get(OptionalSessionGuard)).toBeInstanceOf(
        OptionalSessionGuard,
      );
      expect(moduleRef.get(RoleGuard)).toBeInstanceOf(RoleGuard);
      expect(moduleRef.get(PermissionGuard)).toBeInstanceOf(PermissionGuard);
      expect(moduleRef.get(OAuth2Guard)).toBeInstanceOf(OAuth2Guard);
      expect(moduleRef.get(IdentityService)).toBeInstanceOf(IdentityService);
      expect(moduleRef.get(SessionService)).toBeInstanceOf(SessionService);
      expect(moduleRef.get(PermissionService)).toBeInstanceOf(
        PermissionService,
      );
      expect(moduleRef.get(TokenService)).toBeInstanceOf(TokenService);
      expect(moduleRef.get(FlowService)).toBeInstanceOf(FlowService);
      expect(moduleRef.get(IamHealthIndicator)).toBeInstanceOf(
        IamHealthIndicator,
      );

      await moduleRef.close();
    });

    it('throws IamConfigurationError when config is invalid (missing kratos.publicUrl)', () => {
      const bad: unknown = {
        tenants: {
          customer: {
            mode: 'self-hosted',
            transport: 'cookie',
            kratos: {},
          },
        },
      };
      expect(() =>
        IamModule.forRoot(bad as IamOptions),
      ).toThrow(IamConfigurationError);
    });

    it('registers APP_GUARD when global !== false (default): non-Public route without credentials → 401', async () => {
      stubTransportAlwaysNull();

      const moduleRef = await Test.createTestingModule({
        imports: [IamModule.forRoot(validOptions()), PingModule],
      }).compile();
      const app = moduleRef.createNestApplication();
      await app.init();

      try {
        const status = await requestStatus(app, '/ping');
        expect(status).toBe(401);

        const publicStatus = await requestStatus(app, '/public-ping');
        expect(publicStatus).toBe(200);
      } finally {
        await app.close();
      }
    });

    it('does NOT register APP_GUARD when global: false — no credentials → 200', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          IamModule.forRoot({ ...validOptions(), global: false }),
          PingModule,
        ],
      }).compile();
      const app = moduleRef.createNestApplication();
      await app.init();

      try {
        const status = await requestStatus(app, '/ping');
        expect(status).toBe(200);
      } finally {
        await app.close();
      }
    });

    it(
      'global: false — @UseGuards(SessionGuard) still protects a route ' +
        '(module remains globally visible in the DI sense)',
      async () => {
        stubTransportAlwaysNull();

        const moduleRef = await Test.createTestingModule({
          imports: [
            IamModule.forRoot({ ...validOptions(), global: false }),
            GuardedModule,
          ],
        }).compile();
        const app = moduleRef.createNestApplication();
        await app.init();

        try {
          // No @UseGuards decorator on this route and no APP_GUARD either,
          // so it must succeed without credentials.
          const openStatus = await requestStatus(app, '/ping');
          expect(openStatus).toBe(200);

          // @UseGuards(SessionGuard) must resolve SessionGuard from DI
          // (including its TENANT_REGISTRY dependency) and reject the
          // unauthenticated request with 401.
          const guardedStatus = await requestStatus(app, '/guarded');
          expect(guardedStatus).toBe(401);
        } finally {
          await app.close();
        }
      },
    );

    it('installs a NoopSessionCache by default when no sessionCache is provided', async () => {
      const { SESSION_CACHE, NoopSessionCache } = await import('../../../src/cache');
      const moduleRef = await Test.createTestingModule({
        imports: [IamModule.forRoot(validOptions())],
      }).compile();

      const cache = moduleRef.get(SESSION_CACHE as unknown as symbol);
      expect(cache).toBeInstanceOf(NoopSessionCache);
      await moduleRef.close();
    });

    it('refuses to boot when cache.sessionTtlMs > 0 and no sessionCache was provided', () => {
      const opts: IamOptions = {
        tenants: {
          customer: {
            mode: 'self-hosted',
            transport: 'cookie',
            kratos: { publicUrl: 'https://kratos.test' },
            cache: { sessionTtlMs: 60_000 },
          },
        },
      };
      expect(() => IamModule.forRoot(opts)).toThrow(IamConfigurationError);
    });

    it('accepts a SessionCache instance via options.sessionCache and exposes it on SESSION_CACHE', async () => {
      const { InMemorySessionCache, SESSION_CACHE } = await import('../../../src/cache');
      const injected = new InMemorySessionCache();
      const opts: IamOptions = {
        tenants: {
          customer: {
            mode: 'self-hosted',
            transport: 'cookie',
            kratos: { publicUrl: 'https://kratos.test' },
            cache: { sessionTtlMs: 60_000 },
          },
        },
        sessionCache: injected as unknown,
      };

      const moduleRef = await Test.createTestingModule({
        imports: [IamModule.forRoot(opts)],
      }).compile();

      expect(moduleRef.get(SESSION_CACHE as unknown as symbol)).toBe(injected);
      await moduleRef.close();
    });

    it('consumer-provided AUDIT_SINK Provider wins over default LoggerAuditSink', async () => {
      @Injectable()
      class CustomSink implements AuditSink {
        public emit(): void {}
      }

      const moduleRef = await Test.createTestingModule({
        imports: [
          IamModule.forRoot({
            ...validOptions(),
            auditSink: {
              provide: AUDIT_SINK,
              useClass: CustomSink,
            },
          }),
        ],
      }).compile();

      const sink = moduleRef.get(AUDIT_SINK);
      expect(sink).toBeInstanceOf(CustomSink);
      expect(sink).not.toBeInstanceOf(LoggerAuditSink);

      await moduleRef.close();
    });
  });

  describe('forRootAsync — async registration', () => {
    it('inits with a useFactory that returns valid config', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          IamModule.forRootAsync({
            useFactory: async () => validOptions(),
          }),
        ],
      }).compile();

      expect(moduleRef.get(SessionGuard)).toBeInstanceOf(SessionGuard);
      expect(moduleRef.get(IdentityService)).toBeInstanceOf(IdentityService);

      await moduleRef.close();
    });

    it('throws IamConfigurationError when factory returns invalid config', async () => {
      const bad: unknown = {
        tenants: {
          customer: {
            mode: 'self-hosted',
            transport: 'cookie',
            kratos: {},
          },
        },
      };

      await expect(
        Test.createTestingModule({
          imports: [
            IamModule.forRootAsync({
              useFactory: async () => bad as IamOptions,
            }),
          ],
        }).compile(),
      ).rejects.toThrow(IamConfigurationError);
    });

    it('inits with a useClass that provides the options', async () => {
      @Injectable()
      class OptsFactory {
        createIamOptions(): IamOptions {
          return validOptions();
        }
      }

      const moduleRef = await Test.createTestingModule({
        imports: [
          IamModule.forRootAsync({
            useClass: OptsFactory,
          }),
        ],
      }).compile();

      expect(moduleRef.get(SessionGuard)).toBeInstanceOf(SessionGuard);
      await moduleRef.close();
    });

    it('throws when none of useFactory / useClass / useExisting is supplied', () => {
      expect(() => IamModule.forRootAsync({})).toThrow(
        IamConfigurationError,
      );
    });

    it('forwards consumer imports into the async module', async () => {
      @Injectable()
      class OptsProvider {
        opts(): IamOptions {
          return validOptions();
        }
      }

      @Module({
        providers: [OptsProvider],
        exports: [OptsProvider],
      })
      class OptsModule {}

      const moduleRef = await Test.createTestingModule({
        imports: [
          IamModule.forRootAsync({
            imports: [OptsModule],
            useFactory: (p: OptsProvider) => p.opts(),
            inject: [OptsProvider],
          }),
        ],
      }).compile();

      expect(moduleRef.get(SessionGuard)).toBeInstanceOf(SessionGuard);
      await moduleRef.close();
    });
  });
});
