import 'reflect-metadata';
import { ServiceUnavailableException } from '@nestjs/common';

import { ConsentService } from '../../../src/services/consent.service';
import { IamConfigurationError } from '../../../src/errors';
import type { TenantClients } from '../../../src/clients';
import { makeClients, makeRegistry, oryError } from './_helpers';

describe('ConsentService', () => {
  const api = {
    getOAuth2LoginRequest: jest.fn(),
    acceptOAuth2LoginRequest: jest.fn(),
    rejectOAuth2LoginRequest: jest.fn(),
    getOAuth2ConsentRequest: jest.fn(),
    acceptOAuth2ConsentRequest: jest.fn(),
    rejectOAuth2ConsentRequest: jest.fn(),
    getOAuth2LogoutRequest: jest.fn(),
    acceptOAuth2LogoutRequest: jest.fn(),
    rejectOAuth2LogoutRequest: jest.fn(),
  };
  const registry = makeRegistry({
    default: makeClients({
      tenant: 'default',
      hydraOauth2: api as unknown as TenantClients['hydraOauth2'],
    }),
    empty: makeClients({ tenant: 'empty' }),
  });
  const svc = new ConsentService(registry);

  beforeEach(() => {
    Object.values(api).forEach((m) => m.mockReset());
  });

  it('getLoginRequest maps Hydra envelope to camelCase DTO', async () => {
    api.getOAuth2LoginRequest.mockResolvedValue({
      data: {
        challenge: 'ch1',
        skip: false,
        subject: 'sub1',
        client: { client_id: 'cid' },
        requested_scope: ['read'],
        requested_access_token_audience: [],
        request_url: 'https://x',
      },
    });
    const req = await svc.forTenant('default').getLoginRequest('ch1');
    expect(req.challenge).toBe('ch1');
    expect(req.clientId).toBe('cid');
    expect(req.requestedScope).toEqual(['read']);
  });

  it('acceptConsentRequest maps redirect_to', async () => {
    api.acceptOAuth2ConsentRequest.mockResolvedValue({
      data: { redirect_to: 'https://cb?code=…' },
    });
    const res = await svc.forTenant('default').acceptConsentRequest('ch', {
      grantScope: ['read'],
    });
    expect(res.redirectTo).toContain('https://cb');
  });

  it('propagates upstream 503 through ErrorMapper', async () => {
    api.getOAuth2ConsentRequest.mockRejectedValue(oryError(503));
    await expect(
      svc.forTenant('default').getConsentRequest('ch'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('throws IamConfigurationError when Hydra admin is absent', async () => {
    await expect(
      svc.forTenant('empty').getLoginRequest('ch'),
    ).rejects.toBeInstanceOf(IamConfigurationError);
  });

  it('acceptLoginRequest forwards payload', async () => {
    api.acceptOAuth2LoginRequest.mockResolvedValue({
      data: { redirect_to: 'https://cb' },
    });
    const out = await svc.forTenant('default').acceptLoginRequest('ch', {
      subject: 'sub',
      remember: true,
      rememberFor: 60,
    });
    expect(out.redirectTo).toBe('https://cb');
  });

  it('rejectLoginRequest maps RFC-6749 error body', async () => {
    api.rejectOAuth2LoginRequest.mockResolvedValue({
      data: { redirect_to: 'https://cb' },
    });
    const out = await svc.forTenant('default').rejectLoginRequest('ch', {
      error: 'access_denied',
      errorDescription: 'no',
    });
    expect(out.redirectTo).toBe('https://cb');
  });

  it('rejectConsentRequest works', async () => {
    api.rejectOAuth2ConsentRequest.mockResolvedValue({
      data: { redirect_to: 'https://cb' },
    });
    const out = await svc.forTenant('default').rejectConsentRequest('ch', {
      error: 'access_denied',
    });
    expect(out.redirectTo).toBe('https://cb');
  });

  it('getLogoutRequest + acceptLogoutRequest + rejectLogoutRequest', async () => {
    api.getOAuth2LogoutRequest.mockResolvedValue({
      data: { subject: 'sub', sid: 'sid1', rp_initiated: true },
    });
    api.acceptOAuth2LogoutRequest.mockResolvedValue({
      data: { redirect_to: 'https://cb' },
    });
    api.rejectOAuth2LogoutRequest.mockResolvedValue({ data: null });
    const reqOut = await svc.forTenant('default').getLogoutRequest('ch');
    expect(reqOut.sid).toBe('sid1');
    expect(reqOut.rpInitiated).toBe(true);
    const acc = await svc.forTenant('default').acceptLogoutRequest('ch');
    expect(acc.redirectTo).toBe('https://cb');
    await svc.forTenant('default').rejectLogoutRequest('ch');
  });
});
