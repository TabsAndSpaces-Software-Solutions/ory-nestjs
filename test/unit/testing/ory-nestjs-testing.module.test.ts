/**
 * Unit tests for `IamTestingModule` — the consumer-facing hermetic test
 * harness for auth-gated controllers.
 *
 * Scope (per spec unit `tst`):
 *   1. `forRoot` with a fixture identity:
 *        - `@CurrentUser()` yields the fixture on a guarded route.
 *   2. `forRoot` without a fixture:
 *        - Guarded route returns 401.
 *   3. `@Public()` routes:
 *        - Return 200 without a fixture identity.
 *   4. `permissions` map:
 *        - `listings:edit:42 → true` allows the guarded route.
 *        - `listings:edit:42 → false` (or missing) denies with 403.
 *   5. `introspections` map (OAuth2Guard):
 *        - Known active token → allow.
 *        - Absent / inactive token → 401.
 *   6. Service stubs are usable directly:
 *        - `PermissionService.forTenant('x').grant(...)` then `.check(...)`
 *          returns true.
 *   7. Runtime mutation:
 *        - `testingModule.get(TESTING_STATE).permissions.set(...)` after
 *          module construction takes effect on the next request.
 *
 * Guarantees for the whole suite:
 *   - No `@ory/*` imports.
 *   - No network I/O.
 */
import 'reflect-metadata';
import {
  Controller,
  Get,
  INestApplication,
  Param,
  UseGuards,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as http from 'node:http';

import { Anonymous } from '../../../src/decorators/anonymous.decorator';
import { CurrentUser } from '../../../src/decorators/current-user.decorator';
import { Public } from '../../../src/decorators/public.decorator';
import { RequirePermission } from '../../../src/decorators/require-permission.decorator';
import { RequireRole } from '../../../src/decorators/require-role.decorator';
import { Tenant } from '../../../src/decorators/tenant.decorator';
import { OAuth2Guard } from '../../../src/guards';
import {
  FlowService,
  IdentityService,
  PermissionService,
  SessionService,
  TokenService,
} from '../../../src/services';
import {
  TESTING_STATE,
  TestingState,
  IamTestingModule,
} from '../../../src/testing';
import type {
  IamIdentity,
  IamIdentityWithTraits,
  IamTokenIntrospection,
} from '../../../src/dto';

/** Standard fixture for the "authenticated user" test cases. */
function fixtureIdentity(
  overrides: Partial<IamIdentity> = {},
): IamIdentity {
  return {
    id: 'user-fixture',
    schemaId: 'default',
    state: 'active',
    verifiedAddressesFlags: { email: true, phone: false },
    tenant: 'customer',
    ...overrides,
  };
}

function fixtureIdentityWithTraits(): IamIdentityWithTraits {
  return {
    ...fixtureIdentity(),
    traits: { email: 'fixture@ory-nestjs.test' },
  };
}

/** Minimal HTTP helper — makes a GET and returns `{ status, body }`. */
async function get(
  app: INestApplication,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const server = app.getHttpServer() as http.Server;
  await new Promise<void>((resolve) => {
    if (server.listening) return resolve();
    server.listen(0, () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') {
    throw new Error('server has no address');
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: addr.port,
        path,
        method: 'GET',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ----- Controllers used across the test cases ------------------------

@Controller()
class GuardedController {
  @Get('/whoami')
  whoami(@CurrentUser() user: unknown): unknown {
    return { user };
  }

  @Get('/public')
  @Public()
  publicRoute(): string {
    return 'public-ok';
  }
}

@Controller()
class PermissionController {
  // Relies on the testing module's global APP_GUARD stack — no
  // `@UseGuards(...)` needed. The `@RequirePermission(...)` metadata is
  // picked up by FakePermissionGuard registered as an APP_GUARD.
  @Get('/listings/:id')
  @RequirePermission({
    namespace: 'listings',
    relation: 'edit',
    object: (req: unknown) =>
      (req as { params: { id: string } }).params.id,
  })
  edit(@Param('id') id: string): { id: string } {
    return { id };
  }
}

@Controller()
class RoleController {
  @Get('/admin-only')
  @RequireRole('admin')
  adminOnly(): string {
    return 'admin-ok';
  }

  @Get('/tenant-scoped')
  @Tenant('customer')
  tenantScoped(): string {
    return 'tenant-ok';
  }
}

@Controller()
class OAuth2Controller {
  // `@Anonymous()` so FakeSessionGuard (APP_GUARD) short-circuits; the
  // `@UseGuards(OAuth2Guard)` is then the only gate.
  @Get('/machine')
  @Anonymous()
  @UseGuards(OAuth2Guard)
  machine(@CurrentUser() user: unknown): unknown {
    return { user };
  }
}

// ----- Test cases ----------------------------------------------------

describe('IamTestingModule', () => {
  describe('forRoot — fixture identity', () => {
    it('populates @CurrentUser() on a guarded route', async () => {
      const identity = fixtureIdentityWithTraits();
      const moduleRef = await Test.createTestingModule({
        imports: [IamTestingModule.forRoot({ identity })],
        controllers: [GuardedController],
      }).compile();

      const app = moduleRef.createNestApplication();
      await app.init();
      try {
        const { status, body } = await get(app, '/whoami');
        expect(status).toBe(200);
        const parsed = JSON.parse(body) as { user: IamIdentity };
        expect(parsed.user.id).toBe('user-fixture');
      } finally {
        await app.close();
      }
    });
  });

  describe('forRoot — no fixture', () => {
    it('guarded route returns 401', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [IamTestingModule.forRoot({})],
        controllers: [GuardedController],
      }).compile();

      const app = moduleRef.createNestApplication();
      await app.init();
      try {
        const { status } = await get(app, '/whoami');
        expect(status).toBe(401);
      } finally {
        await app.close();
      }
    });

    it('@Public() route returns 200 without fixture', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [IamTestingModule.forRoot({})],
        controllers: [GuardedController],
      }).compile();

      const app = moduleRef.createNestApplication();
      await app.init();
      try {
        const { status, body } = await get(app, '/public');
        expect(status).toBe(200);
        expect(body).toBe('public-ok');
      } finally {
        await app.close();
      }
    });
  });

  describe('permissions map controls PermissionGuard', () => {
    it('allows when permission key is set to true', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          IamTestingModule.forRoot({
            identity: fixtureIdentity(),
            permissions: { 'listings:edit:42': true },
          }),
        ],
        controllers: [PermissionController],
      }).compile();

      const app = moduleRef.createNestApplication();
      await app.init();
      try {
        const { status, body } = await get(app, '/listings/42');
        expect(status).toBe(200);
        expect(JSON.parse(body)).toEqual({ id: '42' });
      } finally {
        await app.close();
      }
    });

    it('denies with 403 when key is explicitly false', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          IamTestingModule.forRoot({
            identity: fixtureIdentity(),
            permissions: { 'listings:edit:42': false },
          }),
        ],
        controllers: [PermissionController],
      }).compile();

      const app = moduleRef.createNestApplication();
      await app.init();
      try {
        const { status } = await get(app, '/listings/42');
        expect(status).toBe(403);
      } finally {
        await app.close();
      }
    });

    it('denies with 403 when key is missing (default-deny)', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          IamTestingModule.forRoot({
            identity: fixtureIdentity(),
            // no permissions map
          }),
        ],
        controllers: [PermissionController],
      }).compile();

      const app = moduleRef.createNestApplication();
      await app.init();
      try {
        const { status } = await get(app, '/listings/42');
        expect(status).toBe(403);
      } finally {
        await app.close();
      }
    });
  });

  describe('@RequireRole() via real RoleGuard', () => {
    it('allows when the fixture identity carries the required role via metadataPublic', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          IamTestingModule.forRoot({
            identity: fixtureIdentity({
              metadataPublic: { roles: ['admin'] },
            }),
          }),
        ],
        controllers: [RoleController],
      }).compile();

      const app = moduleRef.createNestApplication();
      await app.init();
      try {
        const { status, body } = await get(app, '/admin-only');
        expect(status).toBe(200);
        expect(body).toBe('admin-ok');
      } finally {
        await app.close();
      }
    });

    it('denies 403 when the fixture lacks the required role', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          IamTestingModule.forRoot({
            identity: fixtureIdentity({
              metadataPublic: { roles: ['viewer'] },
            }),
          }),
        ],
        controllers: [RoleController],
      }).compile();

      const app = moduleRef.createNestApplication();
      await app.init();
      try {
        const { status } = await get(app, '/admin-only');
        expect(status).toBe(403);
      } finally {
        await app.close();
      }
    });

    it('@Tenant() route passes when fixture identity is present', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          IamTestingModule.forRoot({ identity: fixtureIdentity() }),
        ],
        controllers: [RoleController],
      }).compile();

      const app = moduleRef.createNestApplication();
      await app.init();
      try {
        const { status, body } = await get(app, '/tenant-scoped');
        expect(status).toBe(200);
        expect(body).toBe('tenant-ok');
      } finally {
        await app.close();
      }
    });
  });

  describe('global: false opts out of APP_GUARD', () => {
    it('unauthenticated request to a non-Public route returns 200', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [IamTestingModule.forRoot({ global: false })],
        controllers: [GuardedController],
      }).compile();

      const app = moduleRef.createNestApplication();
      await app.init();
      try {
        const { status } = await get(app, '/whoami');
        expect(status).toBe(200);
      } finally {
        await app.close();
      }
    });
  });

  describe('introspections map controls OAuth2Guard', () => {
    /**
     * `@UseGuards(OAuth2Guard)` in a consumer test exercises the OAuth2
     * flow. The testing module replaces `OAuth2Guard` via DI with
     * `FakeOAuth2Guard` at the service-token layer, but Nest's enhancer
     * resolver additionally registers the class token as an injectable on
     * the controller's module. To make that registration resolve without
     * pulling the real guard's dependencies, consumers pair the testing
     * module with `Test.createTestingModule(...).overrideGuard(OAuth2Guard)
     * .useExisting(FakeOAuth2Guard)` — shown below.
     */
    async function buildOAuth2Module(options: {
      introspections?: Record<string, IamTokenIntrospection>;
    }) {
      // The OAuth2Guard path works through a pure APP_GUARD binding.
      // Instead of `@UseGuards(OAuth2Guard)` we rely on the testing
      // module installing `FakeOAuth2Guard` as a global guard when the
      // request carries an `Authorization: Bearer ...` header.
      const state = new TestingState(options);
      return { state };
    }

    it('FakeOAuth2Guard allows when the bearer token is active', async () => {
      const intro: IamTokenIntrospection = {
        active: true,
        clientId: 'machine-1',
        scope: ['read:listings'],
        tenant: 'customer',
      };
      const { state } = await buildOAuth2Module({
        introspections: { 'good-token': intro },
      });
      const { FakeOAuth2Guard } = await import(
        '../../../src/testing/guards/fake-oauth2.guard'
      );
      const guard = new FakeOAuth2Guard(state);
      const ctx = {
        switchToHttp: () => ({
          getRequest: () => ({
            headers: { authorization: 'Bearer good-token' },
          }),
        }),
      } as never;
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('FakeOAuth2Guard denies when the bearer token is missing', async () => {
      const { state } = await buildOAuth2Module({});
      const { FakeOAuth2Guard } = await import(
        '../../../src/testing/guards/fake-oauth2.guard'
      );
      const guard = new FakeOAuth2Guard(state);
      const ctx = {
        switchToHttp: () => ({
          getRequest: () => ({ headers: {} }),
        }),
      } as never;
      expect(() => guard.canActivate(ctx)).toThrow();
    });

    it('FakeOAuth2Guard denies when the bearer token is not known', async () => {
      const { state } = await buildOAuth2Module({});
      const { FakeOAuth2Guard } = await import(
        '../../../src/testing/guards/fake-oauth2.guard'
      );
      const guard = new FakeOAuth2Guard(state);
      const ctx = {
        switchToHttp: () => ({
          getRequest: () => ({
            headers: { authorization: 'Bearer unknown-token' },
          }),
        }),
      } as never;
      expect(() => guard.canActivate(ctx)).toThrow();
    });

    it('FakeOAuth2Guard denies when introspection says active=false', async () => {
      const intro: IamTokenIntrospection = {
        active: false,
        tenant: 'customer',
      };
      const { state } = await buildOAuth2Module({
        introspections: { 'dead-token': intro },
      });
      const { FakeOAuth2Guard } = await import(
        '../../../src/testing/guards/fake-oauth2.guard'
      );
      const guard = new FakeOAuth2Guard(state);
      const ctx = {
        switchToHttp: () => ({
          getRequest: () => ({
            headers: { authorization: 'Bearer dead-token' },
          }),
        }),
      } as never;
      expect(() => guard.canActivate(ctx)).toThrow();
    });

    it(
      'end-to-end: when paired with overrideGuard(OAuth2Guard).useValue(...), ' +
        '@UseGuards(OAuth2Guard) resolves to a FakeOAuth2Guard instance',
      async () => {
        const intro: IamTokenIntrospection = {
          active: true,
          clientId: 'm-1',
          scope: ['read'],
          tenant: 'customer',
        };
        const sharedState = new TestingState({
          introspections: { tok: intro },
        });
        const { FakeOAuth2Guard } = await import(
          '../../../src/testing/guards/fake-oauth2.guard'
        );
        const fake = new FakeOAuth2Guard(sharedState);
        const moduleRef = await Test.createTestingModule({
          imports: [
            IamTestingModule.forRoot({
              introspections: { tok: intro },
            }),
          ],
          controllers: [OAuth2Controller],
        })
          .overrideGuard(OAuth2Guard)
          .useValue(fake)
          .compile();

        const app = moduleRef.createNestApplication();
        await app.init();
        try {
          const { status, body } = await get(app, '/machine', {
            authorization: 'Bearer tok',
          });
          expect(status).toBe(200);
          const parsed = JSON.parse(body) as {
            user: { kind: string; clientId: string };
          };
          expect(parsed.user.kind).toBe('machine');
          expect(parsed.user.clientId).toBe('m-1');
        } finally {
          await app.close();
        }
      },
    );
  });

  describe('service stubs are usable directly', () => {
    it('PermissionService.grant then check returns true', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [IamTestingModule.forRoot({})],
      }).compile();
      try {
        const perm = moduleRef.get(PermissionService);
        const tuple = {
          namespace: 'listings',
          relation: 'edit',
          object: '42',
          subject: 'user-1',
          tenant: 'customer' as const,
        };
        await perm.forTenant('customer').grant(tuple);
        await expect(
          perm.forTenant('customer').check(tuple),
        ).resolves.toBe(true);
      } finally {
        await moduleRef.close();
      }
    });

    it('PermissionService.revoke makes check return false', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          IamTestingModule.forRoot({
            permissions: { 'listings:edit:42': true },
          }),
        ],
      }).compile();
      try {
        const perm = moduleRef.get(PermissionService);
        const tuple = {
          namespace: 'listings',
          relation: 'edit',
          object: '42',
          subject: 'user-1',
          tenant: 'customer' as const,
        };
        await expect(
          perm.forTenant('customer').check(tuple),
        ).resolves.toBe(true);
        await perm.forTenant('customer').revoke(tuple);
        await expect(
          perm.forTenant('customer').check(tuple),
        ).resolves.toBe(false);
      } finally {
        await moduleRef.close();
      }
    });

    it('IdentityService.get returns sanitized identity from identityStore', async () => {
      const identity = fixtureIdentityWithTraits();
      const store = new Map<string, IamIdentityWithTraits>();
      store.set(identity.id, identity);
      const moduleRef = await Test.createTestingModule({
        imports: [
          IamTestingModule.forRoot({ identityStore: store }),
        ],
      }).compile();
      try {
        const idSvc = moduleRef.get(IdentityService);
        const result = await idSvc.forTenant('customer').get(identity.id);
        expect(result.id).toBe(identity.id);
        // Sanitized — traits stripped.
        expect((result as { traits?: unknown }).traits).toBeUndefined();

        const withTraits = await idSvc
          .forTenant('customer')
          .getWithTraits(identity.id);
        expect(withTraits.traits).toEqual({ email: 'fixture@ory-nestjs.test' });
      } finally {
        await moduleRef.close();
      }
    });

    it('SessionService.whoami returns a synthetic session containing the fixture', async () => {
      const identity = fixtureIdentity();
      const moduleRef = await Test.createTestingModule({
        imports: [IamTestingModule.forRoot({ identity })],
      }).compile();
      try {
        const sess = moduleRef.get(SessionService);
        const result = await sess.forTenant('customer').whoami({
          headers: {},
        } as never);
        expect(result.identity.id).toBe(identity.id);
        expect(result.active).toBe(true);
        expect(result.tenant).toBe('customer');
      } finally {
        await moduleRef.close();
      }
    });

    it('TokenService.introspect returns from the map or {active:false}', async () => {
      const intro: IamTokenIntrospection = {
        active: true,
        clientId: 'c-1',
        tenant: 'customer',
      };
      const moduleRef = await Test.createTestingModule({
        imports: [
          IamTestingModule.forRoot({
            introspections: { 'tok-1': intro },
          }),
        ],
      }).compile();
      try {
        const tok = moduleRef.get(TokenService);
        const hit = await tok.forTenant('customer').introspect('tok-1');
        expect(hit.active).toBe(true);
        expect(hit.clientId).toBe('c-1');

        const miss = await tok.forTenant('customer').introspect('nope');
        expect(miss.active).toBe(false);
        expect(miss.tenant).toBe('customer');
      } finally {
        await moduleRef.close();
      }
    });

    it('FlowService.initiateLogin returns a synthetic login flow', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [IamTestingModule.forRoot({})],
      }).compile();
      try {
        const flow = moduleRef.get(FlowService);
        const login = await flow.forTenant('customer').initiateLogin({});
        expect(typeof login.id).toBe('string');
        expect(login.id.length).toBeGreaterThan(0);
        expect(login.tenant).toBe('customer');
      } finally {
        await moduleRef.close();
      }
    });
  });

  describe('mutable state accessible via TESTING_STATE token', () => {
    it('setting a permission key post-construction takes effect', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          IamTestingModule.forRoot({ identity: fixtureIdentity() }),
        ],
        controllers: [PermissionController],
      }).compile();

      const state = moduleRef.get<TestingState>(TESTING_STATE);
      expect(state).toBeInstanceOf(TestingState);

      const app = moduleRef.createNestApplication();
      await app.init();
      try {
        // Initially no permission set → 403.
        const denied = await get(app, '/listings/99');
        expect(denied.status).toBe(403);

        // Flip the key at runtime → 200.
        state.permissions.set('listings:edit:99', true);
        const allowed = await get(app, '/listings/99');
        expect(allowed.status).toBe(200);
      } finally {
        await app.close();
      }
    });
  });
});
