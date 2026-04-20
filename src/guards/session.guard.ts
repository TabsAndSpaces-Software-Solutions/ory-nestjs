/**
 * `SessionGuard` — the library's default authentication gate.
 *
 * Contract (see spec unit `sgd`):
 *   - Short-circuit `true` when the route or its controller is marked with
 *     `@Public()` or `@Anonymous()`. The transport is NOT consulted.
 *   - Otherwise, resolve the expected tenant from `@Tenant()` metadata, or
 *     fall back to the registry's `defaultTenant()`. A missing / unknown
 *     tenant raises `IamConfigurationError` and surfaces as 500 via
 *     `ErrorMapper.toNest`.
 *   - Delegate all credential extraction to the tenant's configured
 *     `SessionTransport`. Guards MUST NOT touch raw cookies or headers
 *     except to read the correlation id.
 *   - Transport returns `null` → emit `auth.failure.missing_credential`,
 *     throw `IamUnauthorizedError`.
 *   - Transport returns a session stamped with a different tenant → emit
 *     `auth.tenant_mismatch`, throw `IamUnauthorizedError` (cross-tenant
 *     bleed is a 401 not a 403 — the caller never proved membership in
 *     the expected tenant).
 *   - Transport returns a matching session → attach `req.user` /
 *     `req.session`, emit `auth.success`, return true.
 *   - Every thrown error is funneled through `ErrorMapper.toNest(err)` so
 *     the HTTP boundary sees a proper Nest exception (401/403/500/503).
 *
 * Zero-Ory-leakage: this file does not import `@ory/*`. All Ory contact
 * lives below `src/transport/**` and `src/clients/**`.
 */
import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Reflector } from '@nestjs/core';

import { AUDIT_SINK, type AuditSink } from '../audit';
import { correlationStorage } from '../clients/correlation-storage';
import {
  IS_ANONYMOUS_KEY,
  IS_PUBLIC_KEY,
  TENANT_KEY,
} from '../decorators/metadata-keys';
import type { TenantName } from '../dto';
import {
  ErrorMapper,
  IamConfigurationError,
  IamUnauthorizedError,
} from '../errors';
import { TENANT_REGISTRY } from '../module/registry/tokens';
import type { TenantRegistry } from '../module/registry/tenant-registry.service';
import type { RequestLike } from '../transport';
import { TransportFactory } from '../transport/transport.factory';

/**
 * Mutable view of the HTTP request — SessionGuard writes `user` / `session`
 * on the success path. Using a narrow structural type avoids a hard
 * dependency on the Express `Request` so the library runs under any
 * NestJS adapter.
 */
interface MutableRequest extends RequestLike {
  user?: unknown;
  session?: unknown;
}

function readHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const v = headers[name];
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'string') {
    return v[0];
  }
  return undefined;
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(TENANT_REGISTRY) private readonly registry: TenantRegistry,
    @Inject(AUDIT_SINK) private readonly audit: AuditSink,
    private readonly transportFactory: TransportFactory,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const handler = ctx.getHandler();
    const controller = ctx.getClass();

    // 1. Public / Anonymous short-circuit.
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(
      IS_PUBLIC_KEY,
      [handler, controller],
    );
    if (isPublic === true) return true;
    const isAnonymous = this.reflector.getAllAndOverride<boolean | undefined>(
      IS_ANONYMOUS_KEY,
      [handler, controller],
    );
    if (isAnonymous === true) return true;

    const req = ctx.switchToHttp().getRequest<MutableRequest>();
    const correlationId =
      readHeader(req.headers, 'x-request-id') ??
      correlationStorage.getStore()?.correlationId ??
      randomUUID();

    try {
      // 2. Resolve tenant name.
      const tenantName =
        this.reflector.getAllAndOverride<TenantName | undefined>(TENANT_KEY, [
          handler,
          controller,
        ]) ?? this.registry.defaultTenant();
      if (tenantName === undefined) {
        throw new IamConfigurationError({
          message:
            'SessionGuard cannot resolve a tenant: no @Tenant() metadata and ' +
            'registry has no default tenant.',
          correlationId,
        });
      }

      // 3. Resolve tenant clients (throws IamConfigurationError on unknown).
      const tenant = this.registry.get(tenantName);

      // 4. Run the rest under a correlation context so downstream code
      //    (transports, interceptors) sees the same correlationId.
      return await correlationStorage.run({ correlationId }, () =>
        this.resolveAndAttach(ctx, req, tenant, tenantName, correlationId),
      );
    } catch (err) {
      throw ErrorMapper.toNest(err, { correlationId });
    }
  }

  private async resolveAndAttach(
    ctx: ExecutionContext,
    req: MutableRequest,
    tenant: ReturnType<TenantRegistry['get']>,
    tenantName: TenantName,
    correlationId: string,
  ): Promise<boolean> {
    const route = ctx.getHandler().name;
    const transport = this.transportFactory.forTenant(tenant.config);
    const result = await transport.resolve(
      req,
      tenant,
      tenantName,
      tenant.config,
    );

    if (result === null) {
      await this.audit.emit({
        timestamp: new Date().toISOString(),
        event: 'auth.failure.missing_credential',
        tenant: tenantName,
        result: 'failure',
        attributes: { route },
        correlationId,
      });
      throw new IamUnauthorizedError({
        message: 'missing credential',
        correlationId,
      });
    }

    if (result.session.tenant !== tenantName) {
      await this.audit.emit({
        timestamp: new Date().toISOString(),
        event: 'auth.tenant_mismatch',
        tenant: tenantName,
        result: 'failure',
        attributes: {
          presentedTenant: result.session.tenant,
          expectedTenant: tenantName,
          route,
        },
        correlationId,
      });
      throw new IamUnauthorizedError({
        message: 'tenant mismatch',
        correlationId,
      });
    }

    req.user = result.identity;
    req.session = result.session;

    const successAttributes: Record<string, unknown> = {
      transport: tenant.config.transport,
      route,
      latencyMs: result.latencyMs,
    };
    if (result.fromCache !== undefined) {
      successAttributes.cacheHit = result.fromCache;
    }
    await this.audit.emit({
      timestamp: new Date().toISOString(),
      event: 'auth.success',
      tenant: tenantName,
      actorId: result.identity.id,
      result: 'success',
      attributes: successAttributes,
      correlationId,
    });

    return true;
  }
}
