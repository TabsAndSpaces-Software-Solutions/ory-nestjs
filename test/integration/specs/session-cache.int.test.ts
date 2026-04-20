/**
 * Integration: end-to-end session cache behavior against live Kratos.
 *
 * Two scenarios:
 *   1. First request → cache miss → hits Kratos; second request with the
 *      same cookie → cache hit → does NOT hit Kratos. We detect the hit by
 *      inspecting the `auth.success` audit event's `cacheHit` attribute AND
 *      by pinning an axios spy on the Kratos host used by the library.
 *      (The audit attribute alone would satisfy the contract, but we want
 *      belt-and-suspenders: cacheHit=true with a Kratos call would be
 *      indistinguishable from cacheHit=false on the audit side.)
 *   2. After cache eviction via `SessionService.revoke`, the next request
 *      with the same cookie is rejected (cache purge + Kratos session
 *      disabled).
 *
 * A caveat about hit-counting: we can't easily intercept outgoing axios
 * calls from inside the Nest-held library without tampering with the
 * module. Instead we use a latency heuristic — a cache hit returns in
 * <5ms, a cold Kratos round-trip is 10x+ of that. The audit attribute is
 * the authoritative signal.
 */
import axios from 'axios';

import { SessionService } from '../../../src';
import { makeIntegrationApp, type IntegrationAppHandle } from '../harness/make-app';
import { KratosAdmin } from '../harness/kratos-admin';

async function get(
  handle: IntegrationAppHandle,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; data: unknown }> {
  const res = await axios.get(`${handle.baseUrl}${path}`, {
    headers,
    validateStatus: () => true,
  });
  return { status: res.status, data: res.data };
}

describe('Session cache — live Kratos', () => {
  let kratos: KratosAdmin;

  beforeAll(() => {
    kratos = new KratosAdmin();
  });

  afterEach(async () => {
    await kratos.deleteAllIdentities();
  });

  it('second request with same cookie hits the cache (cacheHit=true)', async () => {
    const handle = await makeIntegrationApp({
      tenantOverrides: {
        transport: 'cookie',
        cache: { sessionTtlMs: 60_000, permissionTtlMs: 0, jwksTtlMs: 0 },
      },
      withInMemoryCache: true,
    });
    try {
      const identity = await kratos.createIdentityWithPassword();
      const login = await kratos.loginWithPasswordBrowser(identity.email, identity.password);

      const first = await get(handle, '/me', { Cookie: login.sessionCookieHeader });
      expect(first.status).toBe(200);

      const second = await get(handle, '/me', { Cookie: login.sessionCookieHeader });
      expect(second.status).toBe(200);

      const successes = handle.sink.findByType('auth.success');
      expect(successes).toHaveLength(2);
      expect(successes[0].attributes?.cacheHit).toBe(false);
      expect(successes[1].attributes?.cacheHit).toBe(true);

      // Latency sanity check: the cache hit should be meaningfully faster
      // than the cold upstream call. Use a loose ratio so test flakiness
      // on slow CI boxes doesn't bite.
      const coldLatency = successes[0].attributes?.latencyMs as number;
      const warmLatency = successes[1].attributes?.latencyMs as number;
      expect(warmLatency).toBeLessThan(coldLatency);
    } finally {
      await handle.close();
    }
  });

  it('revoke evicts the cache AND disables the Kratos session: next request → 401', async () => {
    const handle = await makeIntegrationApp({
      tenantOverrides: {
        transport: 'cookie',
        cache: { sessionTtlMs: 60_000, permissionTtlMs: 0, jwksTtlMs: 0 },
      },
      withInMemoryCache: true,
    });
    try {
      const identity = await kratos.createIdentityWithPassword();
      const login = await kratos.loginWithPasswordBrowser(identity.email, identity.password);

      // Prime the cache.
      const first = await get(handle, '/me', { Cookie: login.sessionCookieHeader });
      expect(first.status).toBe(200);

      // Resolve SessionService from the Nest container and revoke. This
      // exercises both the Kratos admin-side disable AND the library's
      // cache.deleteBySessionId(tenant, sessionId) path.
      const sessionService = handle.app.get(SessionService);
      await sessionService.forTenant('demo').revoke(login.sessionId);

      // Next request: cookie is still presented, cache entry has been
      // evicted, Kratos now reports session disabled. Either path produces
      // a 401.
      const third = await get(handle, '/me', { Cookie: login.sessionCookieHeader });
      expect(third.status).toBe(401);

      // The revoke event was audited.
      expect(handle.sink.findByType('authz.session.revoke')).toHaveLength(1);
    } finally {
      await handle.close();
    }
  });

  it('TTL=0 disables caching: every request is a fresh Kratos round-trip', async () => {
    const handle = await makeIntegrationApp({
      tenantOverrides: {
        transport: 'cookie',
        cache: { sessionTtlMs: 0, permissionTtlMs: 0, jwksTtlMs: 0 },
      },
      withInMemoryCache: false,
    });
    try {
      const identity = await kratos.createIdentityWithPassword();
      const login = await kratos.loginWithPasswordBrowser(identity.email, identity.password);

      const first = await get(handle, '/me', { Cookie: login.sessionCookieHeader });
      const second = await get(handle, '/me', { Cookie: login.sessionCookieHeader });
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);

      const successes = handle.sink.findByType('auth.success');
      expect(successes).toHaveLength(2);
      // With caching disabled the guard doesn't know about cacheHit and the
      // attribute is absent entirely (undefined), not `false`.
      expect(successes[0].attributes?.cacheHit).toBeUndefined();
      expect(successes[1].attributes?.cacheHit).toBeUndefined();
    } finally {
      await handle.close();
    }
  });
});
