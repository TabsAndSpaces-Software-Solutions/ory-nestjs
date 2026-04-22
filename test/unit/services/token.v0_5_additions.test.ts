/**
 * Coverage for v0.5.0 TokenService additions: authorizationCode, refresh,
 * jwtBearer, revoke.
 */
import 'reflect-metadata';
import { ServiceUnavailableException } from '@nestjs/common';

import { TokenService } from '../../../src/services/token.service';
import { IamConfigurationError } from '../../../src/errors';
import type { TenantClients } from '../../../src/clients';
import { makeClients, makeRegistry, oryError } from './_helpers';

describe('TokenService v0.5.0 additions', () => {
  const adminApi = {
    oauth2TokenExchange: jest.fn(),
    introspectOAuth2Token: jest.fn(),
    revokeOAuth2Token: jest.fn(),
  };
  const publicApi = {
    oauth2TokenExchange: jest.fn(),
    introspectOAuth2Token: jest.fn(),
    revokeOAuth2Token: jest.fn(),
  };
  const registry = makeRegistry({
    default: makeClients({
      tenant: 'default',
      config: {
        hydra: { clientId: 'cid', clientSecret: 'csec' },
      } as unknown as TenantClients['config'],
      hydraOauth2: adminApi as unknown as TenantClients['hydraOauth2'],
      hydraOauth2Public: publicApi as unknown as TenantClients['hydraOauth2Public'],
    }),
    empty: makeClients({ tenant: 'empty' }),
  });
  const svc = new TokenService(registry);

  beforeEach(() => {
    Object.values(adminApi).forEach((m) => m.mockReset());
    Object.values(publicApi).forEach((m) => m.mockReset());
  });

  it('authorizationCode() sends PKCE verifier when supplied', async () => {
    publicApi.oauth2TokenExchange.mockResolvedValue({
      data: {
        access_token: 'at',
        expires_in: 3600,
        scope: 'read',
      },
    });
    const t = await svc.forTenant('default').authorizationCode({
      code: 'c',
      redirectUri: 'https://cb',
      clientId: 'pub',
      codeVerifier: 'v',
    });
    expect(t.accessToken).toBe('at');
    const call = publicApi.oauth2TokenExchange.mock.calls[0][0];
    expect(call.codeVerifier).toBe('v');
    expect(call.grantType).toBe('authorization_code');
  });

  it('refresh() uses publicApi with grantType=refresh_token', async () => {
    publicApi.oauth2TokenExchange.mockResolvedValue({
      data: { access_token: 'at', expires_in: 3600 },
    });
    await svc.forTenant('default').refresh({
      refreshToken: 'r1',
      scope: ['read'],
    });
    expect(publicApi.oauth2TokenExchange.mock.calls[0][0].grantType).toBe(
      'refresh_token',
    );
  });

  it('jwtBearer() forwards the assertion', async () => {
    publicApi.oauth2TokenExchange.mockResolvedValue({
      data: { access_token: 'at', expires_in: 3600 },
    });
    await svc.forTenant('default').jwtBearer({ assertion: 'jwt' });
    const call = publicApi.oauth2TokenExchange.mock.calls[0][0];
    expect(call.assertion).toBe('jwt');
    expect(call.grantType).toBe(
      'urn:ietf:params:oauth:grant-type:jwt-bearer',
    );
  });

  it('revoke() calls revokeOAuth2Token', async () => {
    publicApi.revokeOAuth2Token.mockResolvedValue({ data: null });
    await svc
      .forTenant('default')
      .revoke('tok', { tokenTypeHint: 'refresh_token' });
    const call = publicApi.revokeOAuth2Token.mock.calls[0][0];
    expect(call.token).toBe('tok');
    expect(call.tokenTypeHint).toBe('refresh_token');
  });

  it('revoke() propagates upstream 503', async () => {
    publicApi.revokeOAuth2Token.mockRejectedValue(oryError(503));
    await expect(
      svc.forTenant('default').revoke('tok'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('authorizationCode() throws IamConfigurationError without clientId', async () => {
    await expect(
      svc.forTenant('empty').authorizationCode({
        code: 'c',
        redirectUri: 'https://cb',
        clientId: '',
      }),
    ).rejects.toBeInstanceOf(IamConfigurationError);
  });
});
