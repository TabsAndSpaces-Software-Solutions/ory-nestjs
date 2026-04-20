/**
 * Unit tests for `CachingSessionTransport`.
 *
 * Covers:
 *   - Cache hit: inner.resolve NOT called; result carries fromCache=true.
 *   - Cache miss: inner.resolve called once; result cached; fromCache=false.
 *   - TTL computation: expiresAt is min(now + sessionTtlMs, session.expiresAt).
 *   - Fail-open on cache.get throw: falls through to inner.
 *   - Fail-open on cache.set throw: still returns the fresh result.
 *   - No-credential: inner.credentialFingerprint returns null → no cache
 *     lookup, fingerprint passthrough is null.
 *   - Constructor rejects sessionTtlMs <= 0 so callers cannot accidentally
 *     wrap a "caching disabled" transport.
 *   - Tenant isolation: cache key includes tenantName.
 */
import { InMemorySessionCache } from '../../../src/cache/in-memory-session-cache';
import type { SessionCache } from '../../../src/cache/session-cache.interface';
import type { TenantClients } from '../../../src/clients';
import type { TenantConfig } from '../../../src/config';
import type {
  TenantName,
  IamIdentity,
  IamSession,
} from '../../../src/dto';
import { CachingSessionTransport } from '../../../src/transport/caching-session.transport';
import type {
  RequestLike,
  ResolvedSession,
  SessionTransport,
} from '../../../src/transport/session-transport.interface';

function makeTenantConfig(): TenantConfig {
  return {
    mode: 'self-hosted',
    transport: 'cookie',
    kratos: {
      publicUrl: 'http://kratos.test',
      sessionCookieName: 'ory_kratos_session',
    },
  } as unknown as TenantConfig;
}

function makeTenantClients(tenant: TenantName): TenantClients {
  return {
    tenant,
    config: makeTenantConfig(),
    axios: {} as never,
    kratosFrontend: {} as never,
  } as unknown as TenantClients;
}

function makeResolvedSession(
  tenant: string,
  sessionId = 'sess-1',
  expiresAtIso = '2099-01-01T00:00:00.000Z',
): ResolvedSession {
  const identity = {
    id: 'user-1',
    tenant,
  } as unknown as IamIdentity;
  const session = {
    id: sessionId,
    tenant,
    expiresAt: expiresAtIso,
    identity,
  } as unknown as IamSession;
  return { identity, session, latencyMs: 42 };
}

function makeInner(
  impl: () => Promise<ResolvedSession | null>,
  fingerprint: string | null = 'fp-abc',
): SessionTransport & {
  resolve: jest.Mock;
  credentialFingerprint: jest.Mock;
} {
  return {
    resolve: jest.fn(impl),
    credentialFingerprint: jest.fn(() => fingerprint),
  };
}

describe('CachingSessionTransport', () => {
  const req: RequestLike = { headers: {} };

  describe('constructor', () => {
    it('rejects sessionTtlMs <= 0 so callers cannot wrap with caching disabled', () => {
      const cache = new InMemorySessionCache();
      const inner = makeInner(async () => null);
      expect(
        () => new CachingSessionTransport(inner, cache, { sessionTtlMs: 0 }),
      ).toThrow(/sessionTtlMs > 0/);
      expect(
        () => new CachingSessionTransport(inner, cache, { sessionTtlMs: -5 }),
      ).toThrow(/sessionTtlMs > 0/);
    });
  });

  describe('resolve — cache miss', () => {
    it('calls inner.resolve, caches the result, and marks fromCache=false', async () => {
      const cache = new InMemorySessionCache({ now: () => 1_000 });
      const setSpy = jest.spyOn(cache, 'set');
      const resolved = makeResolvedSession('t-a');
      const inner = makeInner(async () => resolved);

      const caching = new CachingSessionTransport(inner, cache, {
        sessionTtlMs: 60_000,
        now: () => 1_000,
      });

      const result = await caching.resolve(req, makeTenantClients('t-a'), 't-a', makeTenantConfig());
      expect(inner.resolve).toHaveBeenCalledTimes(1);
      expect(result).not.toBeNull();
      expect(result!.fromCache).toBe(false);
      expect(result!.identity).toBe(resolved.identity);
      expect(result!.session).toBe(resolved.session);
      expect(setSpy).toHaveBeenCalledTimes(1);
    });

    it('returns null when inner returns null without caching', async () => {
      const cache = new InMemorySessionCache();
      const setSpy = jest.spyOn(cache, 'set');
      const inner = makeInner(async () => null);

      const caching = new CachingSessionTransport(inner, cache, { sessionTtlMs: 60_000 });
      const result = await caching.resolve(req, makeTenantClients('t-a'), 't-a', makeTenantConfig());
      expect(result).toBeNull();
      expect(setSpy).not.toHaveBeenCalled();
    });
  });

  describe('resolve — cache hit', () => {
    it('serves the cached entry without calling inner.resolve', async () => {
      const cache = new InMemorySessionCache({ now: () => 1_000 });
      const resolved = makeResolvedSession('t-a');
      const inner = makeInner(async () => resolved);

      const caching = new CachingSessionTransport(inner, cache, {
        sessionTtlMs: 60_000,
        now: () => 1_000,
      });

      // Prime the cache.
      await caching.resolve(req, makeTenantClients('t-a'), 't-a', makeTenantConfig());
      inner.resolve.mockClear();

      // Second call should hit the cache.
      const result = await caching.resolve(req, makeTenantClients('t-a'), 't-a', makeTenantConfig());
      expect(inner.resolve).not.toHaveBeenCalled();
      expect(result).not.toBeNull();
      expect(result!.fromCache).toBe(true);
      expect(result!.identity).toBe(resolved.identity);
      expect(result!.session).toBe(resolved.session);
    });
  });

  describe('TTL computation', () => {
    it('caps cache TTL at min(sessionTtlMs, session.expiresAt)', async () => {
      const cache = new InMemorySessionCache();
      const setSpy = jest.spyOn(cache, 'set');

      // session.expiresAt = 10_000 ms from "now"; sessionTtlMs = 60_000.
      // Expected cache expiry = now + 10_000 (the tighter bound).
      const now = 100;
      const sessionExpIso = new Date(now + 10_000).toISOString();
      const resolved = makeResolvedSession('t-a', 'sess-x', sessionExpIso);
      const inner = makeInner(async () => resolved);

      const caching = new CachingSessionTransport(inner, cache, {
        sessionTtlMs: 60_000,
        now: () => now,
      });

      await caching.resolve(req, makeTenantClients('t-a'), 't-a', makeTenantConfig());
      expect(setSpy).toHaveBeenCalledTimes(1);
      const entry = setSpy.mock.calls[0][1];
      expect(entry.expiresAt).toBe(now + 10_000);
    });

    it('caps cache TTL at sessionTtlMs when session.expiresAt is further out', async () => {
      const cache = new InMemorySessionCache();
      const setSpy = jest.spyOn(cache, 'set');

      const now = 100;
      const sessionExpIso = new Date(now + 1_000_000).toISOString();
      const resolved = makeResolvedSession('t-a', 'sess-x', sessionExpIso);
      const inner = makeInner(async () => resolved);

      const caching = new CachingSessionTransport(inner, cache, {
        sessionTtlMs: 60_000,
        now: () => now,
      });

      await caching.resolve(req, makeTenantClients('t-a'), 't-a', makeTenantConfig());
      const entry = setSpy.mock.calls[0][1];
      expect(entry.expiresAt).toBe(now + 60_000);
    });

    it('refuses to cache a session already expiring within 1s', async () => {
      const cache = new InMemorySessionCache();
      const setSpy = jest.spyOn(cache, 'set');

      const now = 100;
      const sessionExpIso = new Date(now + 500).toISOString();
      const resolved = makeResolvedSession('t-a', 'sess-x', sessionExpIso);
      const inner = makeInner(async () => resolved);

      const caching = new CachingSessionTransport(inner, cache, {
        sessionTtlMs: 60_000,
        now: () => now,
      });

      const result = await caching.resolve(req, makeTenantClients('t-a'), 't-a', makeTenantConfig());
      expect(result!.fromCache).toBe(false);
      expect(setSpy).not.toHaveBeenCalled();
    });

    it('falls back to sessionTtlMs when session.expiresAt is unparseable', async () => {
      const cache = new InMemorySessionCache();
      const setSpy = jest.spyOn(cache, 'set');

      const resolved = makeResolvedSession('t-a', 'sess-x', 'not-a-date');
      const inner = makeInner(async () => resolved);
      const now = 1_000;

      const caching = new CachingSessionTransport(inner, cache, {
        sessionTtlMs: 60_000,
        now: () => now,
      });

      await caching.resolve(req, makeTenantClients('t-a'), 't-a', makeTenantConfig());
      const entry = setSpy.mock.calls[0][1];
      expect(entry.expiresAt).toBe(now + 60_000);
    });
  });

  describe('fail-open behavior', () => {
    it('cache.get throwing: falls through to inner, does not surface the error', async () => {
      const failing: SessionCache = {
        get: jest.fn().mockRejectedValue(new Error('redis down')),
        set: jest.fn().mockResolvedValue(undefined),
        delete: jest.fn().mockResolvedValue(undefined),
        deleteBySessionId: jest.fn().mockResolvedValue(undefined),
      };
      const resolved = makeResolvedSession('t-a');
      const inner = makeInner(async () => resolved);

      const caching = new CachingSessionTransport(inner, failing, { sessionTtlMs: 60_000 });
      const result = await caching.resolve(req, makeTenantClients('t-a'), 't-a', makeTenantConfig());
      expect(result).not.toBeNull();
      expect(result!.identity).toBe(resolved.identity);
      expect(inner.resolve).toHaveBeenCalledTimes(1);
    });

    it('cache.set throwing: still returns the fresh result with fromCache=false', async () => {
      const failing: SessionCache = {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockRejectedValue(new Error('redis down')),
        delete: jest.fn().mockResolvedValue(undefined),
        deleteBySessionId: jest.fn().mockResolvedValue(undefined),
      };
      const resolved = makeResolvedSession('t-a');
      const inner = makeInner(async () => resolved);

      const caching = new CachingSessionTransport(inner, failing, { sessionTtlMs: 60_000 });
      const result = await caching.resolve(req, makeTenantClients('t-a'), 't-a', makeTenantConfig());
      expect(result).not.toBeNull();
      expect(result!.fromCache).toBe(false);
    });
  });

  describe('fingerprint passthrough / opt-out', () => {
    it('skips the cache entirely when inner.credentialFingerprint returns null', async () => {
      const cache = new InMemorySessionCache();
      const getSpy = jest.spyOn(cache, 'get');
      const setSpy = jest.spyOn(cache, 'set');
      const resolved = makeResolvedSession('t-a');
      const inner = makeInner(async () => resolved, null);

      const caching = new CachingSessionTransport(inner, cache, { sessionTtlMs: 60_000 });
      const result = await caching.resolve(req, makeTenantClients('t-a'), 't-a', makeTenantConfig());
      expect(result).not.toBeNull();
      expect(getSpy).not.toHaveBeenCalled();
      expect(setSpy).not.toHaveBeenCalled();
    });

    it('skips the cache when inner does not implement credentialFingerprint at all', async () => {
      const cache = new InMemorySessionCache();
      const getSpy = jest.spyOn(cache, 'get');
      const resolved = makeResolvedSession('t-a');
      const innerNoFp: SessionTransport = {
        resolve: jest.fn(async () => resolved),
      };

      const caching = new CachingSessionTransport(innerNoFp, cache, { sessionTtlMs: 60_000 });
      const result = await caching.resolve(req, makeTenantClients('t-a'), 't-a', makeTenantConfig());
      expect(result).not.toBeNull();
      expect(getSpy).not.toHaveBeenCalled();
    });
  });

  describe('tenant isolation', () => {
    it('same fingerprint under different tenant names maps to different cache keys', async () => {
      const cache = new InMemorySessionCache();
      const resolvedA = makeResolvedSession('t-a');
      const resolvedB = makeResolvedSession('t-b');
      const innerA = makeInner(async () => resolvedA, 'shared-fp');
      const innerB = makeInner(async () => resolvedB, 'shared-fp');

      const cachingA = new CachingSessionTransport(innerA, cache, { sessionTtlMs: 60_000 });
      const cachingB = new CachingSessionTransport(innerB, cache, { sessionTtlMs: 60_000 });

      await cachingA.resolve(req, makeTenantClients('t-a'), 't-a', makeTenantConfig());
      await cachingB.resolve(req, makeTenantClients('t-b'), 't-b', makeTenantConfig());

      // Both inners called once: no cross-tenant hit.
      expect(innerA.resolve).toHaveBeenCalledTimes(1);
      expect(innerB.resolve).toHaveBeenCalledTimes(1);

      innerA.resolve.mockClear();
      innerB.resolve.mockClear();

      // Second round: both should now hit their own cache entries.
      const a = await cachingA.resolve(req, makeTenantClients('t-a'), 't-a', makeTenantConfig());
      const b = await cachingB.resolve(req, makeTenantClients('t-b'), 't-b', makeTenantConfig());
      expect(innerA.resolve).not.toHaveBeenCalled();
      expect(innerB.resolve).not.toHaveBeenCalled();
      expect(a!.session.tenant).toBe('t-a');
      expect(b!.session.tenant).toBe('t-b');
    });
  });
});
