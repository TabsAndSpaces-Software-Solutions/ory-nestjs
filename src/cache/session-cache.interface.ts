/**
 * `SessionCache` — pluggable hot-path cache for resolved sessions.
 *
 * Motivation
 * ----------
 * Without a cache, every authenticated request costs a round-trip to Kratos
 * (`toSession`). In a high-traffic deployment this is both a latency tax on
 * every request and a capacity tax on the Ory instance.
 *
 * Design contract
 * ---------------
 *   - Async everywhere: even the in-memory default returns Promises, so a
 *     Redis-backed implementation can be substituted with no signature
 *     churn at call sites.
 *   - Library-DTO-only: entries carry `IamIdentity` + `IamSession`; no
 *     `@ory/*` types cross this boundary, preserving the zero-Ory-leakage
 *     contract for cache backends.
 *   - Fail-open is a caller responsibility: callers (the caching transport
 *     and `SessionService.revoke`) log and bypass on cache errors so a
 *     Redis outage cannot lock users out. Implementations should still
 *     throw meaningful errors rather than swallowing them — the caller
 *     picks the policy.
 *   - Tenant isolation is a caller responsibility: the cache key is opaque
 *     to the implementation; callers must include the tenant in the key
 *     before passing it to `get` / `set`.
 *
 * Invalidation
 * ------------
 * `deleteBySessionId(tenant, sessionId)` is invoked when a session is
 * revoked through `SessionService.revoke`. Implementations that can index
 * entries by `(tenant, sessionId)` should evict synchronously; implementations
 * that cannot (e.g. a naive KV without secondary indexes) may either maintain
 * their own index or accept eventual consistency bounded by `sessionTtlMs`.
 * The `NoopSessionCache` treats this as a no-op.
 */
import type { TenantName, IamIdentity, IamSession } from '../dto';

export interface SessionCacheEntry {
  readonly identity: IamIdentity;
  readonly session: IamSession;
  /** Absolute epoch-ms at which this entry must be treated as expired. */
  readonly expiresAt: number;
}

export interface SessionCache {
  /**
   * Return the cached entry for `key`, or `null` if absent / expired.
   *
   * Implementations MUST treat any entry whose `expiresAt` is less than or
   * equal to `Date.now()` as absent — the caller should never need to do
   * its own expiry check.
   */
  get(key: string): Promise<SessionCacheEntry | null>;

  /**
   * Store `entry` under `key`. The entry's `expiresAt` is authoritative —
   * implementations use it as the TTL.
   */
  set(key: string, entry: SessionCacheEntry): Promise<void>;

  /**
   * Remove the entry for `key`. Missing keys are a no-op.
   */
  delete(key: string): Promise<void>;

  /**
   * Evict every cached entry bound to `(tenant, sessionId)`. Called by
   * `SessionService.revoke` so a revoked session cannot be served from
   * cache on the next request.
   *
   * Implementations without a secondary index may implement this as a
   * no-op and rely on short `sessionTtlMs` values — but doing so leaves a
   * revocation window, which MUST be documented on the consumer surface.
   */
  deleteBySessionId(tenant: TenantName, sessionId: string): Promise<void>;
}
