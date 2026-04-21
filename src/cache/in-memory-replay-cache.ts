/**
 * `InMemoryReplayCache` — single-process LRU backing for `ReplayCache`.
 *
 * Suitable for:
 *   - Single-pod / dev deployments.
 *   - Test harnesses.
 *
 * NOT suitable for multi-pod deployments: a `jti` remembered by pod A is
 * invisible to pod B, so an attacker can replay the token once per pod
 * within its TTL. Wire a Redis-backed implementation via the `REPLAY_CACHE`
 * DI token for production.
 *
 * Implementation notes:
 *   - Backing store is a native `Map` — insertion order ≈ LRU; the oldest
 *     untouched entries are evicted when capacity is exceeded.
 *   - Expiry is recorded as absolute epoch-ms; `seen()` lazily sweeps a
 *     single expired head entry per call so long-idle caches don't grow
 *     unboundedly.
 *   - When `remember()` would push the size over `maxSize`, the oldest
 *     entry is evicted immediately — even if not yet expired. If that
 *     happens often in production, raise `maxSize` or switch to Redis;
 *     evicting a live `jti` is a window in which a replay could slip
 *     through.
 */
import type { ReplayCache } from './replay-cache.interface';

export interface InMemoryReplayCacheOptions {
  /** Upper bound on remembered entries. Default 100_000. */
  maxSize?: number;
}

export class InMemoryReplayCache implements ReplayCache {
  private readonly store = new Map<string, number>();
  private readonly maxSize: number;

  public constructor(opts: InMemoryReplayCacheOptions = {}) {
    this.maxSize = opts.maxSize ?? 100_000;
  }

  public async seen(jti: string): Promise<boolean> {
    const expiresAt = this.store.get(jti);
    if (expiresAt === undefined) return false;
    if (expiresAt <= Date.now()) {
      this.store.delete(jti);
      return false;
    }
    return true;
  }

  public async remember(jti: string, ttlMs: number): Promise<void> {
    const expiresAt = Date.now() + ttlMs;
    // Refresh LRU position: delete first so re-insert moves the entry to
    // the tail of the iteration order.
    this.store.delete(jti);
    this.store.set(jti, expiresAt);
    if (this.store.size > this.maxSize) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) this.store.delete(oldestKey);
    }
  }

  /** Test-only — clears all entries. */
  public clear(): void {
    this.store.clear();
  }
}
