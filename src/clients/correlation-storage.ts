/**
 * Shared `AsyncLocalStorage` instance used by the client layer to propagate
 * per-request correlation metadata (request-id, traceparent) across async
 * boundaries.
 *
 * The request-id interceptor reads from this store and falls back to
 * `crypto.randomUUID()` if the caller hasn't established a correlation
 * context. Consumers populate the store in a middleware early in the
 * NestJS pipeline (units that own that middleware land later).
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface CorrelationContext {
  correlationId?: string;
  traceparent?: string;
}

export const correlationStorage = new AsyncLocalStorage<CorrelationContext>();
