/**
 * Maps Hydra OAuth2 token payloads into library DTOs.
 *
 * Ory's token responses use snake_case and sometimes lowercase token types
 * ("bearer"); the library normalises them to camelCase and a `'Bearer'`
 * literal so downstream code is stable.
 */
import type {
  IntrospectedOAuth2Token as OryIntrospectedOAuth2Token,
  JsonWebKey as OryJsonWebKey,
  JsonWebKeySet as OryJsonWebKeySet,
  OAuth2Client as OryOAuth2Client,
  OAuth2ConsentRequest as OryOAuth2ConsentRequest,
  OAuth2LoginRequest as OryOAuth2LoginRequest,
  OAuth2LogoutRequest as OryOAuth2LogoutRequest,
  OAuth2TokenExchange as OryOAuth2TokenExchange,
  TrustedOAuth2JwtGrantIssuer as OryTrustedIssuer,
} from '@ory/client';

import { deepFreeze } from '../freeze';
import type { IamMachinePrincipal } from '../principal';
import type { TenantName } from '../tenant';
import type {
  IamConsentRequest,
  IamJsonWebKey,
  IamJsonWebKeySet,
  IamLoginRequest,
  IamLogoutRequest,
  IamOAuth2Client,
  IamToken,
  IamTokenIntrospection,
  IamTrustedIssuer,
} from '../token';

function splitScope(s: string | undefined): string[] {
  if (typeof s !== 'string' || s.length === 0) return [];
  return s.split(/\s+/).filter((part) => part.length > 0);
}

export const tokenMapper = {
  fromOryTokenExchange(
    t: OryOAuth2TokenExchange,
    tenant: TenantName,
  ): IamToken {
    const dto: IamToken = {
      accessToken: t.access_token ?? '',
      tokenType: 'Bearer',
      expiresIn: typeof t.expires_in === 'number' ? t.expires_in : 0,
      scope: splitScope(t.scope),
      tenant,
    };
    return deepFreeze(dto);
  },

  fromOryIntrospection(
    i: OryIntrospectedOAuth2Token,
    tenant: TenantName,
  ): IamTokenIntrospection {
    const dto: {
      -readonly [K in keyof IamTokenIntrospection]: IamTokenIntrospection[K];
    } = {
      active: i.active === true,
      tenant,
    };
    if (typeof i.sub === 'string') dto.subject = i.sub;
    if (typeof i.client_id === 'string') dto.clientId = i.client_id;
    if (typeof i.scope === 'string' && i.scope.length > 0) {
      dto.scope = splitScope(i.scope);
    }
    if (typeof i.exp === 'number') dto.exp = i.exp;
    if (typeof i.iat === 'number') dto.iat = i.iat;
    return deepFreeze(dto as IamTokenIntrospection);
  },

  /**
   * Convenience: turn an active introspection with a client_id into a
   * IamMachinePrincipal. Returns null if the token is not active or lacks
   * a client_id.
   */
  machineFromOryIntrospection(
    i: OryIntrospectedOAuth2Token,
    tenant: TenantName,
  ): IamMachinePrincipal | null {
    if (i.active !== true) return null;
    if (typeof i.client_id !== 'string' || i.client_id.length === 0) return null;
    const principal: IamMachinePrincipal = {
      kind: 'machine',
      clientId: i.client_id,
      scope: splitScope(i.scope),
      tenant,
    };
    return deepFreeze(principal);
  },

  clientFromOry(c: OryOAuth2Client, tenant: TenantName): IamOAuth2Client {
    const dto: IamOAuth2Client = {
      clientId: c.client_id ?? '',
      clientName: c.client_name,
      grantTypes: Array.isArray(c.grant_types) ? [...c.grant_types] : [],
      responseTypes: Array.isArray(c.response_types)
        ? [...c.response_types]
        : [],
      redirectUris: Array.isArray(c.redirect_uris) ? [...c.redirect_uris] : [],
      scope: typeof c.scope === 'string' ? c.scope : '',
      audience: Array.isArray(c.audience) ? [...c.audience] : [],
      tokenEndpointAuthMethod:
        typeof c.token_endpoint_auth_method === 'string'
          ? c.token_endpoint_auth_method
          : 'client_secret_basic',
      clientSecret: typeof c.client_secret === 'string' ? c.client_secret : undefined,
      clientSecretExpiresAt:
        typeof c.client_secret_expires_at === 'number'
          ? c.client_secret_expires_at
          : undefined,
      contacts: Array.isArray(c.contacts) ? [...c.contacts] : [],
      clientUri: typeof c.client_uri === 'string' ? c.client_uri : undefined,
      policyUri: typeof c.policy_uri === 'string' ? c.policy_uri : undefined,
      tosUri: typeof c.tos_uri === 'string' ? c.tos_uri : undefined,
      logoUri: typeof c.logo_uri === 'string' ? c.logo_uri : undefined,
      metadata:
        (c.metadata as Record<string, unknown> | undefined) ?? undefined,
      createdAt: typeof c.created_at === 'string' ? c.created_at : undefined,
      updatedAt: typeof c.updated_at === 'string' ? c.updated_at : undefined,
      tenant,
    };
    return deepFreeze(dto);
  },

  loginRequestFromOry(
    r: OryOAuth2LoginRequest,
    tenant: TenantName,
  ): IamLoginRequest {
    return deepFreeze({
      challenge: r.challenge ?? '',
      skip: r.skip === true,
      subject: r.subject ?? '',
      clientId: r.client?.client_id ?? '',
      requestedScope: Array.isArray(r.requested_scope)
        ? [...r.requested_scope]
        : [],
      requestedAudience: Array.isArray(r.requested_access_token_audience)
        ? [...r.requested_access_token_audience]
        : [],
      requestUrl: r.request_url ?? '',
      tenant,
    });
  },

  consentRequestFromOry(
    r: OryOAuth2ConsentRequest,
    tenant: TenantName,
  ): IamConsentRequest {
    return deepFreeze({
      challenge: r.challenge ?? '',
      skip: r.skip === true,
      subject: r.subject ?? '',
      clientId: r.client?.client_id ?? '',
      requestedScope: Array.isArray(r.requested_scope)
        ? [...r.requested_scope]
        : [],
      requestedAudience: Array.isArray(r.requested_access_token_audience)
        ? [...r.requested_access_token_audience]
        : [],
      requestUrl: r.request_url ?? '',
      tenant,
    });
  },

  logoutRequestFromOry(
    r: OryOAuth2LogoutRequest,
    tenant: TenantName,
  ): IamLogoutRequest {
    return deepFreeze({
      challenge: (r as unknown as { challenge?: string }).challenge ?? '',
      subject: r.subject ?? '',
      sid: r.sid ?? '',
      clientId: r.client?.client_id,
      rpInitiated: r.rp_initiated === true,
      tenant,
    });
  },

  jwkFromOry(k: OryJsonWebKey): IamJsonWebKey {
    const anyK = k as unknown as Record<string, unknown>;
    return deepFreeze({
      ...anyK,
      kid: typeof anyK.kid === 'string' ? anyK.kid : '',
      kty: typeof anyK.kty === 'string' ? anyK.kty : '',
      use: typeof anyK.use === 'string' ? anyK.use : undefined,
      alg: typeof anyK.alg === 'string' ? anyK.alg : undefined,
    }) as IamJsonWebKey;
  },

  jwksFromOry(set: OryJsonWebKeySet, tenant: TenantName): IamJsonWebKeySet {
    const list = Array.isArray(set.keys) ? set.keys : [];
    return deepFreeze({
      keys: list.map((k) => this.jwkFromOry(k)),
      tenant,
    });
  },

  trustedIssuerFromOry(
    i: OryTrustedIssuer,
    tenant: TenantName,
  ): IamTrustedIssuer {
    return deepFreeze({
      id: i.id ?? '',
      issuer: i.issuer ?? '',
      subject: i.subject,
      scope: Array.isArray(i.scope) ? [...i.scope] : [],
      expiresAt: i.expires_at ?? '',
      publicKey: i.public_key
        ? this.jwkFromOry(i.public_key as unknown as OryJsonWebKey)
        : ({ kid: '', kty: '' } as IamJsonWebKey),
      createdAt: typeof i.created_at === 'string' ? i.created_at : undefined,
      tenant,
    });
  },
};
