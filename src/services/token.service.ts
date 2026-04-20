/**
 * `TokenService` — tenant-scoped OAuth2 token issuance and introspection
 * via Ory Hydra.
 *
 * Spec unit: `tks`.
 *
 * Design invariants:
 *   - Zero `@ory/*` imports in this file. The tenant's `hydraOauth2` client
 *     is typed as `OAuth2Api` in `TenantClients` but we access it via a
 *     structurally-typed any-cast for the two methods we call
 *     (`oauth2TokenExchange`, `introspectOAuth2Token`) so the Ory request-shape
 *     types never cross this boundary. This also isolates us from upstream
 *     signature churn in the Ory SDK (the tokenExchange request parameters
 *     object isn't typed to include the `clientSecret`/`scope` fields we
 *     need for a pure client-credentials call).
 *   - `.forTenant(name)` returns a memoized `TokenServiceFor` instance per
 *     tenant for the lifetime of the service.
 *   - Mapping to library DTOs is done via `tokenMapper`; the mapper enforces
 *     the public surface shape (`IamToken`, `IamTokenIntrospection`).
 *   - Upstream failures are funneled through `ErrorMapper.toNest` so axios
 *     5xx maps to `ServiceUnavailableException`, axios 401 to
 *     `UnauthorizedException`, etc.
 *   - An inactive introspection (`active: false`) is a NORMAL return value,
 *     NOT an error. The caller decides what "inactive" means.
 *   - `clientCredentials` requires the tenant's hydra config to carry BOTH
 *     `clientId` and `clientSecret`; absence is a loud `IamConfigurationError`.
 *     Both methods also require a `hydraOauth2` client to be present on the
 *     `TenantClients` bundle.
 */
import { Inject, Injectable } from '@nestjs/common';

import type { TenantClients } from '../clients';
import type {
  TenantName,
  IamToken,
  IamTokenIntrospection,
} from '../dto';
import { tokenMapper } from '../dto/mappers';
import { ErrorMapper, IamConfigurationError } from '../errors';
import { TENANT_REGISTRY } from '../module/registry/tokens';
import type { TenantRegistry } from '../module/registry/tenant-registry.service';

/**
 * Tenant-scoped projection of `TokenService`. Returned by
 * `TokenService.forTenant(name)` and memoized per tenant.
 */
export interface TokenServiceFor {
  /**
   * Request an OAuth2 access token via the client-credentials grant, using
   * the tenant's configured `hydra.clientId` / `hydra.clientSecret`.
   *
   * Throws `IamConfigurationError` when the tenant bundle lacks a Hydra
   * OAuth2 client or its hydra config lacks client credentials.
   */
  clientCredentials(scope: string[]): Promise<IamToken>;

  /**
   * Introspect a token via Hydra's admin introspection endpoint. Returns a
   * `IamTokenIntrospection` DTO; an `active: false` response is a normal
   * return and is NOT translated into an error.
   *
   * Throws `IamConfigurationError` when the tenant bundle lacks a Hydra
   * OAuth2 client.
   */
  introspect(token: string): Promise<IamTokenIntrospection>;
}

/**
 * Structural views of the two OAuth2Api methods we call. We intentionally do
 * NOT import the Ory request-parameter types for these operations; the Ory
 * request shape for `oauth2TokenExchange` does not even carry a
 * `clientSecret` / `scope` field despite Hydra accepting them, so we call the
 * typed method via a looser structural contract.
 */
interface HydraOAuth2Like {
  oauth2TokenExchange(req: unknown): Promise<{ data: unknown }>;
  introspectOAuth2Token(req: unknown): Promise<{ data: unknown }>;
}

@Injectable()
export class TokenService {
  private readonly byTenant = new Map<TenantName, TokenServiceFor>();

  constructor(
    @Inject(TENANT_REGISTRY) private readonly registry: TenantRegistry,
  ) {}

  /**
   * Return (and memoize) the tenant-scoped wrapper. Reference-stable across
   * calls — subsequent `forTenant(name)` invocations return the exact same
   * instance.
   */
  public forTenant(name: TenantName): TokenServiceFor {
    const existing = this.byTenant.get(name);
    if (existing !== undefined) return existing;

    const registry = this.registry;
    const wrapper: TokenServiceFor = {
      clientCredentials: (scope) => clientCredentialsImpl(registry, name, scope),
      introspect: (token) => introspectImpl(registry, name, token),
    };
    this.byTenant.set(name, wrapper);
    return wrapper;
  }
}

// ---------- implementations ----------

async function clientCredentialsImpl(
  registry: TenantRegistry,
  tenant: TenantName,
  scope: string[],
): Promise<IamToken> {
  const clients = registry.get(tenant);
  const hydra = requireHydra(clients, tenant);

  const hydraCfg = clients.config.hydra;
  const clientId = hydraCfg?.clientId;
  const clientSecret = hydraCfg?.clientSecret;
  if (
    typeof clientId !== 'string' ||
    clientId.length === 0 ||
    typeof clientSecret !== 'string' ||
    clientSecret.length === 0
  ) {
    throw new IamConfigurationError({
      message:
        `hydra client credentials not configured for tenant '${tenant}'. ` +
        'Declare tenants.<name>.hydra.clientId and hydra.clientSecret.',
    });
  }

  try {
    const { data } = await hydra.oauth2TokenExchange({
      grantType: 'client_credentials',
      clientId,
      clientSecret,
      scope: scope.join(' '),
    });
    return tokenMapper.fromOryTokenExchange(
      data as Parameters<typeof tokenMapper.fromOryTokenExchange>[0],
      tenant,
    );
  } catch (err) {
    throw ErrorMapper.toNest(err);
  }
}

async function introspectImpl(
  registry: TenantRegistry,
  tenant: TenantName,
  token: string,
): Promise<IamTokenIntrospection> {
  const clients = registry.get(tenant);
  const hydra = requireHydra(clients, tenant);

  try {
    const { data } = await hydra.introspectOAuth2Token({ token });
    return tokenMapper.fromOryIntrospection(
      data as Parameters<typeof tokenMapper.fromOryIntrospection>[0],
      tenant,
    );
  } catch (err) {
    throw ErrorMapper.toNest(err);
  }
}

/** Resolve the tenant's Hydra OAuth2 client or throw IamConfigurationError. */
function requireHydra(
  clients: TenantClients,
  tenant: TenantName,
): HydraOAuth2Like {
  if (!clients.hydraOauth2) {
    throw new IamConfigurationError({
      message: `hydra OAuth2 client not configured for tenant '${tenant}'`,
    });
  }
  return clients.hydraOauth2 as unknown as HydraOAuth2Like;
}
