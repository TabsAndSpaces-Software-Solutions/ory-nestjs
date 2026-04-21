/**
 * Library-owned OAuth2 token DTOs.
 *
 * Zero-Ory-leakage contract: this file MUST NOT import from `@ory/*`.
 */
import type { TenantName } from './tenant';

export interface IamToken {
  readonly accessToken: string;
  readonly tokenType: 'Bearer';
  /** Seconds until the access token expires. */
  readonly expiresIn: number;
  readonly scope: readonly string[];
  readonly tenant: TenantName;
}

export interface IamTokenIntrospection {
  readonly active: boolean;
  readonly subject?: string;
  readonly clientId?: string;
  readonly scope?: readonly string[];
  /** Epoch seconds. */
  readonly exp?: number;
  /** Epoch seconds. */
  readonly iat?: number;
  readonly tenant: TenantName;
}

/**
 * Full OAuth2 client descriptor as returned by Hydra's admin client CRUD.
 * Fields mirror RFC 7591 + Hydra extensions, renamed to camelCase. `secret`
 * is present only when the client was created with
 * `token_endpoint_auth_method` requiring one AND the secret is actually
 * returned by Hydra — rotate via `patchClient` if it ever leaks.
 */
export interface IamOAuth2Client {
  readonly clientId: string;
  readonly clientName?: string;
  readonly grantTypes: readonly string[];
  readonly responseTypes: readonly string[];
  readonly redirectUris: readonly string[];
  readonly scope: string;
  readonly audience: readonly string[];
  readonly tokenEndpointAuthMethod: string;
  readonly clientSecret?: string;
  readonly clientSecretExpiresAt?: number;
  readonly contacts: readonly string[];
  readonly clientUri?: string;
  readonly policyUri?: string;
  readonly tosUri?: string;
  readonly logoUri?: string;
  readonly metadata?: Record<string, unknown>;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly tenant: TenantName;
}

/** Input for `OAuth2ClientService.create` / `set`. */
export interface IamOAuth2ClientInput {
  readonly clientName?: string;
  readonly grantTypes?: readonly string[];
  readonly responseTypes?: readonly string[];
  readonly redirectUris?: readonly string[];
  readonly scope?: string;
  readonly audience?: readonly string[];
  readonly tokenEndpointAuthMethod?: string;
  readonly clientSecret?: string;
  readonly contacts?: readonly string[];
  readonly clientUri?: string;
  readonly policyUri?: string;
  readonly tosUri?: string;
  readonly logoUri?: string;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Hydra login/consent challenges. These envelopes mediate between a Hydra
 * OAuth2 authorization flow and the BFF UI that collects user consent.
 */
export interface IamLoginRequest {
  readonly challenge: string;
  readonly skip: boolean;
  readonly subject: string;
  readonly clientId: string;
  readonly requestedScope: readonly string[];
  readonly requestedAudience: readonly string[];
  readonly requestUrl: string;
  readonly tenant: TenantName;
}

export interface IamConsentRequest {
  readonly challenge: string;
  readonly skip: boolean;
  readonly subject: string;
  readonly clientId: string;
  readonly requestedScope: readonly string[];
  readonly requestedAudience: readonly string[];
  readonly requestUrl: string;
  readonly tenant: TenantName;
}

export interface IamLogoutRequest {
  readonly challenge: string;
  readonly subject: string;
  readonly sid: string;
  readonly clientId?: string;
  readonly rpInitiated: boolean;
  readonly tenant: TenantName;
}

/** Result from `accept*` / `reject*` — Hydra returns a redirect URL. */
export interface IamConsentRedirect {
  readonly redirectTo: string;
}

/** JSON Web Key (JWK) as used by Hydra's JWK admin API. */
export interface IamJsonWebKey {
  readonly kid: string;
  readonly kty: string;
  readonly use?: string;
  readonly alg?: string;
  readonly [key: string]: unknown;
}

export interface IamJsonWebKeySet {
  readonly keys: readonly IamJsonWebKey[];
  readonly tenant: TenantName;
}

/** Trusted issuer for the JWT-bearer grant type. */
export interface IamTrustedIssuer {
  readonly id: string;
  readonly issuer: string;
  readonly subject?: string;
  readonly scope: readonly string[];
  readonly expiresAt: string;
  readonly publicKey: IamJsonWebKey;
  readonly createdAt?: string;
  readonly tenant: TenantName;
}
