/**
 * `OptionalSessionGuard` — same flow as `SessionGuard`, but missing
 * credentials are a legitimate state rather than an error.
 *
 * Behaviour differences vs. `SessionGuard`:
 *   - Transport returns `null` → set `req.user = null` and return true.
 *     No audit event is emitted for this case (missing credentials are
 *     part of the expected envelope of an optional-auth endpoint).
 *   - All other branches match `SessionGuard`: tenant-mismatch still emits
 *     `auth.tenant_mismatch` and throws, upstream 401/503 still surface
 *     through `ErrorMapper`.
 *
 * Zero-Ory-leakage: this file does not import `@ory/*`.
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
export class OptionalSessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(TENANT_REGISTRY) private readonly registry: TenantRegistry,
    @Inject(AUDIT_SINK) private readonly audit: AuditSink,
    private readonly transportFactory: TransportFactory,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const handler = ctx.getHandler();
    const controller = ctx.getClass();

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
      const tenantName =
        this.reflector.getAllAndOverride<TenantName | undefined>(TENANT_KEY, [
          handler,
          controller,
        ]) ?? this.registry.defaultTenant();
      if (tenantName === undefined) {
        throw new IamConfigurationError({
          message:
            'OptionalSessionGuard cannot resolve a tenant: no @Tenant() ' +
            'metadata and registry has no default tenant.',
          correlationId,
        });
      }
      const tenant = this.registry.get(tenantName);

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
      // Optional auth: no credential means "anonymous" — allow through.
      req.user = null;
      return true;
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

    await this.audit.emit({
      timestamp: new Date().toISOString(),
      event: 'auth.success',
      tenant: tenantName,
      actorId: result.identity.id,
      result: 'success',
      attributes: (() => {
        const attrs: Record<string, unknown> = {
          transport: tenant.config.transport,
          route,
          latencyMs: result.latencyMs,
        };
        if (result.fromCache !== undefined) {
          attrs.cacheHit = result.fromCache;
        }
        return attrs;
      })(),
      correlationId,
    });

    return true;
  }
}
