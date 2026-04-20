/**
 * Public barrel for the session cache unit.
 *
 * Re-exported from `src/index.ts` so consumers can:
 *   - implement a custom `SessionCache` (e.g. Redis-backed),
 *   - use `InMemorySessionCache` for single-process deployments,
 *   - wire a backend via the `SESSION_CACHE` DI token when they prefer
 *     NestJS-native provider registration.
 *
 * The caching transport decorator itself lives under `src/transport/` (it
 * implements `SessionTransport`) — it is NOT re-exported from this barrel
 * because it is internal wiring. Consumers only see the cache interface
 * and backends.
 */
export type {
  SessionCache,
  SessionCacheEntry,
} from './session-cache.interface';
export { NoopSessionCache } from './noop-session-cache';
export {
  InMemorySessionCache,
  type InMemorySessionCacheOptions,
} from './in-memory-session-cache';
export { SESSION_CACHE } from './tokens';
