/**
 * Unit tests for CookieTransport.
 *
 * The transport is the only place allowed to read the raw `Cookie` header.
 * Tests stub `tenant.kratosFrontend.toSession` with Jest spies — no real Ory
 * calls.
 */
import type { TenantConfig } from '../../../src/config';
import type { TenantClients } from '../../../src/clients';
import { CookieTransport } from '../../../src/transport/cookie.transport';
import type { RequestLike } from '../../../src/transport/session-transport.interface';
import {
  fullyVerifiedOryIdentity,
} from '../../../src/dto/mappers/__fixtures__/identity.fixture';
import { activeOrySession } from '../../../src/dto/mappers/__fixtures__/session.fixture';

function makeTenant(toSession: jest.Mock): TenantClients {
  return {
    tenant: 'tenant-a',
    config: { kratos: { sessionCookieName: 'ory_kratos_session' } } as TenantConfig,
    axios: {} as TenantClients['axios'],
    kratosFrontend: { toSession } as unknown as TenantClients['kratosFrontend'],
  };
}

function makeTenantConfig(
  cookieName = 'ory_kratos_session',
): TenantConfig {
  return {
    mode: 'self-hosted',
    transport: 'cookie',
    kratos: {
      publicUrl: 'http://kratos.test',
      sessionCookieName: cookieName,
    },
  } as unknown as TenantConfig;
}

describe('CookieTransport', () => {
  let transport: CookieTransport;
  let toSession: jest.Mock;

  beforeEach(() => {
    toSession = jest.fn();
    transport = new CookieTransport();
  });

  it('resolves null when no Cookie header is present', async () => {
    const tenant = makeTenant(toSession);
    const req: RequestLike = { headers: {} };
    const result = await transport.resolve(req, tenant, 'tenant-a', makeTenantConfig());
    expect(result).toBeNull();
    expect(toSession).not.toHaveBeenCalled();
  });

  it('resolves null when Cookie header is present but lacks the named cookie', async () => {
    const tenant = makeTenant(toSession);
    const req: RequestLike = { headers: { cookie: 'foo=bar; baz=qux' } };
    const result = await transport.resolve(req, tenant, 'tenant-a', makeTenantConfig());
    expect(result).toBeNull();
    expect(toSession).not.toHaveBeenCalled();
  });

  it('calls kratosFrontend.toSession with the raw Cookie header when the named cookie is present', async () => {
    toSession.mockResolvedValue({ data: activeOrySession });
    const tenant = makeTenant(toSession);
    const cookieHeader = 'x=1; ory_kratos_session=abc123';
    const req: RequestLike = { headers: { cookie: cookieHeader } };

    const result = await transport.resolve(req, tenant, 'tenant-a', makeTenantConfig());

    expect(toSession).toHaveBeenCalledTimes(1);
    expect(toSession).toHaveBeenCalledWith({ cookie: cookieHeader });
    expect(result).not.toBeNull();
    expect(result!.identity.tenant).toBe('tenant-a');
    expect(result!.session.tenant).toBe('tenant-a');
    expect(result!.session.id).toBe(activeOrySession.id);
    expect(result!.identity.id).toBe(fullyVerifiedOryIdentity.id);
  });

  it('stamps the tenant passed via tenantName, NOT anything the payload claims', async () => {
    toSession.mockResolvedValue({ data: activeOrySession });
    const tenant = makeTenant(toSession);
    const req: RequestLike = {
      headers: { cookie: 'ory_kratos_session=abc' },
    };

    const result = await transport.resolve(req, tenant, 'cross-tenant-b', makeTenantConfig());

    expect(result!.identity.tenant).toBe('cross-tenant-b');
    expect(result!.session.tenant).toBe('cross-tenant-b');
  });

  it('records latencyMs around the kratosFrontend.toSession call', async () => {
    toSession.mockImplementation(async () => {
      // Simulate upstream latency; use a small sleep.
      await new Promise((r) => setTimeout(r, 10));
      return { data: activeOrySession };
    });
    const tenant = makeTenant(toSession);
    const req: RequestLike = {
      headers: { cookie: 'ory_kratos_session=abc' },
    };

    const result = await transport.resolve(req, tenant, 'tenant-a', makeTenantConfig());

    expect(result!.latencyMs).toBeGreaterThanOrEqual(0);
    expect(typeof result!.latencyMs).toBe('number');
  });

  it('rethrows errors from kratosFrontend.toSession so the guard can map them', async () => {
    const upstream = new Error('unauthorized') as Error & { response?: unknown };
    (upstream as any).response = { status: 401 };
    toSession.mockRejectedValue(upstream);

    const tenant = makeTenant(toSession);
    const req: RequestLike = {
      headers: { cookie: 'ory_kratos_session=abc' },
    };

    await expect(
      transport.resolve(req, tenant, 'tenant-a', makeTenantConfig()),
    ).rejects.toBe(upstream);
  });

  it('uses the configured sessionCookieName from tenantConfig.kratos', async () => {
    toSession.mockResolvedValue({ data: activeOrySession });
    const tenant = makeTenant(toSession);
    const cookieHeader = 'my_custom_cookie=abc; other=xyz';
    const req: RequestLike = { headers: { cookie: cookieHeader } };

    const result = await transport.resolve(
      req,
      tenant,
      'tenant-a',
      makeTenantConfig('my_custom_cookie'),
    );

    expect(result).not.toBeNull();
    expect(toSession).toHaveBeenCalledWith({ cookie: cookieHeader });
  });

  it('handles Cookie header provided as an array (takes the first non-empty entry)', async () => {
    toSession.mockResolvedValue({ data: activeOrySession });
    const tenant = makeTenant(toSession);
    const req: RequestLike = {
      headers: { cookie: ['ory_kratos_session=abc', 'extra=1'] },
    };

    const result = await transport.resolve(req, tenant, 'tenant-a', makeTenantConfig());

    expect(result).not.toBeNull();
    expect(toSession).toHaveBeenCalledTimes(1);
  });
});
