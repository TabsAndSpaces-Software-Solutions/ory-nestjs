/**
 * `FakeSessionGuard` — test-only replacement for `SessionGuard`.
 *
 * Behaviour:
 *   - `@Public()` / `@Anonymous()` routes short-circuit to `true`.
 *   - When a fixture identity is present on the shared `TestingState`,
 *     attach it to `req.user` and allow.
 *   - When no fixture is present and the route is not `@Public()` /
 *     `@Anonymous()`, throw `UnauthorizedException` → 401.
 *
 * Zero Ory imports, zero network I/O.
 */
import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import {
  IS_ANONYMOUS_KEY,
  IS_PUBLIC_KEY,
} from '../../decorators/metadata-keys';
import { TESTING_STATE, TestingState } from '../testing-state';

interface MutableRequest {
  user?: unknown;
  session?: unknown;
}

@Injectable()
export class FakeSessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(TESTING_STATE) private readonly state: TestingState,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const handler = ctx.getHandler();
    const controller = ctx.getClass();

    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(
      IS_PUBLIC_KEY,
      [handler, controller],
    );
    if (isPublic === true) return true;

    const isAnon = this.reflector.getAllAndOverride<boolean | undefined>(
      IS_ANONYMOUS_KEY,
      [handler, controller],
    );
    if (isAnon === true) return true;

    if (this.state.identity === undefined) {
      throw new UnauthorizedException({
        statusCode: 401,
        message: 'Unauthorized',
      });
    }

    const req = ctx.switchToHttp().getRequest<MutableRequest>();
    req.user = this.state.identity;
    return true;
  }
}
