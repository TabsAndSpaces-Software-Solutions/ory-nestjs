/**
 * `PermissionGuard` — enforces `@RequirePermission({ namespace, relation, object })`
 * by resolving the target object from the request, constructing a Keto tuple,
 * and calling the tenant-scoped `PermissionApi.checkPermission`.
 *
 * Ordering contract:
 *   - Intended to run AFTER `SessionGuard` has populated `req.user`. When no
 *     principal is present but the route carries `@RequirePermission(...)`,
 *     the guard fails fast with `IamUnauthorizedError` (defense-in-depth).
 *   - Composes with `RoleGuard` under NestJS `@UseGuards()` order as AND —
 *     each guard must permit the request independently.
 *
 * Stacking contract:
 *   - Multiple `@RequirePermission(...)` decorators on the SAME handler (or
 *     handler + controller) yield an array of specs via
 *     `Reflector.getAllAndOverride`. ALL specs must pass for the guard to
 *     allow the request (AND semantics). The guard short-circuits on the
 *     first denial.
 *
 * Object resolution:
 *   - `object: string` — used as-is. The namespace is NOT prepended; callers
 *     encode any namespacing scheme inside their resolver/string.
 *   - `object: (req) => string | undefined` — invoked with the raw request.
 *     If the resolver returns anything other than a non-empty string, the
 *     guard throws `BadRequestException` without calling Keto. This matches
 *     the "resource id missing from URL" error shape consumers expect.
 *
 * Fail-closed policy:
 *   - `allowed: true`  → emit `authz.permission.grant`, return true.
 *   - `allowed: false` → emit `authz.permission.deny`, throw `IamForbiddenError`.
 *   - Upstream error / timeout → emit `authz.upstream_unavailable`, throw
 *     `IamUpstreamUnavailableError` (never allow-on-error). Guard NEVER
 *     returns true on upstream failure.
 *
 * Zero-Ory-leakage: this file does not import `@ory/*`. The structural
 * `KetoPermissionApi` view below keeps the guard decoupled from the Ory SDK
 * surface and lets unit tests supply a Jest-spy without faking `@ory/client`.
 */
import {
  BadRequestException,
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
  REQUIRED_PERMISSION_KEY,
  TENANT_KEY,
} from '../decorators/metadata-keys';
import type { RequirePermissionSpec } from '../decorators/require-permission.decorator';
import type { TenantName } from '../dto';
import {
  ErrorMapper,
  IamConfigurationError,
  IamForbiddenError,
  IamUnauthorizedError,
  IamUpstreamUnavailableError,
} from '../errors';
import { TENANT_REGISTRY } from '../module/registry/tokens';
import type { TenantRegistry } from '../module/registry/tenant-registry.service';

/**
 * Structural view of the subset of `PermissionApi` this guard consumes.
 * Real callers wire the Ory SDK instance; tests wire a Jest spy.
 */
interface KetoPermissionApi {
  checkPermission(input: {
    namespace: string;
    object: string;
    relation: string;
    subjectId: string;
  }): Promise<{ allowed: boolean }>;
}

/** Structural view of `req.user` fields this guard reads. */
interface PrincipalShape {
  readonly id?: string;
  readonly clientId?: string;
  readonly tenant?: string;
}

function asSpecArray(
  raw: RequirePermissionSpec | readonly RequirePermissionSpec[] | undefined,
): RequirePermissionSpec[] {
  if (raw === undefined) return [];
  if (Array.isArray(raw)) return [...raw];
  return [raw as RequirePermissionSpec];
}

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(TENANT_REGISTRY) private readonly registry: TenantRegistry,
    @Inject(AUDIT_SINK) private readonly audit: AuditSink,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const handler = ctx.getHandler();
    const controller = ctx.getClass();

    // @Public() / @Anonymous() short-circuit: these routes sit outside the
    // auth perimeter entirely, so permission checks cannot apply. This
    // matters when PermissionGuard is registered as an APP_GUARD — without
    // it, a @Public route that also (incorrectly) carried @RequirePermission
    // would bounce through the no-principal defence-in-depth path below.
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

    // 1. Read permission metadata. If none, this guard is a no-op.
    const raw = this.reflector.getAllAndOverride<
      RequirePermissionSpec | RequirePermissionSpec[] | undefined
    >(REQUIRED_PERMISSION_KEY, [handler, controller]);
    const specs = asSpecArray(raw);
    if (specs.length === 0) {
      return true;
    }

    const req = ctx.switchToHttp().getRequest<{ user?: PrincipalShape }>();
    const principal = req.user;
    if (!principal) {
      // SessionGuard should have populated req.user; defense in depth.
      throw ErrorMapper.toNest(
        new IamUnauthorizedError({ message: 'no principal on request' }),
      );
    }

    const correlationId = correlationStorage.getStore()?.correlationId;

    try {
      // 2. Resolve tenant name.
      const tenantName =
        this.reflector.getAllAndOverride<TenantName | undefined>(TENANT_KEY, [
          handler,
          controller,
        ]) ?? this.registry.defaultTenant();
      if (tenantName === undefined) {
        throw new IamConfigurationError({
          message:
            'PermissionGuard cannot resolve a tenant: no @Tenant() metadata ' +
            'and registry has no default tenant.',
          correlationId,
        });
      }

      // 3. Resolve tenant clients — throws IamConfigurationError on unknown.
      const tenant = this.registry.get(tenantName);

      const keto = tenant.ketoPermission as KetoPermissionApi | undefined;
      if (keto === undefined) {
        throw new IamConfigurationError({
          message: `Keto not configured for tenant '${tenantName}'`,
          correlationId,
        });
      }

      const route = handler.name;
      const subjectId = `user:${principal.id ?? principal.clientId ?? ''}`;
      const actorId = principal.id ?? principal.clientId;

      // 4. Evaluate every stacked spec with AND semantics. Short-circuit
      //    on the first denial (no further Keto calls).
      for (const spec of specs) {
        // Object resolution happens BEFORE the Keto call so a bad request
        // never triggers upstream traffic.
        const objectSpec = spec.object;
        const objectValue =
          typeof objectSpec === 'function' ? objectSpec(req) : objectSpec;
        if (typeof objectValue !== 'string' || objectValue.length === 0) {
          throw new BadRequestException(
            'required permission object could not be resolved from request',
          );
        }

        await this.checkOne({
          spec,
          objectValue,
          tenantName,
          keto,
          route,
          subjectId,
          actorId,
          correlationId,
        });
      }

      return true;
    } catch (err) {
      // BadRequestException must surface as-is (400), not via ErrorMapper
      // which only knows how to lift IamError subclasses.
      if (err instanceof BadRequestException) {
        throw err;
      }
      throw ErrorMapper.toNest(err, { correlationId });
    }
  }

  /**
   * Execute one `checkPermission` call and emit the corresponding audit
   * event. Throws on deny / upstream failure so the enclosing loop
   * short-circuits.
   */
  private async checkOne(args: {
    spec: RequirePermissionSpec;
    objectValue: string;
    tenantName: TenantName;
    keto: KetoPermissionApi;
    route: string;
    subjectId: string;
    actorId: string | undefined;
    correlationId: string | undefined;
  }): Promise<void> {
    const {
      spec,
      objectValue,
      tenantName,
      keto,
      route,
      subjectId,
      actorId,
      correlationId,
    } = args;

    let result: { allowed: boolean };
    try {
      result = await keto.checkPermission({
        namespace: spec.namespace,
        object: objectValue,
        relation: spec.relation,
        subjectId,
      });
    } catch (cause) {
      await this.audit.emit({
        timestamp: new Date().toISOString(),
        event: 'authz.upstream_unavailable',
        tenant: tenantName,
        actorId,
        result: 'failure',
        attributes: {
          namespace: spec.namespace,
          relation: spec.relation,
          object: objectValue,
          route,
        },
        correlationId,
      });
      throw new IamUpstreamUnavailableError({
        message: 'Keto check failed',
        cause,
        correlationId,
      });
    }

    if (result.allowed === true) {
      await this.audit.emit({
        timestamp: new Date().toISOString(),
        event: 'authz.permission.grant',
        tenant: tenantName,
        actorId,
        result: 'success',
        attributes: {
          namespace: spec.namespace,
          relation: spec.relation,
          object: objectValue,
          route,
        },
        correlationId,
      });
      return;
    }

    await this.audit.emit({
      timestamp: new Date().toISOString(),
      event: 'authz.permission.deny',
      tenant: tenantName,
      actorId,
      result: 'deny',
      attributes: {
        namespace: spec.namespace,
        relation: spec.relation,
        object: objectValue,
        route,
      },
      correlationId,
    });
    throw new IamForbiddenError({
      message: 'permission denied',
      correlationId,
    });
  }
}
