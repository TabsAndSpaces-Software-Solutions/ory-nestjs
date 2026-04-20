/**
 * `NoopSessionCache` — the default backend when `cache.sessionTtlMs` is zero
 * (the schema default) or a caller explicitly wants to disable caching.
 *
 * Every operation resolves without side effects. The `CachingSessionTransport`
 * detects this by the `sessionTtlMs === 0` check at factory time and skips
 * wrapping the inner transport entirely — so this class is only instantiated
 * when a deployment explicitly requests caching but elects a no-op backend
 * (useful for feature-flag rollouts that keep the wiring live without
 * serving from cache yet).
 */
import type { TenantName } from '../dto';
import type { SessionCache, SessionCacheEntry } from './session-cache.interface';

export class NoopSessionCache implements SessionCache {
  public async get(_key: string): Promise<SessionCacheEntry | null> {
    return null;
  }

  public async set(_key: string, _entry: SessionCacheEntry): Promise<void> {
    return;
  }

  public async delete(_key: string): Promise<void> {
    return;
  }

  public async deleteBySessionId(
    _tenant: TenantName,
    _sessionId: string,
  ): Promise<void> {
    return;
  }
}
