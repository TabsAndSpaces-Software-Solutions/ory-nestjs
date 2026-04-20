/**
 * Unit tests for TransportFactory — selects the correct SessionTransport
 * implementation based on tenantConfig.transport, and wraps it in a
 * CachingSessionTransport when the tenant has a positive sessionTtlMs and
 * a SessionCache backend is registered on the factory.
 */
import { InMemorySessionCache } from '../../../src/cache';
import type { TenantConfig } from '../../../src/config';
import { TransportFactory } from '../../../src/transport/transport.factory';
import { CachingSessionTransport } from '../../../src/transport/caching-session.transport';
import { CookieTransport } from '../../../src/transport/cookie.transport';
import { BearerTransport } from '../../../src/transport/bearer.transport';
import { CookieOrBearerTransport } from '../../../src/transport/cookie-or-bearer.transport';
import { OathkeeperTransport } from '../../../src/transport/oathkeeper.transport';

function cfg(
  transport: TenantConfig['transport'],
  overrides: Partial<TenantConfig> = {},
): TenantConfig {
  return {
    mode: 'self-hosted',
    transport,
    kratos: {
      publicUrl: 'http://kratos.test',
      sessionCookieName: 'ory_kratos_session',
    },
    oathkeeper: {
      identityHeader: 'x-user',
      signatureHeader: 'x-user-signature',
      signerKeys: ['k1'],
    },
    ...overrides,
  } as unknown as TenantConfig;
}

describe('TransportFactory.forTenant', () => {
  it('returns a CookieTransport for transport: "cookie"', () => {
    const factory = new TransportFactory();
    const t = factory.forTenant(cfg('cookie'));
    expect(t).toBeInstanceOf(CookieTransport);
  });

  it('returns a BearerTransport for transport: "bearer"', () => {
    const factory = new TransportFactory();
    const t = factory.forTenant(cfg('bearer'));
    expect(t).toBeInstanceOf(BearerTransport);
  });

  it('returns a CookieOrBearerTransport for transport: "cookie-or-bearer"', () => {
    const factory = new TransportFactory();
    const t = factory.forTenant(cfg('cookie-or-bearer'));
    expect(t).toBeInstanceOf(CookieOrBearerTransport);
  });

  it('returns an OathkeeperTransport for transport: "oathkeeper"', () => {
    const factory = new TransportFactory();
    const t = factory.forTenant(cfg('oathkeeper'));
    expect(t).toBeInstanceOf(OathkeeperTransport);
  });

  it('throws on an unsupported transport kind', () => {
    const factory = new TransportFactory();
    expect(() =>
      factory.forTenant(cfg('bogus' as unknown as TenantConfig['transport'])),
    ).toThrow();
  });

  it('does NOT wrap in CachingSessionTransport when sessionTtlMs is 0', () => {
    const factory = new TransportFactory(new InMemorySessionCache());
    const t = factory.forTenant(
      cfg('cookie', { cache: { sessionTtlMs: 0, permissionTtlMs: 0, jwksTtlMs: 0 } } as Partial<TenantConfig>),
    );
    expect(t).toBeInstanceOf(CookieTransport);
    expect(t).not.toBeInstanceOf(CachingSessionTransport);
  });

  it('does NOT wrap when no SessionCache is registered, even if sessionTtlMs > 0', () => {
    const factory = new TransportFactory();
    const t = factory.forTenant(
      cfg('cookie', { cache: { sessionTtlMs: 60_000, permissionTtlMs: 0, jwksTtlMs: 0 } } as Partial<TenantConfig>),
    );
    expect(t).toBeInstanceOf(CookieTransport);
    expect(t).not.toBeInstanceOf(CachingSessionTransport);
  });

  it('wraps in CachingSessionTransport when sessionTtlMs > 0 AND a cache is registered', () => {
    const factory = new TransportFactory(new InMemorySessionCache());
    const t = factory.forTenant(
      cfg('cookie', { cache: { sessionTtlMs: 60_000, permissionTtlMs: 0, jwksTtlMs: 0 } } as Partial<TenantConfig>),
    );
    expect(t).toBeInstanceOf(CachingSessionTransport);
  });
});
