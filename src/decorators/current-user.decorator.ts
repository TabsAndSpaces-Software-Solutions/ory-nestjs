/**
 * `@CurrentUser()` — parameter decorator that injects `req.user` into a
 * handler argument.
 *
 * Guards (later units) populate `req.user` with either a `IamIdentity`
 * (sanitized, no traits) or a `IamMachinePrincipal`. On routes annotated
 * with `@Public()` or `@Anonymous()`, `req.user` may be `undefined` —
 * handlers should type the parameter accordingly.
 *
 * No transformation is performed here: the guard is the single point where
 * a principal is built, and the decorator is a pure passthrough so the
 * consumer can apply their own narrowing (e.g. via `isMachinePrincipal` /
 * `isUserPrincipal` from `ory-nestjs`).
 *
 * Return type for handler parameters:
 *   `IamIdentity | IamMachinePrincipal | undefined`
 */
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

import type { IamIdentity, IamMachinePrincipal } from '../dto';

/** Runtime shape the factory returns; documented for handler authors. */
export type CurrentUserValue =
  | IamIdentity
  | IamMachinePrincipal
  | undefined;

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CurrentUserValue => {
    const req = ctx.switchToHttp().getRequest<{ user?: CurrentUserValue }>();
    return req.user;
  },
);
