/**
 * `OAuth2Guard` — authenticates machine callers via Hydra-issued bearer
 * tokens.
 *
 * Contract (see spec unit `ogd`):
 *   - Extract the bearer token from `Authorization: Bearer <token>`. If the
 *     header is absent or does not begin with `Bearer `, throw
 *     `IamUnauthorizedError` → 401.
 *   - Resolve the route's tenant (`@Tenant()` metadata, else the registry's
 *     `defaultTenant()`). Missing tenant → `IamConfigurationError` → 500.
 *   - Fetch the tenant's `hydraOauth2` client. If the tenant has no Hydra
 *     configured, raise `IamConfigurationError` → 500.
 *   - Call `hydraOauth2.introspectOAuth2Token({ token })`.
 *     - `active === false` → emit `auth.failure.token_inactive`, throw
 *       `IamUnauthorizedError` (401).
 *     - Active → attach a `IamMachinePrincipal` to `req.user` with
 *       `{ kind: 'machine', clientId, scope: scope.split(' '), tenant }` and
 *       emit `auth.success` with `transport: 'oauth2'`.
 *   - Every thrown error is funneled through `ErrorMapper.toNest(err)` so
 *     Axios-shaped 5xx from Hydra become `ServiceUnavailableException` (503).
 *
 * Bearer-only — this guard never reads cookies. A separate `SessionGuard`
 * handles cookie-based human sessions.
 *
 * Zero-Ory-leakage: this file never imports `@ory/*`. It treats
 * `hydraOauth2.introspectOAuth2Token` purely structurally.
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
import { TENANT_KEY } from '../decorators/metadata-keys';
import type { TenantName, IamMachinePrincipal } from '../dto';
import {
  ErrorMapper,
  IamConfigurationError,
  IamUnauthorizedError,
} from '../errors';
import { TENANT_REGISTRY } from '../module/registry/tokens';
import type { TenantRegistry } from '../module/registry/tenant-registry.service';

interface MutableRequest {
  headers: Record<string, string | string[] | undefined>;
  user?: unknown;
}

interface IntrospectResponseData {
  active: boolean;
  sub?: string;
  client_id?: string;
  scope?: string;
  exp?: number;
  iat?: number;
}

/**
 * Structural shape we need from the Hydra `OAuth2Api`. Keeping this local
 * avoids a direct `@ory/client` import from a guard file.
 */
interface HydraOAuth2Like {
  introspectOAuth2Token(args: {
    token: string;
    scope?: string;
  }): Promise<{ data: IntrospectResponseData }>;
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

function extractBearer(
  headers: Record<string, string | string[] | undefined>,
  correlationId: string,
): string {
  const raw = readHeader(headers, 'authorization');
  if (raw === undefined) {
    throw new IamUnauthorizedError({
      message: 'missing Authorization header',
      correlationId,
    });
  }
  if (!raw.startsWith('Bearer ')) {
    throw new IamUnauthorizedError({
      message: 'Authorization scheme must be Bearer',
      correlationId,
    });
  }
  const token = raw.slice('Bearer '.length).trim();
  if (token.length === 0) {
    throw new IamUnauthorizedError({
      message: 'empty bearer token',
      correlationId,
    });
  }
  return token;
}

@Injectable()
export class OAuth2Guard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(TENANT_REGISTRY) private readonly registry: TenantRegistry,
    @Inject(AUDIT_SINK) private readonly audit: AuditSink,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const handler = ctx.getHandler();
    const controller = ctx.getClass();
    const req = ctx.switchToHttp().getRequest<MutableRequest>();

    const correlationId =
      readHeader(req.headers, 'x-request-id') ??
      correlationStorage.getStore()?.correlationId ??
      randomUUID();

    try {
      // 1. Extract the bearer token — missing/malformed fails before we
      //    touch any tenant state.
      const token = extractBearer(req.headers, correlationId);

      // 2. Resolve the expected tenant.
      const tenantName =
        this.reflector.getAllAndOverride<TenantName | undefined>(TENANT_KEY, [
          handler,
          controller,
        ]) ?? this.registry.defaultTenant();
      if (tenantName === undefined) {
        throw new IamConfigurationError({
          message:
            'OAuth2Guard cannot resolve a tenant: no @Tenant() metadata ' +
            'and registry has no default tenant.',
          correlationId,
        });
      }

      // 3. Resolve tenant clients and Hydra.
      const tenant = this.registry.get(tenantName);
      const hydra = tenant.hydraOauth2 as HydraOAuth2Like | undefined;
      if (hydra === undefined) {
        throw new IamConfigurationError({
          message: `Tenant '${tenantName}' has no Hydra OAuth2 client configured.`,
          correlationId,
        });
      }

      // 4. Run introspection and downstream work under a correlation
      //    context so any downstream interceptors see the same id.
      return await correlationStorage.run({ correlationId }, () =>
        this.introspectAndAttach(
          ctx,
          req,
          hydra,
          token,
          tenantName,
          correlationId,
        ),
      );
    } catch (err) {
      throw ErrorMapper.toNest(err, { correlationId });
    }
  }

  private async introspectAndAttach(
    ctx: ExecutionContext,
    req: MutableRequest,
    hydra: HydraOAuth2Like,
    token: string,
    tenantName: TenantName,
    correlationId: string,
  ): Promise<boolean> {
    const route = ctx.getHandler().name;
    const response = await hydra.introspectOAuth2Token({ token });
    const data = response.data;

    if (data.active === false) {
      await this.audit.emit({
        timestamp: new Date().toISOString(),
        event: 'auth.failure.token_inactive',
        tenant: tenantName,
        result: 'failure',
        attributes: { route },
        correlationId,
      });
      throw new IamUnauthorizedError({
        message: 'token inactive',
        correlationId,
      });
    }

    const clientId = data.client_id ?? data.sub ?? '';
    const scope =
      typeof data.scope === 'string' && data.scope.length > 0
        ? data.scope.split(' ')
        : [];

    const principal: IamMachinePrincipal = {
      kind: 'machine',
      clientId,
      scope,
      tenant: tenantName,
    };

    req.user = principal;

    await this.audit.emit({
      timestamp: new Date().toISOString(),
      event: 'auth.success',
      tenant: tenantName,
      actorId: clientId,
      result: 'success',
      attributes: {
        transport: 'oauth2',
        route,
      },
      correlationId,
    });

    return true;
  }
}
