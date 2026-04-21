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
  verifier?: 'hmac' | 'jwt';
  jwks?: Record<string, unknown>;
  audience?: string | readonly string[];
  clockSkewMs?: number;
  replayProtection?: { enabled: boolean; ttlMs?: number };
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
      verifier: opts.verifier ?? 'hmac',
      signerKeys: opts.signerKeys ?? ['primary-key'],
      jwks: opts.jwks,
      audience: opts.audience,
      clockSkewMs: opts.clockSkewMs ?? 30_000,
      replayProtection:
        opts.replayProtection === undefined
          ? undefined
          : { enabled: opts.replayProtection.enabled, ttlMs: opts.replayProtection.ttlMs ?? 60_000 },
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
    const transport = new OathkeeperTransport(undefined, logger as unknown as import('@nestjs/common').Logger);
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
    const transport = new OathkeeperTransport(undefined, logger as unknown as import('@nestjs/common').Logger);
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

/* ------------------------------------------------------------------ */
/* Zero-trust additions (0.3.0): expiry, audience, replay, JWT mode.   */
/* ------------------------------------------------------------------ */
import {
  InMemoryReplayCache,
} from '../../../src/cache/in-memory-replay-cache';

describe('OathkeeperTransport — envelope expiry enforcement', () => {
  it('rejects an envelope whose expiresAt is in the past (beyond clockSkewMs)', async () => {
    const transport = new OathkeeperTransport();
    const expired = JSON.stringify({
      id: 'u_1',
      schemaId: 'default',
      state: 'active',
      tenant: 'tenant-a',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const sig = signBase64(expired, 'primary-key');
    const req: RequestLike = {
      headers: { 'x-user': expired, 'x-user-signature': sig },
    };
    await expect(
      transport.resolve(req, makeTenant(), 'tenant-a', makeTenantConfig({ clockSkewMs: 30_000 })),
    ).rejects.toMatchObject({ message: expect.stringMatching(/expired/i) });
  });

  it('accepts an envelope whose expiresAt is inside the clockSkewMs leeway', async () => {
    const transport = new OathkeeperTransport();
    const nearExpiry = JSON.stringify({
      id: 'u_1',
      schemaId: 'default',
      state: 'active',
      tenant: 'tenant-a',
      // Expired 5s ago, but 30s clock skew means it's still accepted.
      expiresAt: new Date(Date.now() - 5_000).toISOString(),
    });
    const sig = signBase64(nearExpiry, 'primary-key');
    const req: RequestLike = {
      headers: { 'x-user': nearExpiry, 'x-user-signature': sig },
    };
    const result = await transport.resolve(
      req,
      makeTenant(),
      'tenant-a',
      makeTenantConfig({ clockSkewMs: 30_000 }),
    );
    expect(result).not.toBeNull();
  });
});

describe('OathkeeperTransport — audience scoping', () => {
  it('rejects an envelope when configured audience does not match', async () => {
    const transport = new OathkeeperTransport();
    const envelope = JSON.stringify({
      id: 'u_1',
      state: 'active',
      tenant: 'tenant-a',
      audience: 'other-service',
    });
    const sig = signBase64(envelope, 'primary-key');
    const req: RequestLike = {
      headers: { 'x-user': envelope, 'x-user-signature': sig },
    };
    await expect(
      transport.resolve(
        req,
        makeTenant(),
        'tenant-a',
        makeTenantConfig({ audience: 'orders-api' }),
      ),
    ).rejects.toMatchObject({ message: 'audience_mismatch' });
  });

  it('accepts an envelope whose audience intersects the configured list', async () => {
    const transport = new OathkeeperTransport();
    const envelope = JSON.stringify({
      id: 'u_1',
      state: 'active',
      tenant: 'tenant-a',
      audience: ['orders-api', 'reporting-api'],
    });
    const sig = signBase64(envelope, 'primary-key');
    const req: RequestLike = {
      headers: { 'x-user': envelope, 'x-user-signature': sig },
    };
    const result = await transport.resolve(
      req,
      makeTenant(),
      'tenant-a',
      makeTenantConfig({ audience: ['something-else', 'orders-api'] }),
    );
    expect(result).not.toBeNull();
  });

  it('rejects when configured audience is present but envelope omits the claim', async () => {
    const transport = new OathkeeperTransport();
    const envelope = JSON.stringify({ id: 'u_1', state: 'active', tenant: 'tenant-a' });
    const sig = signBase64(envelope, 'primary-key');
    const req: RequestLike = {
      headers: { 'x-user': envelope, 'x-user-signature': sig },
    };
    await expect(
      transport.resolve(
        req,
        makeTenant(),
        'tenant-a',
        makeTenantConfig({ audience: 'orders-api' }),
      ),
    ).rejects.toMatchObject({ message: 'audience_mismatch' });
  });
});

describe('OathkeeperTransport — anti-replay via jti', () => {
  it('accepts a first-use jti, rejects the second use of the same jti', async () => {
    const cache = new InMemoryReplayCache();
    const transport = new OathkeeperTransport(cache);
    const envelope = JSON.stringify({
      id: 'u_1',
      state: 'active',
      tenant: 'tenant-a',
      jti: 'jti-42',
    });
    const sig = signBase64(envelope, 'primary-key');
    const req: RequestLike = {
      headers: { 'x-user': envelope, 'x-user-signature': sig },
    };
    const cfg = makeTenantConfig({
      replayProtection: { enabled: true, ttlMs: 60_000 },
    });
    const first = await transport.resolve(req, makeTenant(), 'tenant-a', cfg);
    expect(first).not.toBeNull();
    await expect(
      transport.resolve(req, makeTenant(), 'tenant-a', cfg),
    ).rejects.toMatchObject({ message: 'replay' });
  });

  it('rejects when replay protection is enabled but the envelope lacks jti', async () => {
    const transport = new OathkeeperTransport(new InMemoryReplayCache());
    const envelope = JSON.stringify({ id: 'u_1', state: 'active', tenant: 'tenant-a' });
    const sig = signBase64(envelope, 'primary-key');
    const req: RequestLike = {
      headers: { 'x-user': envelope, 'x-user-signature': sig },
    };
    await expect(
      transport.resolve(
        req,
        makeTenant(),
        'tenant-a',
        makeTenantConfig({ replayProtection: { enabled: true } }),
      ),
    ).rejects.toMatchObject({ message: 'replay_jti_missing' });
  });

  it('fails closed when replay protection is enabled but no cache is wired', async () => {
    const transport = new OathkeeperTransport(); // no replay cache
    const envelope = JSON.stringify({
      id: 'u_1',
      state: 'active',
      tenant: 'tenant-a',
      jti: 'jti-1',
    });
    const sig = signBase64(envelope, 'primary-key');
    const req: RequestLike = {
      headers: { 'x-user': envelope, 'x-user-signature': sig },
    };
    await expect(
      transport.resolve(
        req,
        makeTenant(),
        'tenant-a',
        makeTenantConfig({ replayProtection: { enabled: true } }),
      ),
    ).rejects.toMatchObject({ message: 'replay_cache_unavailable' });
  });
});

describe('OathkeeperTransport — JWT verifier with inline JWKS', () => {
  // Generate an RSA keypair once and reuse across all JWT tests.
  let jwk: Record<string, unknown>;
  let signKey: unknown;

  beforeAll(async () => {
    const { generateKeyPair, exportJWK } = await import('jose');
    const kp = await generateKeyPair('RS256', { extractable: true });
    signKey = kp.privateKey;
    const publicJwk = await exportJWK(kp.publicKey);
    publicJwk.alg = 'RS256';
    publicJwk.kid = 'test-key-1';
    jwk = publicJwk as unknown as Record<string, unknown>;
  });

  async function signJwt(payload: Record<string, unknown>): Promise<string> {
    const { SignJWT } = await import('jose');
    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .sign(signKey as any);
  }

  it('accepts a JWT signed with the JWKS private key', async () => {
    const transport = new OathkeeperTransport();
    const jwt = await signJwt({ sub: 'u_jwt_1', tenant: 'tenant-a' });
    const req: RequestLike = { headers: { 'x-user': jwt } };
    const result = await transport.resolve(
      req,
      makeTenant(),
      'tenant-a',
      makeTenantConfig({
        verifier: 'jwt',
        jwks: { keys: [jwk], algorithms: ['RS256'], refreshIntervalMs: 600_000, cooldownMs: 30_000 },
      }),
    );
    expect(result).not.toBeNull();
    expect(result?.identity.id).toBe('u_jwt_1');
  });

  it('rejects a JWT whose signature does not verify against the JWKS', async () => {
    const { SignJWT, generateKeyPair } = await import('jose');
    const other = await generateKeyPair('RS256', { extractable: true });
    const bad = await new SignJWT({ sub: 'intruder' })
      .setProtectedHeader({ alg: 'RS256', kid: 'other' })
      .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .sign(other.privateKey as any);
    const transport = new OathkeeperTransport();
    const req: RequestLike = { headers: { 'x-user': bad } };
    await expect(
      transport.resolve(
        req,
        makeTenant(),
        'tenant-a',
        makeTenantConfig({
          verifier: 'jwt',
          jwks: { keys: [jwk], algorithms: ['RS256'], refreshIntervalMs: 600_000, cooldownMs: 30_000 },
        }),
      ),
    ).rejects.toMatchObject({ message: 'invalid_signature' });
  });

  it('rejects a JWT with an expired exp claim', async () => {
    const { SignJWT } = await import('jose');
    const expired = await new SignJWT({ sub: 'u_2', tenant: 'tenant-a' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .sign(signKey as any);
    const transport = new OathkeeperTransport();
    const req: RequestLike = { headers: { 'x-user': expired } };
    await expect(
      transport.resolve(
        req,
        makeTenant(),
        'tenant-a',
        makeTenantConfig({
          verifier: 'jwt',
          jwks: { keys: [jwk], algorithms: ['RS256'], refreshIntervalMs: 600_000, cooldownMs: 30_000 },
        }),
      ),
    ).rejects.toMatchObject({ message: 'expired' });
  });

  it('enforces the audience claim against the configured allowlist', async () => {
    const transport = new OathkeeperTransport();
    const jwt = await signJwt({ sub: 'u_3', tenant: 'tenant-a', aud: 'other-api' });
    const req: RequestLike = { headers: { 'x-user': jwt } };
    await expect(
      transport.resolve(
        req,
        makeTenant(),
        'tenant-a',
        makeTenantConfig({
          verifier: 'jwt',
          jwks: { keys: [jwk], algorithms: ['RS256'], refreshIntervalMs: 600_000, cooldownMs: 30_000 },
          audience: 'orders-api',
        }),
      ),
    ).rejects.toMatchObject({ message: 'audience_mismatch' });
  });
});
