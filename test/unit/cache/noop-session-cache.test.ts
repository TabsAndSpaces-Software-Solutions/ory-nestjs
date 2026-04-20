/**
 * Unit tests for `NoopSessionCache`.
 *
 * Trivial but worth locking in: a no-op backend must never throw and must
 * always report a miss. Callers rely on this so they can default to it
 * without adding their own null checks.
 */
import { NoopSessionCache } from '../../../src/cache/noop-session-cache';
import type { SessionCacheEntry } from '../../../src/cache/session-cache.interface';

describe('NoopSessionCache', () => {
  const cache = new NoopSessionCache();

  it('get always returns null', async () => {
    expect(await cache.get('any-key')).toBeNull();
    expect(await cache.get('')).toBeNull();
  });

  it('set is a no-op (does not throw, does not populate)', async () => {
    const entry: SessionCacheEntry = {
      identity: { id: 'i-1' } as never,
      session: { id: 's-1', tenant: 't-1' } as never,
      expiresAt: Date.now() + 60_000,
    };
    await expect(cache.set('k', entry)).resolves.toBeUndefined();
    expect(await cache.get('k')).toBeNull();
  });

  it('delete and deleteBySessionId are no-ops', async () => {
    await expect(cache.delete('k')).resolves.toBeUndefined();
    await expect(cache.deleteBySessionId('t-1', 's-1')).resolves.toBeUndefined();
  });
});
