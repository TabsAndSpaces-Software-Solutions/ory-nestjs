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
export interface IamAuthorizationCodeInput {
  readonly code: string;
  readonly redirectUri: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly codeVerifier?: string;
}

export interface IamRefreshTokenInput {
  readonly refreshToken: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly scope?: readonly string[];
}

export interface IamJwtBearerInput {
  readonly assertion: string;
  readonly scope?: readonly string[];
  readonly clientId?: string;
  readonly clientSecret?: string;
}

export type IamRevokeTokenType = 'access_token' | 'refresh_token';

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

  /**
   * Exchange an authorization_code for an access token (RFC 6749 §4.1.3).
   * PKCE is supported via `codeVerifier`; public clients omit
   * `clientSecret`.
   */
  authorizationCode(input: IamAuthorizationCodeInput): Promise<IamToken>;

  /** Exchange a refresh_token for a new access token (RFC 6749 §6). */
  refresh(input: IamRefreshTokenInput): Promise<IamToken>;

  /**
   * Exchange a signed JWT assertion for an access token (RFC 7523
   * urn:ietf:params:oauth:grant-type:jwt-bearer).
   */
  jwtBearer(input: IamJwtBearerInput): Promise<IamToken>;

  /**
   * Revoke an access or refresh token (RFC 7009). Requires the client's
   * credentials — same OAuth2 client that issued the token.
   */
  revoke(
    token: string,
    opts?: {
      tokenTypeHint?: IamRevokeTokenType;
      clientId?: string;
      clientSecret?: string;
    },
  ): Promise<void>;
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
  revokeOAuth2Token?(req: unknown): Promise<{ data: unknown }>;
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
      authorizationCode: (input) => authorizationCodeImpl(registry, name, input),
      refresh: (input) => refreshImpl(registry, name, input),
      jwtBearer: (input) => jwtBearerImpl(registry, name, input),
      revoke: (token, opts) => revokeImpl(registry, name, token, opts ?? {}),
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

/** Resolve the tenant's Hydra admin OAuth2 client or throw. */
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

/**
 * Resolve the tenant's Hydra PUBLIC OAuth2 client (token exchange, revoke).
 * Falls back to the admin-bound client if a public one isn't wired — the
 * admin port typically also serves token endpoints on self-hosted Hydra.
 */
function requireHydraPublic(
  clients: TenantClients,
  tenant: TenantName,
): HydraOAuth2Like {
  if (clients.hydraOauth2Public) {
    return clients.hydraOauth2Public as unknown as HydraOAuth2Like;
  }
  if (clients.hydraOauth2) {
    return clients.hydraOauth2 as unknown as HydraOAuth2Like;
  }
  throw new IamConfigurationError({
    message: `hydra OAuth2 client not configured for tenant '${tenant}'`,
  });
}

async function authorizationCodeImpl(
  registry: TenantRegistry,
  tenant: TenantName,
  input: IamAuthorizationCodeInput,
): Promise<IamToken> {
  const clients = registry.get(tenant);
  const hydra = requireHydraPublic(clients, tenant);
  const cfg = clients.config.hydra;
  const clientId = input.clientId ?? cfg?.clientId ?? '';
  const clientSecret = input.clientSecret ?? cfg?.clientSecret;
  if (clientId.length === 0) {
    throw new IamConfigurationError({
      message: `authorization_code grant requires clientId (input or config)`,
    });
  }
  try {
    const req: Record<string, unknown> = {
      grantType: 'authorization_code',
      code: input.code,
      redirectUri: input.redirectUri,
      clientId,
    };
    if (clientSecret !== undefined) req.clientSecret = clientSecret;
    if (input.codeVerifier !== undefined) req.codeVerifier = input.codeVerifier;
    const { data } = await hydra.oauth2TokenExchange(req);
    return tokenMapper.fromOryTokenExchange(
      data as Parameters<typeof tokenMapper.fromOryTokenExchange>[0],
      tenant,
    );
  } catch (err) {
    throw ErrorMapper.toNest(err);
  }
}

async function refreshImpl(
  registry: TenantRegistry,
  tenant: TenantName,
  input: IamRefreshTokenInput,
): Promise<IamToken> {
  const clients = registry.get(tenant);
  const hydra = requireHydraPublic(clients, tenant);
  const cfg = clients.config.hydra;
  const clientId = input.clientId ?? cfg?.clientId ?? '';
  const clientSecret = input.clientSecret ?? cfg?.clientSecret;
  if (clientId.length === 0) {
    throw new IamConfigurationError({
      message: `refresh_token grant requires clientId (input or config)`,
    });
  }
  try {
    const req: Record<string, unknown> = {
      grantType: 'refresh_token',
      refreshToken: input.refreshToken,
      clientId,
    };
    if (clientSecret !== undefined) req.clientSecret = clientSecret;
    if (input.scope !== undefined) req.scope = input.scope.join(' ');
    const { data } = await hydra.oauth2TokenExchange(req);
    return tokenMapper.fromOryTokenExchange(
      data as Parameters<typeof tokenMapper.fromOryTokenExchange>[0],
      tenant,
    );
  } catch (err) {
    throw ErrorMapper.toNest(err);
  }
}

async function jwtBearerImpl(
  registry: TenantRegistry,
  tenant: TenantName,
  input: IamJwtBearerInput,
): Promise<IamToken> {
  const clients = registry.get(tenant);
  const hydra = requireHydraPublic(clients, tenant);
  const cfg = clients.config.hydra;
  try {
    const req: Record<string, unknown> = {
      grantType: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: input.assertion,
    };
    const clientId = input.clientId ?? cfg?.clientId;
    const clientSecret = input.clientSecret ?? cfg?.clientSecret;
    if (clientId !== undefined) req.clientId = clientId;
    if (clientSecret !== undefined) req.clientSecret = clientSecret;
    if (input.scope !== undefined) req.scope = input.scope.join(' ');
    const { data } = await hydra.oauth2TokenExchange(req);
    return tokenMapper.fromOryTokenExchange(
      data as Parameters<typeof tokenMapper.fromOryTokenExchange>[0],
      tenant,
    );
  } catch (err) {
    throw ErrorMapper.toNest(err);
  }
}

async function revokeImpl(
  registry: TenantRegistry,
  tenant: TenantName,
  token: string,
  opts: {
    tokenTypeHint?: IamRevokeTokenType;
    clientId?: string;
    clientSecret?: string;
  },
): Promise<void> {
  const clients = registry.get(tenant);
  const hydra = requireHydraPublic(clients, tenant);
  const cfg = clients.config.hydra;
  if (typeof hydra.revokeOAuth2Token !== 'function') {
    throw new IamConfigurationError({
      message: `hydra SDK does not expose revokeOAuth2Token — upgrade @ory/client`,
    });
  }
  try {
    const req: Record<string, unknown> = { token };
    const clientId = opts.clientId ?? cfg?.clientId;
    const clientSecret = opts.clientSecret ?? cfg?.clientSecret;
    if (clientId !== undefined) req.clientId = clientId;
    if (clientSecret !== undefined) req.clientSecret = clientSecret;
    if (opts.tokenTypeHint !== undefined) req.tokenTypeHint = opts.tokenTypeHint;
    await hydra.revokeOAuth2Token(req);
  } catch (err) {
    throw ErrorMapper.toNest(err);
  }
}
