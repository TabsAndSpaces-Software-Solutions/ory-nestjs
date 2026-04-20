/**
 * `SessionService` — programmatic inspection and invalidation of sessions,
 * scoped per tenant.
 *
 * Spec unit: `ses`.
 *
 * Shape:
 *   - `SessionService.forTenant(name): SessionServiceFor` returns a stable,
 *     memoized wrapper bound to a single tenant.
 *   - `whoami(req)` delegates to the tenant's `SessionTransport` (the same
 *     strategy the `SessionGuard` uses) and throws `IamUnauthorizedError`
 *     (→ `UnauthorizedException` via `ErrorMapper`) when the transport
 *     cannot resolve a credential. Upstream failures are NOT masked: an
 *     `IamUpstreamUnavailableError` bubbles up to a 503 at the HTTP
 *     boundary.
 *   - `whoamiOrNull(req)` returns `null` for the unauthenticated case but
 *     MUST preserve fail-closed semantics on upstream errors. We achieve
 *     that by calling `transport.resolve` directly and only translating
 *     `null` → `null`; any thrown error is rethrown untouched.
 *   - `revoke(sessionId)` requires an admin Kratos Identity client on the
 *     tenant bundle (`kratosIdentity`). Without it we throw
 *     `IamConfigurationError`. On success we emit an
 *     `authz.session.revoke` audit event tagged with the tenant and
 *     `targetId = sessionId`. Upstream errors are funneled through
 *     `ErrorMapper.toNest` so the HTTP boundary sees a proper Nest
 *     exception (503 for 5xx, rethrow for unknown 4xx).
 *
 * Zero-Ory-leakage: this file does not import `@ory/*`. All Ory contact
 * lives below `src/transport/**` and `src/clients/**`; the admin call here
 * is made via a structurally-typed method on `TenantClients.kratosIdentity`.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { AUDIT_SINK, type AuditSink } from '../audit';
import { correlationStorage } from '../clients/correlation-storage';
import type { TenantName, IamSession } from '../dto';
import {
  ErrorMapper,
  IamConfigurationError,
  IamUnauthorizedError,
} from '../errors';
import { TENANT_REGISTRY } from '../module/registry/tokens';
import type { TenantRegistry } from '../module/registry/tenant-registry.service';
import type { RequestLike } from '../transport';
import { TransportFactory } from '../transport/transport.factory';
import { SESSION_CACHE, type SessionCache } from '../cache';

/**
 * Tenant-scoped view over `SessionService`. Returned by `forTenant(name)`
 * and memoized for the lifetime of the parent service.
 */
export interface SessionServiceFor {
  /**
   * Resolve the inbound request to a `IamSession`. Throws
   * `IamUnauthorizedError` (→ 401) when no credential is present or the
   * credential is rejected; lets upstream failures (5xx / network) bubble
   * up so the HTTP boundary surfaces them as 503.
   */
  whoami(req: RequestLike): Promise<IamSession>;

  /**
   * Like `whoami`, but returns `null` for the unauthenticated case.
   *
   * IMPORTANT: this is NOT `whoami` wrapped in try/catch. It calls the
   * transport directly so upstream failures are rethrown — failing closed
   * on network/5xx is a security requirement.
   */
  whoamiOrNull(req: RequestLike): Promise<IamSession | null>;

  /**
   * Invalidate a session by id via the Kratos Identity admin API. Throws
   * `IamConfigurationError` when the tenant has no admin client. On
   * success, emits an `authz.session.revoke` audit event.
   */
  revoke(sessionId: string): Promise<void>;
}

@Injectable()
export class SessionService {
  private readonly wrappers = new Map<TenantName, SessionServiceFor>();
  private readonly logger = new Logger('OryNestjs:SessionService');

  constructor(
    @Inject(TENANT_REGISTRY) private readonly registry: TenantRegistry,
    @Inject(AUDIT_SINK) private readonly audit: AuditSink,
    private readonly transportFactory: TransportFactory,
    @Optional() @Inject(SESSION_CACHE) private readonly cache?: SessionCache,
  ) {}

  /**
   * Return a tenant-scoped wrapper. The wrapper is built on first call and
   * cached — subsequent calls with the same `name` return the same instance.
   */
  public forTenant(name: TenantName): SessionServiceFor {
    const existing = this.wrappers.get(name);
    if (existing !== undefined) return existing;

    const wrapper: SessionServiceFor = {
      whoami: (req) => this.whoamiImpl(name, req),
      whoamiOrNull: (req) => this.whoamiOrNullImpl(name, req),
      revoke: (sessionId) => this.revokeImpl(name, sessionId),
    };
    this.wrappers.set(name, wrapper);
    return wrapper;
  }

  private async whoamiImpl(
    tenant: TenantName,
    req: RequestLike,
  ): Promise<IamSession> {
    let session: IamSession | null;
    try {
      session = await this.whoamiOrNullImpl(tenant, req);
    } catch (err) {
      // Translate upstream / IamError failures into NestJS HttpExceptions
      // (401 / 403 / 503 / 500). Only the happy-path `null` case is
      // translated below — errors must still be mapped, not swallowed.
      throw ErrorMapper.toNest(err);
    }
    if (session === null) {
      // Preserve fail-closed: translate the null into a 401 at the HTTP
      // boundary via ErrorMapper.
      throw ErrorMapper.toNest(
        new IamUnauthorizedError({ message: 'missing credential' }),
      );
    }
    return session;
  }

  private async whoamiOrNullImpl(
    tenant: TenantName,
    req: RequestLike,
  ): Promise<IamSession | null> {
    const clients = this.registry.get(tenant);
    const transport = this.transportFactory.forTenant(clients.config);
    // NOTE: no try/catch here — upstream errors MUST propagate so callers
    // can't accidentally treat a 5xx as "unauthenticated".
    const result = await transport.resolve(req, clients, tenant, clients.config);
    return result === null ? null : result.session;
  }

  private async revokeImpl(
    tenant: TenantName,
    sessionId: string,
  ): Promise<void> {
    const clients = this.registry.get(tenant);
    if (clients.kratosIdentity === undefined) {
      throw new IamConfigurationError({
        message: `admin API not configured for tenant ${tenant}`,
      });
    }

    try {
      await clients.kratosIdentity.disableSession({ id: sessionId });
    } catch (err) {
      throw ErrorMapper.toNest(err);
    }

    // Cache invalidation: evict any cached entry for this session. Fail-open
    // — a cache outage must not mask a successful revoke. Consumers will see
    // the revoke audit event and the Kratos-side session is already gone.
    if (this.cache !== undefined) {
      try {
        await this.cache.deleteBySessionId(tenant, sessionId);
      } catch (err) {
        this.logger.warn(
          `session cache deleteBySessionId failed after revoke (tenant=${tenant}, session=${sessionId}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    await this.audit.emit({
      timestamp: new Date().toISOString(),
      event: 'authz.session.revoke',
      tenant,
      targetId: sessionId,
      result: 'success',
      attributes: {},
      correlationId: correlationStorage.getStore()?.correlationId,
    });
  }
}
