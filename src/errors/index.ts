/**
 * Errors barrel — re-exports the full ory-nestjs error hierarchy and the
 * central `ErrorMapper` that translates library errors (and raw Axios/network
 * failures) into NestJS `HttpException`s.
 *
 * Everything exported here is safe for the public surface: no `@ory/*`
 * types cross this boundary.
 */
export { IamError } from './iam-error';
export type { IamErrorInit, IamErrorJson } from './iam-error';
export { IamConfigurationError } from './iam-configuration.error';
export { IamUnauthorizedError } from './iam-unauthorized.error';
export { IamForbiddenError } from './iam-forbidden.error';
export { IamUpstreamUnavailableError } from './iam-upstream-unavailable.error';
export { ErrorMapper } from './error-mapper';
export type { ErrorMapperContext } from './error-mapper';
