/**
 * `redactErrorInterceptor` — axios RESPONSE-error interceptor that applies
 * the shared `Redactor` to every user-attached field on an AxiosError before
 * it propagates out of the axios promise chain.
 *
 * Scrubs:
 *   - `error.response.data`   (body)
 *   - `error.response.headers`
 *   - `error.config.data`     (outbound body)
 *   - `error.config.headers`  (always overwrites Authorization)
 *
 * The mutation is IN-PLACE: the error object itself is returned (rethrown),
 * not cloned, so upstream `.catch` handlers observe the scrubbed view. The
 * error's prototype chain / other internal axios fields (e.g.
 * `toJSON`, `stack`) are untouched.
 *
 * Non-axios errors are rethrown untouched.
 */
import type { Redactor } from '../../audit';
import { REDACTED } from '../../audit';

interface MutableAxiosErrorShape {
  isAxiosError?: boolean;
  response?: {
    data?: unknown;
    headers?: unknown;
  };
  config?: {
    data?: unknown;
    headers?: unknown;
  };
}

function looksLikeAxiosError(e: unknown): e is MutableAxiosErrorShape {
  if (!e || typeof e !== 'object') return false;
  const candidate = e as { isAxiosError?: unknown };
  return candidate.isAxiosError === true;
}

/**
 * Build the response-error handler used by `axios.interceptors.response.use`.
 * The handler takes the error, mutates user-attached fields through the
 * Redactor, and returns a rejected promise with the same error instance.
 */
export function redactErrorHandler(
  redactor: Redactor,
): (err: unknown) => Promise<never> {
  return (err: unknown): Promise<never> => {
    if (!looksLikeAxiosError(err)) {
      return Promise.reject(err);
    }

    const response = err.response;
    if (response !== undefined) {
      if (response.data !== undefined) {
        response.data = redactor.redact(response.data);
      }
      if (response.headers !== undefined) {
        response.headers = redactor.redact(response.headers);
      }
    }

    const config = err.config;
    if (config !== undefined) {
      if (config.data !== undefined) {
        config.data = redactor.redact(config.data);
      }
      if (config.headers !== undefined) {
        config.headers = redactor.redact(config.headers);
      }
      // Belt-and-braces: forcibly redact Authorization even if the redactor
      // was reconfigured to allow it.
      const cfgHeaders = config.headers as Record<string, unknown> | undefined;
      if (cfgHeaders && 'Authorization' in cfgHeaders) {
        cfgHeaders.Authorization = REDACTED;
      }
      if (cfgHeaders && 'authorization' in cfgHeaders) {
        cfgHeaders.authorization = REDACTED;
      }
    }

    return Promise.reject(err);
  };
}
