/**
 * `CachingSessionTransport` — a `SessionTransport` decorator that serves
 * resolved sessions from a pluggable `SessionCache` when available, and
 * falls through to the wrapped inner transport on miss / expiry.
 *
 * CONTRACT
 * --------
 *   - `resolve`:
 *       1. Ask the inner transport for a `credentialFingerprint`. If the
 *          inner transport does not implement it, or returns `null`, skip
 *          the cache entirely and delegate to `inner.resolve`. A missing
 *          fingerprint means either "no credential present" (so the inner
 *          will also return null) or "this transport opts out of caching"
 *          (e.g. OathkeeperTransport).
 *       2. Compute the cache key `${tenant}:${fingerprint}` and call
 *          `cache.get`. On a hit, return a `ResolvedSession` marked
 *          `fromCache: true` with a zero-ish `latencyMs` (we measure just
 *          the cache lookup, not a synthetic upstream value).
 *       3. On a miss, call `inner.resolve`. If that returns a session,
 *          compute the entry TTL (see below) and `cache.set` it before
 *          returning the result.
 *
 *   - `credentialFingerprint`: pass through to the inner transport so the
 *     decorator remains composable (e.g. wrapped by yet-another decorator
 *     for logging). Preserves optionality.
 *
 * FAIL-OPEN
 * ---------
 * ANY error thrown by the cache is logged at WARN level and the call
 * degrades to a direct `inner.resolve`. A Redis outage must not surface as
 * a 401 or 500 — the library continues to authenticate against Kratos
 * directly. This is a deliberate availability-over-throughput trade-off:
 * losing the cache costs latency, not correctness.
 *
 * TTL COMPUTATION
 * ---------------
 * An entry's `expiresAt` is the earlier of:
 *   - `now + sessionTtlMs` — the per-tenant cap configured at boot, and
 *   - the session's own `expiresAt` (ISO 8601 parsed to epoch-ms).
 *
 * If the session's `expiresAt` is already past `now + 1s`, we refuse to
 * cache — no point storing an entry that the `InMemorySessionCache.get`
 * check will reject on the next lookup. Invalid / missing timestamps fall
 * through to `sessionTtlMs`.
 */
import { Logger } from '@nestjs/common';

import type { SessionCache } from '../cache';
import type { ValidatedTenantConfig } from '../config';
import type { TenantClients } from '../clients';
import type { TenantName } from '../dto';
import type {
  RequestLike,
  ResolvedSession,
  SessionTransport,
} from './session-transport.interface';

export interface CachingSessionTransportOptions {
  /** Maximum cache TTL in ms for an entry. Must be > 0. */
  readonly sessionTtlMs: number;
  /** Clock override for deterministic tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

export class CachingSessionTransport implements SessionTransport {
  private readonly logger = new Logger('OryNestjs:CachingSessionTransport');
  private readonly inner: SessionTransport;
  private readonly cache: SessionCache;
  private readonly sessionTtlMs: number;
  private readonly now: () => number;

  public constructor(
    inner: SessionTransport,
    cache: SessionCache,
    options: CachingSessionTransportOptions,
  ) {
    if (!(options.sessionTtlMs > 0)) {
      throw new Error(
        'CachingSessionTransport requires sessionTtlMs > 0. ' +
          'TransportFactory must not wrap the inner transport when caching is disabled.',
      );
    }
    this.inner = inner;
    this.cache = cache;
    this.sessionTtlMs = options.sessionTtlMs;
    this.now = options.now ?? Date.now;
  }

  public async resolve(
    req: RequestLike,
    tenant: TenantClients,
    tenantName: TenantName,
    tenantConfig: ValidatedTenantConfig,
  ): Promise<ResolvedSession | null> {
    const fingerprint = this.safeFingerprint(req, tenantConfig);
    if (fingerprint === null) {
      return this.inner.resolve(req, tenant, tenantName, tenantConfig);
    }
    const key = cacheKey(tenantName, fingerprint);

    const lookupStart = this.now();
    let cached: Awaited<ReturnType<SessionCache['get']>>;
    try {
      cached = await this.cache.get(key);
    } catch (err) {
      this.warnCacheFailure('get', err);
      return this.inner.resolve(req, tenant, tenantName, tenantConfig);
    }
    if (cached !== null) {
      const latencyMs = Math.max(0, this.now() - lookupStart);
      return {
        identity: cached.identity,
        session: cached.session,
        latencyMs,
        fromCache: true,
      };
    }

    const fresh = await this.inner.resolve(req, tenant, tenantName, tenantConfig);
    if (fresh === null) return null;

    const expiresAt = this.computeExpiresAt(fresh);
    if (expiresAt !== null) {
      try {
        await this.cache.set(key, {
          identity: fresh.identity,
          session: fresh.session,
          expiresAt,
        });
      } catch (err) {
        this.warnCacheFailure('set', err);
      }
    }
    return { ...fresh, fromCache: false };
  }

  public credentialFingerprint(
    req: RequestLike,
    tenantConfig: ValidatedTenantConfig,
  ): string | null {
    return this.safeFingerprint(req, tenantConfig);
  }

  private safeFingerprint(
    req: RequestLike,
    tenantConfig: ValidatedTenantConfig,
  ): string | null {
    if (this.inner.credentialFingerprint === undefined) return null;
    try {
      return this.inner.credentialFingerprint(req, tenantConfig);
    } catch (err) {
      this.warnCacheFailure('fingerprint', err);
      return null;
    }
  }

  private computeExpiresAt(resolved: ResolvedSession): number | null {
    const now = this.now();
    const cap = now + this.sessionTtlMs;
    const sessionExp = Date.parse(resolved.session.expiresAt);
    if (Number.isNaN(sessionExp)) return cap;
    // Refuse to cache sessions expiring in less than a second — the next
    // request would just evict on read.
    if (sessionExp <= now + 1000) return null;
    return Math.min(cap, sessionExp);
  }

  private warnCacheFailure(op: 'get' | 'set' | 'fingerprint', err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.logger.warn(
      `session cache ${op} failed; falling through to upstream: ${message}`,
    );
  }
}

function cacheKey(tenant: TenantName, fingerprint: string): string {
  return `${tenant}:${fingerprint}`;
}
