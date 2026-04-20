/**
 * Central translator between raw upstream failures and NestJS HTTP exceptions.
 *
 * Design rules:
 *   - The mapper is PURE and stateless. It does not mutate its input and
 *     holds no instance fields.
 *   - Only four library-defined errors feed the HTTP boundary:
 *       IamConfigurationError      -> InternalServerErrorException (500)
 *       IamUnauthorizedError       -> UnauthorizedException        (401)
 *       IamForbiddenError          -> ForbiddenException           (403)
 *       IamUpstreamUnavailableError-> ServiceUnavailableException  (503)
 *   - AxiosError shapes (detected structurally, NOT by importing `axios`)
 *     are first lifted into an IamError subclass and then mapped.
 *   - Unknown errors are rethrown unchanged so NestJS's default filter
 *     produces a generic 500 — we never wrap arbitrary throwables.
 *   - NO upstream payload / headers / config is ever attached to the
 *     IamError message or the Nest exception body. Messages are short and
 *     generic; full context stays in server-side logs only.
 *   - A later interceptor will translate `wwwAuthenticate` and `retryAfter`
 *     payload fields into real HTTP response headers; we expose them as
 *     structured fields on the body for that interceptor to consume.
 */
import {
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

import { IamError } from './iam-error';
import { IamConfigurationError } from './iam-configuration.error';
import { IamUnauthorizedError } from './iam-unauthorized.error';
import { IamForbiddenError } from './iam-forbidden.error';
import { IamUpstreamUnavailableError } from './iam-upstream-unavailable.error';

export interface ErrorMapperContext {
  correlationId?: string;
}

/** Structural subset of an AxiosError — we avoid importing `axios` directly. */
interface AxiosErrorShape {
  isAxiosError?: boolean;
  response?: { status?: number; data?: unknown };
  code?: string;
  message?: string;
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'ERR_NETWORK',
]);

function looksLikeAxiosError(e: unknown): e is AxiosErrorShape {
  if (!e || typeof e !== 'object') return false;
  const candidate = e as Record<string, unknown>;
  if (candidate.isAxiosError === true) return true;
  if (typeof candidate.response === 'object' && candidate.response !== null) {
    return true;
  }
  if (typeof candidate.code === 'string' && NETWORK_CODES.has(candidate.code)) {
    return true;
  }
  return false;
}

export class ErrorMapper {
  // Construction is disallowed — the mapper is a pure static utility with
  // no state. Runtime guard protects against `new (ErrorMapper as any)()`.
  private constructor() {
    throw new Error('ErrorMapper is a static class and cannot be instantiated.');
  }

  /**
   * Translate any thrown value into a NestJS `HttpException`.
   *
   * - `IamError` subclasses map 1:1 by class (never re-derived from status).
   * - AxiosError shapes lift to an `IamError`, then map.
   * - Anything else is rethrown untouched.
   */
  public static toNest(
    err: unknown,
    context?: ErrorMapperContext,
  ): HttpException {
    if (err instanceof IamError) {
      return ErrorMapper.fromIamError(err, context);
    }

    if (looksLikeAxiosError(err)) {
      const lifted = ErrorMapper.fromAxiosError(err, context);
      if (lifted === null) {
        // 4xx we don't recognize (e.g. 418) — rethrow as-is.
        throw err;
      }
      return ErrorMapper.fromIamError(lifted, context);
    }

    // Unknown / raw error — rethrow so Nest's default filter handles it.
    throw err;
  }

  /** Map a library error to its corresponding Nest exception. */
  private static fromIamError(
    err: IamError,
    context: ErrorMapperContext | undefined,
  ): HttpException {
    const correlationId = err.correlationId ?? context?.correlationId;

    if (err instanceof IamUnauthorizedError) {
      return new UnauthorizedException(
        withCorrelation(
          {
            statusCode: 401,
            message: 'Unauthorized',
            wwwAuthenticate: 'Bearer realm="ory-nestjs"',
          },
          correlationId,
        ),
      );
    }

    if (err instanceof IamForbiddenError) {
      return new ForbiddenException(
        withCorrelation(
          { statusCode: 403, message: 'Forbidden' },
          correlationId,
        ),
      );
    }

    if (err instanceof IamUpstreamUnavailableError) {
      return new ServiceUnavailableException(
        withCorrelation(
          {
            statusCode: 503,
            message: 'Service Unavailable',
            retryAfter: 5,
          },
          correlationId,
        ),
      );
    }

    if (err instanceof IamConfigurationError) {
      // Never leak the specific configuration message — it is a programmer
      // error and belongs in server-side logs only.
      return new InternalServerErrorException(
        withCorrelation(
          { statusCode: 500, message: 'Server Error' },
          correlationId,
        ),
      );
    }

    // Defensive fallback — every concrete subclass should be covered above.
    /* istanbul ignore next */
    return new InternalServerErrorException(
      withCorrelation(
        { statusCode: 500, message: 'Server Error' },
        correlationId,
      ),
    );
  }

  /**
   * Lift an AxiosError-shaped value into an IamError subclass. Returns
   * `null` for unrecognized 4xx codes so the caller can rethrow.
   *
   * IMPORTANT: the AxiosError is passed only to the `cause` field — none of
   * its `response.data`, `response.headers`, `config.headers`, or
   * `config.data` is promoted into the IamError message or anywhere else
   * that might be serialized.
   */
  private static fromAxiosError(
    err: AxiosErrorShape,
    context: ErrorMapperContext | undefined,
  ): IamError | null {
    const status = err.response?.status;
    const code = err.code;
    const correlationId = context?.correlationId;

    if (status === 401) {
      return new IamUnauthorizedError({
        message: 'Upstream authentication failure',
        cause: err,
        correlationId,
      });
    }

    if (status === 403) {
      return new IamForbiddenError({
        message: 'Permission denied upstream',
        cause: err,
        correlationId,
      });
    }

    if (status !== undefined && status >= 500) {
      return new IamUpstreamUnavailableError({
        message: 'Upstream IAM dependency unavailable',
        cause: err,
        correlationId,
      });
    }

    // No response (network / timeout / ECONN*) or a known network code.
    if (status === undefined) {
      if (code === undefined || NETWORK_CODES.has(code)) {
        return new IamUpstreamUnavailableError({
          message: 'Upstream IAM dependency unavailable',
          cause: err,
          correlationId,
        });
      }
    }

    // Any other 4xx (e.g. 418) — let the caller rethrow.
    return null;
  }
}

/** Attach `correlationId` to a Nest payload object only when it is defined. */
function withCorrelation<T extends Record<string, unknown>>(
  body: T,
  correlationId: string | undefined,
): T & { correlationId?: string } {
  if (correlationId === undefined) return body;
  return { ...body, correlationId };
}
