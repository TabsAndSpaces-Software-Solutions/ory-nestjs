/**
 * Unit tests for OathkeeperTransport — verifies pre-authenticated headers
 * from the Ory Oathkeeper proxy.
 */
import * as crypto from 'crypto';
import type { TenantConfig } from '../../../src/config';
import type { TenantClients } from '../../../src/clients';
import { OathkeeperTransport } from '../../../src/transport/oathkeeper.transport';
import type { RequestLike } from '../../../src/transport/session-transport.interface';
import { IamUnauthorizedError } from '../../../src/errors';

function makeTenant(toSession: jest.Mock = jest.fn()): TenantClients {
  return {
    tenant: 'tenant-a',
    config: {} as TenantConfig,
    axios: {} as TenantClients['axios'],
    kratosFrontend: { toSession } as unknown as TenantClients['kratosFrontend'],
  };
}

interface OathkeeperOptions {
  identityHeader?: string;
  signatureHeader?: string;
  signerKeys?: string[];
}

function makeTenantConfig(opts: OathkeeperOptions = {}): TenantConfig {
  return {
    mode: 'self-hosted',
    transport: 'oathkeeper',
    kratos: {
      publicUrl: 'http://kratos.test',
      sessionCookieName: 'ory_kratos_session',
    },
    oathkeeper: {
      identityHeader: opts.identityHeader ?? 'x-user',
      signatureHeader: opts.signatureHeader ?? 'x-user-signature',
      signerKeys: opts.signerKeys ?? ['primary-key'],
    },
  } as unknown as TenantConfig;
}

function signBase64(envelope: string, key: string): string {
  return crypto.createHmac('sha256', key).update(envelope).digest('base64');
}

const plainEnvelope = JSON.stringify({
  id: 'u_1',
  schemaId: 'default',
  state: 'active',
  tenant: 'tenant-a',
  sessionId: 'sess-42',
  expiresAt: '2030-01-01T00:00:00.000Z',
  verifiedAddressesFlags: { email: true, phone: false },
});

describe('OathkeeperTransport', () => {
  it('returns null when the identity header is absent', async () => {
    const transport = new OathkeeperTransport();
    const tenant = makeTenant();
    const req: RequestLike = { headers: {} };
    const result = await transport.resolve(req, tenant, 'tenant-a', makeTenantConfig());
    expect(result).toBeNull();
  });

  it('throws IamUnauthorizedError("unsigned_header") when identity header is present but signature header is missing', async () => {
    const transport = new OathkeeperTransport();
    const tenant = makeTenant();
    const req: RequestLike = {
      headers: { 'x-user': plainEnvelope },
    };
    await expect(
      transport.resolve(req, tenant, 'tenant-a', makeTenantConfig()),
    ).rejects.toBeInstanceOf(IamUnauthorizedError);
    await expect(
      transport.resolve(req, tenant, 'tenant-a', makeTenantConfig()),
    ).rejects.toMatchObject({ message: 'unsigned_header' });
  });

  it('resolves with a synthetic session when signature verifies against the primary key', async () => {
    const transport = new OathkeeperTransport();
    const tenant = makeTenant();
    const sig = signBase64(plainEnvelope, 'primary-key');
    const req: RequestLike = {
      headers: { 'x-user': plainEnvelope, 'x-user-signature': sig },
    };
    const result = await transport.resolve(req, tenant, 'tenant-a', makeTenantConfig());
    expect(result).not.toBeNull();
    expect(result!.identity.id).toBe('u_1');
    expect(result!.identity.schemaId).toBe('default');
    expect(result!.identity.state).toBe('active');
    expect(result!.session.id).toBe('sess-42');
    expect(result!.session.active).toBe(true);
    expect(result!.session.expiresAt).toBe('2030-01-01T00:00:00.000Z');
    expect(result!.session.authenticationMethods).toEqual(['oathkeeper']);
    // Kratos is NOT called — no session lookup needed.
    expect(tenant.kratosFrontend.toSession).not.toHaveBeenCalled();
  });

  it('preserves the tenant claimed by the envelope (guard performs cross-tenant check)', async () => {
    const transport = new OathkeeperTransport();
    const tenant = makeTenant();
    const sig = signBase64(plainEnvelope, 'primary-key');
    const req: RequestLike = {
      headers: { 'x-user': plainEnvelope, 'x-user-signature': sig },
    };
    // Pass a different tenantName than the envelope claims — transport keeps
    // the envelope's tenant so the guard can detect the mismatch.
    const result = await transport.resolve(req, tenant, 'different-tenant', makeTenantConfig());
    expect(result).not.toBeNull();
    expect(result!.identity.tenant).toBe('tenant-a');
    expect(result!.session.tenant).toBe('tenant-a');
  });

  it('throws IamUnauthorizedError when signature matches none of the allowlist keys', async () => {
    const transport = new OathkeeperTransport();
    const tenant = makeTenant();
    const badSig = signBase64(plainEnvelope, 'attacker-key');
    const req: RequestLike = {
      headers: { 'x-user': plainEnvelope, 'x-user-signature': badSig },
    };
    await expect(
      transport.resolve(req, tenant, 'tenant-a', makeTenantConfig()),
    ).rejects.toBeInstanceOf(IamUnauthorizedError);
  });

  it('verifies against a secondary (rotation) key when primary does not match', async () => {
    const transport = new OathkeeperTransport();
    const tenant = makeTenant();
    const sig = signBase64(plainEnvelope, 'secondary-key');
    const req: RequestLike = {
      headers: { 'x-user': plainEnvelope, 'x-user-signature': sig },
    };
    const config = makeTenantConfig({ signerKeys: ['primary-key', 'secondary-key'] });
    const result = await transport.resolve(req, tenant, 'tenant-a', config);
    expect(result).not.toBeNull();
  });

  it('logs a one-time WARN when rotation falls through to a non-primary key', async () => {
    const logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const transport = new OathkeeperTransport(logger as unknown as import('@nestjs/common').Logger);
    const tenant = makeTenant();
    const sig = signBase64(plainEnvelope, 'secondary-key');
    const req: RequestLike = {
      headers: { 'x-user': plainEnvelope, 'x-user-signature': sig },
    };
    const config = makeTenantConfig({ signerKeys: ['primary-key', 'secondary-key'] });

    await transport.resolve(req, tenant, 'tenant-a', config);
    await transport.resolve(req, tenant, 'tenant-a', config);

    // Exactly one warn for the fall-through — not one per request.
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const msg = String(logger.warn.mock.calls[0][0]);
    expect(msg.toLowerCase()).toMatch(/rotat|secondary|non-primary|fallthrough|fall-through|key/);
  });

  it('does NOT warn when the primary key verifies', async () => {
    const logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const transport = new OathkeeperTransport(logger as unknown as import('@nestjs/common').Logger);
    const tenant = makeTenant();
    const sig = signBase64(plainEnvelope, 'primary-key');
    const req: RequestLike = {
      headers: { 'x-user': plainEnvelope, 'x-user-signature': sig },
    };
    await transport.resolve(req, tenant, 'tenant-a', makeTenantConfig());
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('accepts a base64-encoded envelope (detects by first char != "{")', async () => {
    const envelope = JSON.stringify({
      id: 'u_2',
      schemaId: 'default',
      state: 'active',
      tenant: 'tenant-a',
      sessionId: 'sess-b64',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
    const encoded = Buffer.from(envelope, 'utf8').toString('base64');
    const sig = signBase64(encoded, 'primary-key');
    const transport = new OathkeeperTransport();
    const tenant = makeTenant();
    const req: RequestLike = {
      headers: { 'x-user': encoded, 'x-user-signature': sig },
    };
    const result = await transport.resolve(req, tenant, 'tenant-a', makeTenantConfig());
    expect(result).not.toBeNull();
    expect(result!.identity.id).toBe('u_2');
    expect(result!.session.id).toBe('sess-b64');
  });

  it('records latencyMs (fast — no upstream call)', async () => {
    const transport = new OathkeeperTransport();
    const tenant = makeTenant();
    const sig = signBase64(plainEnvelope, 'primary-key');
    const req: RequestLike = {
      headers: { 'x-user': plainEnvelope, 'x-user-signature': sig },
    };
    const result = await transport.resolve(req, tenant, 'tenant-a', makeTenantConfig());
    expect(result!.latencyMs).toBeGreaterThanOrEqual(0);
    expect(typeof result!.latencyMs).toBe('number');
  });

  it('uses the configured identity/signature header names (case-insensitive)', async () => {
    const transport = new OathkeeperTransport();
    const tenant = makeTenant();
    const sig = signBase64(plainEnvelope, 'primary-key');
    const req: RequestLike = {
      headers: { 'custom-ident': plainEnvelope, 'custom-sig': sig },
    };
    const config = makeTenantConfig({
      identityHeader: 'Custom-Ident',
      signatureHeader: 'Custom-Sig',
    });
    const result = await transport.resolve(req, tenant, 'tenant-a', config);
    expect(result).not.toBeNull();
  });

  it('throws IamUnauthorizedError when envelope is malformed JSON', async () => {
    const transport = new OathkeeperTransport();
    const tenant = makeTenant();
    const bogusEnvelope = '{not-valid-json';
    const sig = signBase64(bogusEnvelope, 'primary-key');
    const req: RequestLike = {
      headers: { 'x-user': bogusEnvelope, 'x-user-signature': sig },
    };
    await expect(
      transport.resolve(req, tenant, 'tenant-a', makeTenantConfig()),
    ).rejects.toBeInstanceOf(IamUnauthorizedError);
  });

  it('throws IamUnauthorizedError when oathkeeper config is missing', async () => {
    const transport = new OathkeeperTransport();
    const tenant = makeTenant();
    const req: RequestLike = {
      headers: { 'x-user': plainEnvelope, 'x-user-signature': 'sig' },
    };
    // A config without oathkeeper block — misconfiguration scenario.
    const config = {
      mode: 'self-hosted',
      transport: 'oathkeeper',
      kratos: { publicUrl: 'http://kratos.test', sessionCookieName: 'x' },
    } as unknown as TenantConfig;
    await expect(
      transport.resolve(req, tenant, 'tenant-a', config),
    ).rejects.toBeInstanceOf(IamUnauthorizedError);
  });
});
