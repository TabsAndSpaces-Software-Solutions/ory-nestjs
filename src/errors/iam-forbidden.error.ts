import { IamError, IamErrorInit } from './iam-error';

/**
 * Raised when upstream IAM authenticates the caller but denies access
 * (403-class failure). Mapped to a NestJS `ForbiddenException` at the HTTP
 * boundary.
 */
export class IamForbiddenError extends IamError {
  public static readonly CODE = 'IAM_FORBIDDEN';

  constructor(init: IamErrorInit) {
    super(init, IamForbiddenError.CODE, 'IamForbiddenError');
  }
}
