/**
 * INTERNAL barrel for the transport adapter layer.
 *
 * Exposes the `SessionTransport` interface, the four concrete transports,
 * and the `TransportFactory`. This barrel is consumed by guards (which
 * live outside the adapter layer) — but it is NEVER re-exported from
 * `src/index.ts`, preserving the zero-Ory-leakage public surface.
 */
export type {
  RequestLike,
  ResolvedSession,
  SessionTransport,
} from './session-transport.interface';
export { CookieTransport } from './cookie.transport';
export { BearerTransport } from './bearer.transport';
export { CookieOrBearerTransport } from './cookie-or-bearer.transport';
export { OathkeeperTransport } from './oathkeeper.transport';
export {
  CachingSessionTransport,
  type CachingSessionTransportOptions,
} from './caching-session.transport';
export { TransportFactory } from './transport.factory';
export { extractCookie } from './cookie-parse';
export { verifyEnvelopeSignature } from './signature-verify';
export type { SignatureVerificationResult } from './signature-verify';
