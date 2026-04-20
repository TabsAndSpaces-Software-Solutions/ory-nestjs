/**
 * Hand-crafted @ory/client token payloads for mapper tests.
 */
import type {
  IntrospectedOAuth2Token as OryIntrospectedOAuth2Token,
  OAuth2TokenExchange as OryOAuth2TokenExchange,
} from '@ory/client';

export const oryTokenExchange: OryOAuth2TokenExchange = {
  access_token: 'tok-abc',
  token_type: 'bearer',
  expires_in: 3600,
  scope: 'read write',
};

export const oryTokenExchangeNoScope: OryOAuth2TokenExchange = {
  access_token: 'tok-xyz',
  token_type: 'Bearer',
  expires_in: 60,
};

export const oryIntrospectionActive: OryIntrospectedOAuth2Token = {
  active: true,
  sub: 'user:alice',
  client_id: 'client-1',
  scope: 'read write admin',
  exp: 1_700_000_000,
  iat: 1_600_000_000,
};

export const oryIntrospectionInactive: OryIntrospectedOAuth2Token = {
  active: false,
};
