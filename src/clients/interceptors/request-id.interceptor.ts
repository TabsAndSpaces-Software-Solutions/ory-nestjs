/**
 * `requestIdInterceptor` — axios REQUEST interceptor that stamps an
 * `x-request-id` header (and optional `traceparent`) onto every outbound
 * request.
 *
 * Strategy:
 *   - If a correlation context exists in `correlationStorage` (an
 *     `AsyncLocalStorage` populated by upstream middleware), propagate its
 *     `correlationId` + `traceparent` onto the outbound headers.
 *   - Otherwise, generate a fresh UUID via `crypto.randomUUID()`.
 *   - Never overwrite an `x-request-id` already set on the outbound config —
 *     direct callers can pin their own id.
 *
 * The interceptor is exported as a plain function `applyRequestId` and as a
 * thin factory `requestIdInterceptor()` returning the same function typed
 * for `axios.interceptors.request.use`.
 */
import { randomUUID } from 'node:crypto';
import type { InternalAxiosRequestConfig } from 'axios';

import { correlationStorage } from '../correlation-storage';

const REQUEST_ID_HEADER = 'x-request-id';
const TRACEPARENT_HEADER = 'traceparent';

/**
 * Mutate `config.headers` to include an `x-request-id`, reading from the
 * ambient `correlationStorage` when available.
 */
export function applyRequestId(
  config: InternalAxiosRequestConfig,
): InternalAxiosRequestConfig {
  // Axios typings for `headers` are a union; at runtime it is always a plain
  // object (AxiosHeaders is also indexable as a record) so we treat it as one.
  const headers = (config.headers ?? {}) as Record<string, unknown>;
  config.headers = headers as InternalAxiosRequestConfig['headers'];

  const ctx = correlationStorage.getStore();
  const existing = headers[REQUEST_ID_HEADER];

  if (typeof existing !== 'string' || existing.length === 0) {
    const id =
      ctx?.correlationId && ctx.correlationId.length > 0
        ? ctx.correlationId
        : randomUUID();
    headers[REQUEST_ID_HEADER] = id;
  }

  if (ctx?.traceparent && typeof headers[TRACEPARENT_HEADER] !== 'string') {
    headers[TRACEPARENT_HEADER] = ctx.traceparent;
  }

  return config;
}

export function requestIdInterceptor(): (
  config: InternalAxiosRequestConfig,
) => InternalAxiosRequestConfig {
  return applyRequestId;
}
