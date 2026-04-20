/**
 * Unit tests for BearerTransport.
 */
import type { TenantConfig } from '../../../src/config';
import type { TenantClients } from '../../../src/clients';
import { BearerTransport } from '../../../src/transport/bearer.transport';
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
    transport: 'bearer',
    kratos: {
      publicUrl: 'http://kratos.test',
      sessionCookieName: 'ory_kratos_session',
    },
  } as unknown as TenantConfig;
}

describe('BearerTransport', () => {
  let transport: BearerTransport;
  let toSession: jest.Mock;

  beforeEach(() => {
    transport = new BearerTransport();
    toSession = jest.fn();
  });

  it('resolves null when Authorization header is absent', async () => {
    const tenant = makeTenant(toSession);
    const req: RequestLike = { headers: {} };
    const result = await transport.resolve(req, tenant, 'tenant-a', makeTenantConfig());
    expect(result).toBeNull();
    expect(toSession).not.toHaveBeenCalled();
  });

  it('resolves null when Authorization header is not of the Bearer scheme', async () => {
    const tenant = makeTenant(toSession);
    const req: RequestLike = {
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    };
    const result = await transport.resolve(req, tenant, 'tenant-a', makeTenantConfig());
    expect(result).toBeNull();
    expect(toSession).not.toHaveBeenCalled();
  });

  it('resolves null when Authorization header is just "Bearer" with no token', async () => {
    const tenant = makeTenant(toSession);
    const req: RequestLike = { headers: { authorization: 'Bearer' } };
    const result = await transport.resolve(req, tenant, 'tenant-a', makeTenantConfig());
    expect(result).toBeNull();
  });

  it('calls kratosFrontend.toSession({ xSessionToken }) with a valid Bearer token', async () => {
    toSession.mockResolvedValue({ data: activeOrySession });
    const tenant = makeTenant(toSession);
    const req: RequestLike = {
      headers: { authorization: 'Bearer my-token-123' },
    };

    const result = await transport.resolve(req, tenant, 'tenant-a', makeTenantConfig());

    expect(toSession).toHaveBeenCalledTimes(1);
    expect(toSession).toHaveBeenCalledWith({ xSessionToken: 'my-token-123' });
    expect(result).not.toBeNull();
    expect(result!.identity.tenant).toBe('tenant-a');
    expect(result!.session.tenant).toBe('tenant-a');
  });

  it('accepts case-insensitive Bearer scheme', async () => {
    toSession.mockResolvedValue({ data: activeOrySession });
    const tenant = makeTenant(toSession);
    const req: RequestLike = {
      headers: { authorization: 'bearer lowercase-token' },
    };
    const result = await transport.resolve(req, tenant, 'tenant-a', makeTenantConfig());
    expect(result).not.toBeNull();
    expect(toSession).toHaveBeenCalledWith({ xSessionToken: 'lowercase-token' });
  });

  it('records latencyMs around the kratos call', async () => {
    toSession.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { data: activeOrySession };
    });
    const tenant = makeTenant(toSession);
    const req: RequestLike = {
      headers: { authorization: 'Bearer t' },
    };
    const result = await transport.resolve(req, tenant, 'tenant-a', makeTenantConfig());
    expect(result!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('rethrows errors from kratosFrontend.toSession', async () => {
    const upstream = new Error('unauthorized');
    toSession.mockRejectedValue(upstream);
    const tenant = makeTenant(toSession);
    const req: RequestLike = {
      headers: { authorization: 'Bearer expired-token' },
    };
    await expect(
      transport.resolve(req, tenant, 'tenant-a', makeTenantConfig()),
    ).rejects.toBe(upstream);
  });

  it('handles Authorization header provided as an array (takes first entry)', async () => {
    toSession.mockResolvedValue({ data: activeOrySession });
    const tenant = makeTenant(toSession);
    const req: RequestLike = {
      headers: { authorization: ['Bearer first-token', 'Bearer second'] },
    };
    const result = await transport.resolve(req, tenant, 'tenant-a', makeTenantConfig());
    expect(result).not.toBeNull();
    expect(toSession).toHaveBeenCalledWith({ xSessionToken: 'first-token' });
  });
});
