/**
 * Maps Hydra OAuth2 token payloads into library DTOs.
 *
 * Ory's token responses use snake_case and sometimes lowercase token types
 * ("bearer"); the library normalises them to camelCase and a `'Bearer'`
 * literal so downstream code is stable.
 */
import type {
  IntrospectedOAuth2Token as OryIntrospectedOAuth2Token,
  OAuth2TokenExchange as OryOAuth2TokenExchange,
} from '@ory/client';

import { deepFreeze } from '../freeze';
import type { IamMachinePrincipal } from '../principal';
import type { TenantName } from '../tenant';
import type { IamToken, IamTokenIntrospection } from '../token';

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
};
