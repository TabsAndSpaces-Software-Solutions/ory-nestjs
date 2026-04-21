/**
 * Minimal NestJS app builder for integration tests.
 *
 * Wires `IamModule` against the live integration Kratos and exposes a
 * handful of probe controllers so each spec can assert on real request →
 * guard → upstream → mapper flows.
 *
 * Exposed routes:
 *   - `GET /me`        — protected. Returns `{ identityId, sessionId }`
 *                        read from `req.user` / `req.session`.
 *   - `GET /optional`  — optional-session. Returns `{ authenticated, ... }`
 *                        so tests can assert the unauthenticated-allowed
 *                        behavior.
 *   - `GET /public`    — `@Public()`. Always 200.
 *
 * A `CapturingAuditSink` is installed so tests can inspect the `auth.success`
 * audit events and verify `cacheHit` / `latencyMs` / `route` attributes.
 */
import {
  Controller,
  Get,
  INestApplication,
  Injectable,
  Module,
  Req,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import {
  AUDIT_SINK,
  type AuditSink,
  InMemorySessionCache,
  Public,
  type ValidatedTenantConfig,
  type IamOptions,
  type IamAuditEvent,
  IamModule,
} from '../../../src';

import { readHandle } from './stack-handle';

export interface IntegrationAppOptions {
  /**
   * Overrides merged into the single tenant's `ValidatedTenantConfig`. Useful for
   * toggling transport kind per-test or enabling session caching.
   */
  readonly tenantOverrides?: Partial<ValidatedTenantConfig>;
  /**
   * If true, wires an `InMemorySessionCache` as the sessionCache backend.
   * Caller is responsible for setting `tenantOverrides.cache.sessionTtlMs > 0`.
   */
  readonly withInMemoryCache?: boolean;
}

export interface IntegrationAppHandle {
  readonly app: INestApplication;
  readonly sink: CapturingAuditSink;
  readonly cache: InMemorySessionCache | undefined;
  readonly baseUrl: string;
  close(): Promise<void>;
}

@Injectable()
export class CapturingAuditSink implements AuditSink {
  public readonly events: IamAuditEvent[] = [];
  public emit(event: IamAuditEvent): void {
    this.events.push(event);
  }
  public clear(): void {
    this.events.length = 0;
  }
  public findByType(type: IamAuditEvent['event']): IamAuditEvent[] {
    return this.events.filter((e) => e.event === type);
  }
}

@Controller()
class ProbeController {
  @Get('/me')
  me(@Req() req: { user?: { id: string }; session?: { id: string } }): {
    identityId: string;
    sessionId: string;
  } {
    return {
      identityId: req.user?.id ?? '',
      sessionId: req.session?.id ?? '',
    };
  }

  @Get('/optional')
  optional(@Req() req: { user?: { id: string } | null }): {
    authenticated: boolean;
    identityId: string | null;
  } {
    const u = req.user;
    if (u === null || u === undefined) {
      return { authenticated: false, identityId: null };
    }
    return { authenticated: true, identityId: u.id };
  }

  @Get('/public')
  @Public()
  publicRoute(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

export async function makeIntegrationApp(
  opts: IntegrationAppOptions = {},
): Promise<IntegrationAppHandle> {
  const handle = readHandle();
  const sink = new CapturingAuditSink();
  const cache = opts.withInMemoryCache ? new InMemorySessionCache() : undefined;

  // Kratos v1.3.1's admin API is network-protected, not token-protected, but
  // our config schema requires `adminToken` whenever `adminUrl` is set on
  // self-hosted mode (it's a guardrail against the common misconfig of
  // exposing adminUrl without auth). Pass an arbitrary token — Kratos
  // accepts Authorization: Bearer <anything> and ignores it.
  const baseTenant: ValidatedTenantConfig = {
    mode: 'self-hosted',
    transport: 'cookie',
    kratos: {
      publicUrl: handle.kratosPublicUrl,
      adminUrl: handle.kratosAdminUrl,
      adminToken: 'integration-test-unused',
      sessionCookieName: 'ory_kratos_session',
    },
  } as unknown as ValidatedTenantConfig;

  const tenantConfig = {
    ...baseTenant,
    ...(opts.tenantOverrides ?? {}),
    kratos: {
      ...baseTenant.kratos,
      ...(opts.tenantOverrides?.kratos ?? {}),
    },
  } as ValidatedTenantConfig;

  const iamOptions: IamOptions = {
    tenants: { demo: tenantConfig },
    defaultTenant: 'demo',
    auditSink: { provide: AUDIT_SINK, useValue: sink },
    ...(cache !== undefined ? { sessionCache: cache } : {}),
  };

  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [IamModule.forRoot(iamOptions), ProbeModule],
  }).compile();

  // Keep only error-level Nest logs so failing tests still surface
  // actionable output without polluting green runs.
  const app = moduleRef.createNestApplication({ logger: ['error'] });
  await app.init();
  await app.listen(0); // bind to a random port

  // Resolve the actual URL the server is listening on.
  const server = app.getHttpServer() as { address: () => { port: number } };
  const addr = server.address();
  if (addr === null || typeof addr === 'string') {
    throw new Error('test app server has no address');
  }
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    app,
    sink,
    cache,
    baseUrl,
    close: async () => {
      await app.close();
    },
  };
}
