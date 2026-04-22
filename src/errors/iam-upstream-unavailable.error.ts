import { IamError, IamErrorInit } from './iam-error';

export interface IamUpstreamUnavailableInit extends IamErrorInit {
  /**
   * Optional seconds hint the HTTP boundary forwards as `Retry-After`. When
   * omitted the mapper uses a sensible default. Set from interceptors (rate
   * limiter, circuit breaker) that know exactly when the next attempt will
   * succeed.
   */
  retryAfter?: number;
}

/**
 * Raised when the upstream IAM dependency is unreachable or failing
 * (5xx, timeout, ECONNREFUSED, ENOTFOUND, network errors). Mapped to a
 * NestJS `ServiceUnavailableException` (503) with a `Retry-After` hint at
 * the HTTP boundary.
 */
export class IamUpstreamUnavailableError extends IamError {
  public static readonly CODE = 'IAM_UPSTREAM_UNAVAILABLE';
  public readonly retryAfter?: number;

  constructor(init: IamUpstreamUnavailableInit) {
    super(init, IamUpstreamUnavailableError.CODE, 'IamUpstreamUnavailableError');
    this.retryAfter = init.retryAfter;
  }
}
