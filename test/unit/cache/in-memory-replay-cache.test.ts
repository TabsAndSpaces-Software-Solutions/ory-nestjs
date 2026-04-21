/**
 * Unit tests for InMemoryReplayCache — the default backing used by
 * OathkeeperTransport's replay-protection path in single-process deployments.
 */
import { InMemoryReplayCache } from '../../../src/cache/in-memory-replay-cache';

describe('InMemoryReplayCache', () => {
  it('reports unseen jtis as false', async () => {
    const cache = new InMemoryReplayCache();
    expect(await cache.seen('jti-1')).toBe(false);
  });

  it('reports a remembered jti as true within the TTL', async () => {
    const cache = new InMemoryReplayCache();
    await cache.remember('jti-1', 60_000);
    expect(await cache.seen('jti-1')).toBe(true);
  });

  it('expires entries after the TTL elapses', async () => {
    jest.useFakeTimers();
    try {
      const cache = new InMemoryReplayCache();
      await cache.remember('jti-expire', 500);
      expect(await cache.seen('jti-expire')).toBe(true);
      jest.advanceTimersByTime(501);
      expect(await cache.seen('jti-expire')).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('evicts the oldest entry when capacity is exceeded', async () => {
    const cache = new InMemoryReplayCache({ maxSize: 2 });
    await cache.remember('a', 60_000);
    await cache.remember('b', 60_000);
    await cache.remember('c', 60_000);
    expect(await cache.seen('a')).toBe(false); // evicted
    expect(await cache.seen('b')).toBe(true);
    expect(await cache.seen('c')).toBe(true);
  });

  it('re-inserting a jti refreshes its LRU position', async () => {
    const cache = new InMemoryReplayCache({ maxSize: 2 });
    await cache.remember('a', 60_000);
    await cache.remember('b', 60_000);
    // Re-touch 'a' — should move it to the tail.
    await cache.remember('a', 60_000);
    await cache.remember('c', 60_000);
    // 'b' was oldest after the re-touch, so it gets evicted; 'a' + 'c' stay.
    expect(await cache.seen('b')).toBe(false);
    expect(await cache.seen('a')).toBe(true);
    expect(await cache.seen('c')).toBe(true);
  });
});
