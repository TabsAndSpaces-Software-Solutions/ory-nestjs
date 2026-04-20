import { IamError, IamErrorInit } from './iam-error';

/**
 * Raised when the upstream IAM dependency is unreachable or failing
 * (5xx, timeout, ECONNREFUSED, ENOTFOUND, network errors). Mapped to a
 * NestJS `ServiceUnavailableException` (503) with a `Retry-After` hint at
 * the HTTP boundary.
 */
export class IamUpstreamUnavailableError extends IamError {
  public static readonly CODE = 'IAM_UPSTREAM_UNAVAILABLE';

  constructor(init: IamErrorInit) {
    super(init, IamUpstreamUnavailableError.CODE, 'IamUpstreamUnavailableError');
  }
}
