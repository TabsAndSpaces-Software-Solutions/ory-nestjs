/**
 * `retry.interceptor` — axios RESPONSE-error interceptor installer that
 * retries idempotent GETs on 5xx / network errors.
 *
 * Design:
 *   - Max 2 retries (3 total attempts).
 *   - Exponential backoff: `baseDelay * 2^attempt` where `attempt` starts at
 *     0 before the first retry (delays: 200, 400 for default 200ms base).
 *   - Retryable conditions (see `isRetryable`):
 *       - Response status >= 500, OR
 *       - `error.code` is one of ECONNRESET / ETIMEDOUT / ECONNREFUSED /
 *         ENOTFOUND / ERR_NETWORK
 *     AND the request method is GET.
 *   - Non-GET methods are never retried (preserves non-idempotent safety).
 *
 * We intentionally avoid the `axios-retry` package — its transitive deps
 * and cadence-of-updates aren't worth it for ~80 lines of focused logic.
 *
 * The `sleep` option is dependency-injected so tests can drive time without
 * using fake timers (which interact badly with axios's internal promise
 * chains).
 */
import type { AxiosError, AxiosInstance, AxiosRequestConfig } from 'axios';

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ENOTFOUND',
  'ERR_NETWORK',
]);

/** Config key we stash on the request config to track attempt count. */
const RETRY_META_KEY = '__orynestjsRetryAttempt' as const;

/** Default baseline retry delay in ms. */
const DEFAULT_BASE_DELAY_MS = 200;
/** Default max retries (beyond the initial attempt). */
const DEFAULT_MAX_RETRIES = 2;

export interface RetryOptions {
  baseDelayMs?: number;
  maxRetries?: number;
  /** Injected sleeper — tests replace this with a no-op. */
  sleep?: (ms: number) => Promise<void>;
}

interface AxiosErrorShape {
  isAxiosError?: boolean;
  response?: { status?: number };
  code?: string;
  config?: AxiosRequestConfig & { [RETRY_META_KEY]?: number };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Determine whether the error shape qualifies as retryable per the policy.
 * Non-GET methods short-circuit to `false`.
 */
export function isRetryable(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as AxiosErrorShape;
  if (e.isAxiosError !== true) return false;

  const method = (e.config?.method ?? 'get').toLowerCase();
  if (method !== 'get') return false;

  const status = e.response?.status;
  if (typeof status === 'number' && status >= 500) return true;

  if (typeof e.code === 'string' && NETWORK_CODES.has(e.code)) return true;

  return false;
}

/**
 * Install the retry handler on an axios instance. Callers compose this with
 * other response interceptors; order matters:
 *   1. `redact-error` should run BEFORE this (first in the response chain)
 *      so that retried errors don't leak through the final rejection with
 *      sensitive data intact.
 *   2. The axios response pipeline runs interceptors in REVERSE registration
 *      order for errors, so register `retry` AFTER `redact-error`.
 *
 * Returns the axios instance for chainable composition.
 */
export function installRetryInterceptor(
  axios: AxiosInstance,
  options: RetryOptions = {},
): AxiosInstance {
  const baseDelay = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const sleep = options.sleep ?? defaultSleep;

  axios.interceptors.response.use(
    (response) => response,
    async (error: unknown) => {
      if (!isRetryable(error)) {
        return Promise.reject(error);
      }
      const err = error as AxiosError & {
        config?: AxiosRequestConfig & { [RETRY_META_KEY]?: number };
      };
      const cfg = err.config;
      if (!cfg) {
        return Promise.reject(error);
      }

      const attempt = cfg[RETRY_META_KEY] ?? 0;
      if (attempt >= maxRetries) {
        return Promise.reject(error);
      }

      cfg[RETRY_META_KEY] = attempt + 1;
      const delay = baseDelay * Math.pow(2, attempt);
      await sleep(delay);

      // Re-dispatch via the same axios instance so the request goes through
      // all request interceptors (request-id etc.) again.
      return axios.request(cfg);
    },
  );

  return axios;
}
