/**
 * Unit tests for `InMemorySessionCache`.
 *
 * Covers the full contract:
 *   - get returns stored entries while fresh, null after expiry.
 *   - set replaces existing entries and updates the secondary index.
 *   - delete removes an entry and its index pointer.
 *   - deleteBySessionId evicts every cached key bound to (tenant, sessionId).
 *   - LRU eviction kicks in at maxEntries and evicts the least-recently-
 *     accessed entry (recency tracked by `get`).
 *   - The clock is swappable — tests use a manual `now` to assert expiry
 *     deterministically.
 */
import type { IamIdentity, IamSession } from '../../../src/dto';
import { InMemorySessionCache } from '../../../src/cache/in-memory-session-cache';
import type { SessionCacheEntry } from '../../../src/cache/session-cache.interface';

function makeEntry(
  tenant: string,
  sessionId: string,
  expiresAt: number,
): SessionCacheEntry {
  const identity = { id: `user-of-${sessionId}`, tenant } as unknown as IamIdentity;
  const session = { id: sessionId, tenant, identity } as unknown as IamSession;
  return { identity, session, expiresAt };
}

describe('InMemorySessionCache', () => {
  it('round-trips a fresh entry', async () => {
    const cache = new InMemorySessionCache({ now: () => 1_000 });
    const entry = makeEntry('t-a', 'sess-1', 2_000);
    await cache.set('key-1', entry);
    const fetched = await cache.get('key-1');
    expect(fetched).toBe(entry);
  });

  it('returns null and evicts when an entry is past its expiresAt', async () => {
    let now = 1_000;
    const cache = new InMemorySessionCache({ now: () => now });
    const entry = makeEntry('t-a', 'sess-1', 1_500);
    await cache.set('key-1', entry);
    expect(await cache.get('key-1')).toBe(entry);
    now = 1_500; // at expiresAt: treat as expired.
    expect(await cache.get('key-1')).toBeNull();
    // Idempotent eviction:
    expect(await cache.get('key-1')).toBeNull();
  });

  it('set replaces an existing entry and updates the session index', async () => {
    const cache = new InMemorySessionCache({ now: () => 0 });
    const a = makeEntry('t-a', 'sess-1', 10_000);
    const b = makeEntry('t-a', 'sess-2', 10_000);
    await cache.set('key-1', a);
    await cache.set('key-1', b);
    expect(await cache.get('key-1')).toBe(b);

    // sess-1's index bucket is gone, so deleteBySessionId('sess-1') is a no-op.
    await cache.deleteBySessionId('t-a', 'sess-1');
    expect(await cache.get('key-1')).toBe(b);

    // sess-2 still indexed, so deleting by session id evicts it.
    await cache.deleteBySessionId('t-a', 'sess-2');
    expect(await cache.get('key-1')).toBeNull();
  });

  it('deleteBySessionId evicts every cache key bound to that session', async () => {
    const cache = new InMemorySessionCache({ now: () => 0 });
    const shared = makeEntry('t-a', 'sess-shared', 10_000);
    // Same session cached under two different credential fingerprints
    // (cookie + bearer, say) — both must be evicted on revoke.
    await cache.set('key-cookie', shared);
    await cache.set('key-bearer', shared);

    await cache.deleteBySessionId('t-a', 'sess-shared');
    expect(await cache.get('key-cookie')).toBeNull();
    expect(await cache.get('key-bearer')).toBeNull();
  });

  it('tenant scoping: deleteBySessionId for the wrong tenant does not evict', async () => {
    const cache = new InMemorySessionCache({ now: () => 0 });
    const entry = makeEntry('t-a', 'sess-1', 10_000);
    await cache.set('key-1', entry);

    await cache.deleteBySessionId('t-b', 'sess-1');
    expect(await cache.get('key-1')).toBe(entry);

    await cache.deleteBySessionId('t-a', 'sess-1');
    expect(await cache.get('key-1')).toBeNull();
  });

  it('delete(key) removes the entry and the index entry', async () => {
    const cache = new InMemorySessionCache({ now: () => 0 });
    const entry = makeEntry('t-a', 'sess-1', 10_000);
    await cache.set('key-1', entry);

    await cache.delete('key-1');
    expect(await cache.get('key-1')).toBeNull();

    // Subsequent deleteBySessionId must also be a no-op (index cleaned up).
    await cache.deleteBySessionId('t-a', 'sess-1');
  });

  it('evicts the least-recently-used entry when maxEntries is exceeded', async () => {
    const cache = new InMemorySessionCache({ maxEntries: 2, now: () => 0 });
    const a = makeEntry('t', 'sess-a', 10_000);
    const b = makeEntry('t', 'sess-b', 10_000);
    const c = makeEntry('t', 'sess-c', 10_000);

    await cache.set('key-a', a);
    await cache.set('key-b', b);
    // Touch key-a to make key-b the LRU victim.
    await cache.get('key-a');
    await cache.set('key-c', c);

    expect(await cache.get('key-a')).toBe(a);
    expect(await cache.get('key-b')).toBeNull();
    expect(await cache.get('key-c')).toBe(c);
  });
});
