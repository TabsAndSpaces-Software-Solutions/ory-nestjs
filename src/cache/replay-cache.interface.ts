/**
 * `ReplayCache` — short-lived store of consumed envelope/JWT `jti` values,
 * used by `OathkeeperTransport` to reject replayed tokens within their
 * validity window.
 *
 * Contract:
 *   - `seen(jti)` returns `true` iff this `jti` has been passed to
 *     `remember()` within the remembered TTL. Implementations MUST be
 *     atomic with respect to concurrent `remember()` calls: two parallel
 *     requests presenting the same `jti` must see at most one `false`
 *     result across both. The default in-memory implementation achieves
 *     this in a single process; multi-pod deployments must plug in a
 *     Redis-backed (or similar) implementation that shares state.
 *   - `remember(jti, ttlMs)` persists `jti` until at least
 *     `Date.now() + ttlMs` has elapsed; storage may evict earlier only
 *     if the key is cold LRU and the cache is at capacity. Evicting an
 *     unexpired `jti` lets a replay slip through — the default in-memory
 *     cache therefore bounds capacity at a high watermark and warns.
 *   - Implementations MUST fail closed: if the backend is unreachable,
 *     `seen()` should throw. The transport translates that into a 503
 *     rather than allowing the request.
 *
 * Why this is separate from `SessionCache`:
 *   - Semantics differ — `SessionCache` is negative-result-tolerant and
 *     may fall back to the origin. A replay cache has no origin to fall
 *     back to; a miss means "not seen", nothing else.
 *   - Backends differ in practice — session caches are often big LRU
 *     stores; replay caches want a short TTL and a small footprint.
 */
export interface ReplayCache {
  /** Returns true iff `jti` was remembered within its TTL. */
  seen(jti: string): Promise<boolean>;
  /** Persist `jti` until at least now + `ttlMs`. */
  remember(jti: string, ttlMs: number): Promise<void>;
}

/** DI token for `ReplayCache` bindings. */
export const REPLAY_CACHE: unique symbol = Symbol.for('ory-nestjs/replay-cache');
