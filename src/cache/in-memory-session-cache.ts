/**
 * `InMemorySessionCache` — single-process LRU + TTL session cache.
 *
 * WHEN TO USE
 * -----------
 * Single-instance deployments (local dev, integration tests, small
 * single-pod services). For multi-pod production deployments use a shared
 * backend (Redis, Memcached) — a per-pod in-memory cache serves stale
 * entries after a revocation propagates to the Ory instance but not to
 * sibling pods.
 *
 * BEHAVIOR
 * --------
 *   - Bounded by `maxEntries` (default 10_000). When full, the oldest-
 *     inserted entry is evicted. `Map` iteration order is insertion order,
 *     so `.keys().next()` gives us the oldest entry in O(1); combined with
 *     `delete` + `set` on access, this yields a simple LRU.
 *   - Expiry is lazy: entries are checked on `get` and evicted if past
 *     `expiresAt`. No timers.
 *   - Secondary index keyed by `"${tenant}|${sessionId}"` → `Set<cacheKey>`
 *     so `deleteBySessionId` is O(1) amortized (one set lookup + a small
 *     number of map deletes).
 *
 * THREAD-SAFETY
 * -------------
 * Node is single-threaded per process; no locking is required for the
 * operations above — each async method runs to completion before the next
 * microtask.
 */
import type { TenantName } from '../dto';
import type { SessionCache, SessionCacheEntry } from './session-cache.interface';

export interface InMemorySessionCacheOptions {
  /** Maximum number of entries before LRU eviction kicks in. */
  readonly maxEntries?: number;
  /**
   * Clock override for deterministic tests. Defaults to `Date.now`.
   */
  readonly now?: () => number;
}

const DEFAULT_MAX_ENTRIES = 10_000;

function sessionIndexKey(tenant: TenantName, sessionId: string): string {
  return `${tenant}|${sessionId}`;
}

export class InMemorySessionCache implements SessionCache {
  private readonly entries = new Map<string, SessionCacheEntry>();
  private readonly sessionIndex = new Map<string, Set<string>>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  public constructor(options: InMemorySessionCacheOptions = {}) {
    this.maxEntries =
      options.maxEntries !== undefined && options.maxEntries > 0
        ? options.maxEntries
        : DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
  }

  public async get(key: string): Promise<SessionCacheEntry | null> {
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt <= this.now()) {
      this.evict(key, entry);
      return null;
    }
    // LRU touch: re-insert so `keys().next()` evicts truly-cold entries first.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  public async set(key: string, entry: SessionCacheEntry): Promise<void> {
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      this.removeFromSessionIndex(existing.session.tenant, existing.session.id, key);
    }
    this.entries.set(key, entry);
    this.addToSessionIndex(entry.session.tenant, entry.session.id, key);
    this.enforceCapacity();
  }

  public async delete(key: string): Promise<void> {
    const existing = this.entries.get(key);
    if (existing === undefined) return;
    this.evict(key, existing);
  }

  public async deleteBySessionId(
    tenant: TenantName,
    sessionId: string,
  ): Promise<void> {
    const idx = sessionIndexKey(tenant, sessionId);
    const keys = this.sessionIndex.get(idx);
    if (keys === undefined) return;
    for (const cacheKey of keys) {
      this.entries.delete(cacheKey);
    }
    this.sessionIndex.delete(idx);
  }

  private evict(key: string, entry: SessionCacheEntry): void {
    this.entries.delete(key);
    this.removeFromSessionIndex(entry.session.tenant, entry.session.id, key);
  }

  private enforceCapacity(): void {
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) return;
      const oldestEntry = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      if (oldestEntry !== undefined) {
        this.removeFromSessionIndex(
          oldestEntry.session.tenant,
          oldestEntry.session.id,
          oldestKey,
        );
      }
    }
  }

  private addToSessionIndex(
    tenant: TenantName,
    sessionId: string,
    cacheKey: string,
  ): void {
    const idx = sessionIndexKey(tenant, sessionId);
    const bucket = this.sessionIndex.get(idx);
    if (bucket === undefined) {
      this.sessionIndex.set(idx, new Set([cacheKey]));
      return;
    }
    bucket.add(cacheKey);
  }

  private removeFromSessionIndex(
    tenant: TenantName,
    sessionId: string,
    cacheKey: string,
  ): void {
    const idx = sessionIndexKey(tenant, sessionId);
    const bucket = this.sessionIndex.get(idx);
    if (bucket === undefined) return;
    bucket.delete(cacheKey);
    if (bucket.size === 0) this.sessionIndex.delete(idx);
  }
}
