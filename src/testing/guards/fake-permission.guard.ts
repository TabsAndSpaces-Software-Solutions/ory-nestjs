/**
 * `FakePermissionGuard` — test-only replacement for `PermissionGuard`.
 *
 * Behaviour:
 *   - Reads every `@RequirePermission(...)` spec on the handler + class
 *     (`getAllAndOverride` surfaces the nearest single spec; the real guard
 *     also supports arrays — so does this stub).
 *   - Resolves the `object` literal or `(req) => string | undefined`.
 *   - Builds the canonical key `namespace:relation:object` and looks it up
 *     in the shared `TestingState.permissions` map.
 *     - Hit & `true`        → allow.
 *     - Hit & `false`       → ForbiddenException.
 *     - Miss (default-deny) → ForbiddenException.
 *   - If the resolver returns a non-string / empty string, throw a
 *     `BadRequestException` — matches the production guard's error shape
 *     for "resource id missing from the URL".
 */
import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { REQUIRED_PERMISSION_KEY } from '../../decorators/metadata-keys';
import type { RequirePermissionSpec } from '../../decorators/require-permission.decorator';
import {
  TESTING_STATE,
  TestingState,
  permissionKey,
} from '../testing-state';

function asSpecArray(
  raw: RequirePermissionSpec | readonly RequirePermissionSpec[] | undefined,
): RequirePermissionSpec[] {
  if (raw === undefined) return [];
  if (Array.isArray(raw)) return [...raw];
  return [raw as RequirePermissionSpec];
}

@Injectable()
export class FakePermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(TESTING_STATE) private readonly state: TestingState,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const raw = this.reflector.getAllAndOverride<
      RequirePermissionSpec | RequirePermissionSpec[] | undefined
    >(REQUIRED_PERMISSION_KEY, [ctx.getHandler(), ctx.getClass()]);
    const specs = asSpecArray(raw);
    if (specs.length === 0) return true;

    const req = ctx.switchToHttp().getRequest<unknown>();

    for (const spec of specs) {
      const objectValue =
        typeof spec.object === 'function' ? spec.object(req) : spec.object;
      if (typeof objectValue !== 'string' || objectValue.length === 0) {
        throw new BadRequestException(
          'required permission object could not be resolved from request',
        );
      }
      const key = permissionKey(spec.namespace, spec.relation, objectValue);
      const allowed = this.state.permissions.get(key);
      if (allowed !== true) {
        throw new ForbiddenException({
          statusCode: 403,
          message: 'permission denied',
        });
      }
    }

    return true;
  }
}
