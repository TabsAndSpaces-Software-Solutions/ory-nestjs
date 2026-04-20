import { IamError, IamErrorInit } from './iam-error';

/**
 * Raised when upstream IAM rejects the session/credential as invalid
 * (401-class failure). Mapped to a NestJS `UnauthorizedException` at the
 * HTTP boundary.
 */
export class IamUnauthorizedError extends IamError {
  public static readonly CODE = 'IAM_UNAUTHORIZED';

  constructor(init: IamErrorInit) {
    super(init, IamUnauthorizedError.CODE, 'IamUnauthorizedError');
  }
}
