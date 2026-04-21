/**
 * `RoleGuard` — enforces `@RequireRole(...roles)` with OR semantics against
 * the authenticated principal already attached to the request.
 *
 * Ordering contract:
 *   - Intended to run AFTER `SessionGuard` has populated `req.user`. When no
 *     principal is present but the route carries `@RequireRole(...)`, the
 *     guard fails fast with `IamUnauthorizedError` (defense-in-depth).
 *   - Composes with `PermissionGuard` under NestJS `@UseGuards()` order as
 *     AND — each guard must permit the request independently.
 *
 * Role extraction precedence (user principal):
 *   1. `user.metadataPublic.roles` — admin-set, trusted claim.
 *   2. `user.traits.roles` — self-service claim, lower trust.
 * If both are present, `metadataPublic.roles` wins outright. The precedence
 * is intentional: metadata_public is the admin-controlled channel; traits
 * is a user-editable surface and MUST NOT override admin claims.
 *
 * Role extraction for `IamMachinePrincipal`:
 *   A machine principal has no `traits`/`metadataPublic`. Each element of
 *   `principal.scope` is treated as a role name — the OAuth2 client's
 *   granted scopes act as its role set. Example:
 *     scope = ['read:listings']
 *     @RequireRole('read:listings') → allow
 *
 * Denials emit an `authz.role.deny` audit event (required roles, actorId,
 * route, correlationId) and then throw `IamForbiddenError` via
 * `ErrorMapper.toNest` so the HTTP boundary sees a proper
 * `ForbiddenException`.
 *
 * Ory-leakage: this guard makes NO Ory calls — role evaluation is purely
 * in-memory from the principal already on the request.
 */
import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AUDIT_SINK, type AuditSink } from '../audit';
import { correlationStorage } from '../clients/correlation-storage';
import {
  IS_ANONYMOUS_KEY,
  IS_PUBLIC_KEY,
  REQUIRED_ROLES_KEY,
} from '../decorators/metadata-keys';
import {
  ErrorMapper,
  IamForbiddenError,
  IamUnauthorizedError,
} from '../errors';

/** Structural view of the subset of principal fields this guard consumes. */
interface PrincipalShape {
  readonly kind?: string;
  readonly id?: string;
  readonly clientId?: string;
  readonly tenant?: string;
  readonly scope?: readonly string[];
  readonly traits?: { readonly roles?: unknown } & Record<string, unknown>;
  readonly metadataPublic?: { readonly roles?: unknown } & Record<
    string,
    unknown
  >;
}

/**
 * Normalize an unknown `roles` claim into a `string[]`. Non-strings are
 * silently dropped so a malformed array does not crash the guard.
 */
function asRoleArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

/**
 * Extract a principal's effective roles.
 *
 * - Machine principal (`kind === 'machine'`): scope entries act as roles.
 * - User principal: `metadataPublic.roles` takes precedence over
 *   `traits.roles`; absent both, roles is an empty array.
 */
function extractRoles(principal: PrincipalShape): string[] {
  if (principal.kind === 'machine') {
    return asRoleArray(principal.scope);
  }
  const publicRoles = principal.metadataPublic?.roles;
  if (publicRoles !== undefined) {
    return asRoleArray(publicRoles);
  }
  return asRoleArray(principal.traits?.roles);
}

@Injectable()
export class RoleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(AUDIT_SINK) private readonly audit: AuditSink,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const handler = ctx.getHandler();
    const controller = ctx.getClass();

    // @Public() / @Anonymous() short-circuit: these routes are outside the
    // auth perimeter entirely, so a role check cannot apply. This matters
    // when RoleGuard is registered as an APP_GUARD — without it, a @Public
    // route that also (incorrectly) carried @RequireRole would end up
    // bouncing through the no-principal defence-in-depth path below.
    if (
      this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
        handler,
        controller,
      ]) === true
    ) {
      return true;
    }
    if (
      this.reflector.getAllAndOverride<boolean | undefined>(IS_ANONYMOUS_KEY, [
        handler,
        controller,
      ]) === true
    ) {
      return true;
    }

    const required = this.reflector.getAllAndOverride<string[] | undefined>(
      REQUIRED_ROLES_KEY,
      [handler, controller],
    );
    if (!required || required.length === 0) {
      return true;
    }

    const req = ctx.switchToHttp().getRequest<{ user?: PrincipalShape }>();
    const principal = req.user;
    if (!principal) {
      // SessionGuard should have populated req.user. Defense in depth.
      throw ErrorMapper.toNest(
        new IamUnauthorizedError({ message: 'no principal on request' }),
      );
    }

    const roles = extractRoles(principal);
    if (required.some((r) => roles.includes(r))) {
      return true;
    }

    const correlationId = correlationStorage.getStore()?.correlationId;
    const actorId = principal.id ?? principal.clientId;
    const tenant = principal.tenant ?? '';
    const handlerName = ctx.getHandler().name;

    await this.audit.emit({
      timestamp: new Date().toISOString(),
      event: 'authz.role.deny',
      tenant,
      actorId,
      result: 'deny',
      attributes: {
        requiredRoles: required,
        route: handlerName,
      },
      correlationId,
    });

    throw ErrorMapper.toNest(
      new IamForbiddenError({ message: 'insufficient role' }),
    );
  }
}
