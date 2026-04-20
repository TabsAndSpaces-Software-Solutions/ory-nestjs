/**
 * Unit tests for CookieOrBearerTransport — cookie-first, bearer-fallback.
 */
import type { TenantConfig } from '../../../src/config';
import type { TenantClients } from '../../../src/clients';
import { CookieOrBearerTransport } from '../../../src/transport/cookie-or-bearer.transport';
import type { RequestLike } from '../../../src/transport/session-transport.interface';
import { activeOrySession } from '../../../src/dto/mappers/__fixtures__/session.fixture';

function makeTenant(toSession: jest.Mock): TenantClients {
  return {
    tenant: 'tenant-a',
    config: {} as TenantConfig,
    axios: {} as TenantClients['axios'],
    kratosFrontend: { toSession } as unknown as TenantClients['kratosFrontend'],
  };
}

function makeTenantConfig(): TenantConfig {
  return {
    mode: 'self-hosted',
    transport: 'cookie-or-bearer',
    kratos: {
      publicUrl: 'http://kratos.test',
      sessionCookieName: 'ory_kratos_session',
    },
  } as unknown as TenantConfig;
}

describe('CookieOrBearerTransport', () => {
  let transport: CookieOrBearerTransport;
  let toSession: jest.Mock;

  beforeEach(() => {
    transport = new CookieOrBearerTransport();
    toSession = jest.fn();
  });

  it('returns null when neither cookie nor bearer is present', async () => {
    const tenant = makeTenant(toSession);
    const req: RequestLike = { headers: {} };
    const result = await transport.resolve(req, tenant, 'tenant-a', makeTenantConfig());
    expect(result).toBeNull();
    expect(toSession).not.toHaveBeenCalled();
  });

  it('uses the cookie transport when a session cookie is present', async () => {
    toSession.mockResolvedValue({ data: activeOrySession });
    const tenant = makeTenant(toSession);
    const req: RequestLike = {
      headers: {
        cookie: 'ory_kratos_session=abc',
        authorization: 'Bearer should-not-be-used',
      },
    };
    const result = await transport.resolve(req, tenant, 'tenant-a', makeTenantConfig());
    expect(result).not.toBeNull();
    // Cookie transport calls with { cookie }.
    expect(toSession).toHaveBeenCalledTimes(1);
    expect(toSession).toHaveBeenCalledWith({ cookie: 'ory_kratos_session=abc' });
  });

  it('falls back to bearer when no cookie is present', async () => {
    toSession.mockResolvedValue({ data: activeOrySession });
    const tenant = makeTenant(toSession);
    const req: RequestLike = {
      headers: { authorization: 'Bearer tkn' },
    };
    const result = await transport.resolve(req, tenant, 'tenant-a', makeTenantConfig());
    expect(result).not.toBeNull();
    expect(toSession).toHaveBeenCalledTimes(1);
    expect(toSession).toHaveBeenCalledWith({ xSessionToken: 'tkn' });
  });

  it('falls back to bearer when cookie header exists but the named cookie is missing', async () => {
    toSession.mockResolvedValue({ data: activeOrySession });
    const tenant = makeTenant(toSession);
    const req: RequestLike = {
      headers: {
        cookie: 'other=xxx',
        authorization: 'Bearer bearer-wins',
      },
    };
    const result = await transport.resolve(req, tenant, 'tenant-a', makeTenantConfig());
    expect(result).not.toBeNull();
    expect(toSession).toHaveBeenCalledTimes(1);
    expect(toSession).toHaveBeenCalledWith({ xSessionToken: 'bearer-wins' });
  });

  it('rethrows errors from the chosen transport (cookie path)', async () => {
    const upstream = new Error('401');
    toSession.mockRejectedValue(upstream);
    const tenant = makeTenant(toSession);
    const req: RequestLike = {
      headers: {
        cookie: 'ory_kratos_session=abc',
        authorization: 'Bearer fallback',
      },
    };
    await expect(
      transport.resolve(req, tenant, 'tenant-a', makeTenantConfig()),
    ).rejects.toBe(upstream);
    // Cookie path was tried first and threw — should not fall through to bearer.
    expect(toSession).toHaveBeenCalledTimes(1);
  });
});
