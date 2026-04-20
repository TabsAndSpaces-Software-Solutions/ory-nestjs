import { IamError, IamErrorInit } from './iam-error';

/**
 * Raised for programmer/configuration errors (missing env, malformed options,
 * unreachable branches). At the HTTP boundary, these are mapped to 500 with
 * a generic message — the specific details must remain server-side only.
 */
export class IamConfigurationError extends IamError {
  public static readonly CODE = 'IAM_CONFIGURATION';

  constructor(init: IamErrorInit) {
    super(init, IamConfigurationError.CODE, 'IamConfigurationError');
  }
}
