/**
 * Unit tests for `RoleGuard`.
 *
 * Covers the full RoleGuard contract:
 *   - No metadata ⇒ `canActivate` returns true (no-op)
 *   - Metadata present but no `req.user` ⇒ throws UnauthorizedException
 *     (defense-in-depth; SessionGuard should have placed a principal)
 *   - User holds one of the required roles ⇒ returns true, no audit event
 *   - User holds NONE of the required roles ⇒ throws ForbiddenException
 *     AND emits an `authz.role.deny` audit event with requiredRoles, actorId,
 *     route, and correlationId
 *   - OR semantics: `@RequireRole('a','b')` with `user.traits.roles=['b']`
 *     allows
 *   - `user.metadataPublic.roles` takes precedence over `user.traits.roles`
 *   - `IamMachinePrincipal`: `scope` elements are treated as roles
 *   - Guard reads metadata via `Reflector.getAllAndOverride(handler, class)`
 */
import 'reflect-metadata';
import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { RoleGuard } from '../../../src/guards/role.guard';
import { REQUIRED_ROLES_KEY } from '../../../src/decorators/metadata-keys';
import type { AuditSink } from '../../../src/audit';
import type { IamAuditEvent } from '../../../src/dto';
import { correlationStorage } from '../../../src/clients/correlation-storage';

interface MockRequest {
  user?: unknown;
}

function makeCtx(opts: {
  handler?: (...args: unknown[]) => unknown;
  controllerClass?: new () => unknown;
  request?: MockRequest;
}): ExecutionContext {
  const handler =
    opts.handler ??
    function routeHandler(): void {
      return;
    };
  const controllerClass = opts.controllerClass ?? class DefaultCtrl {};
  const request = opts.request ?? {};

  return {
    getHandler: () => handler,
    getClass: () => controllerClass,
    switchToHttp: () => ({
      getRequest: <T = unknown>(): T => request as unknown as T,
      getResponse: <T = unknown>(): T => ({}) as T,
      getNext: <T = unknown>(): T => (() => undefined) as unknown as T,
    }),
  } as unknown as ExecutionContext;
}

function makeSink(): {
  sink: AuditSink;
  emitted: IamAuditEvent[];
} {
  const emitted: IamAuditEvent[] = [];
  const sink: AuditSink = {
    emit: (event: IamAuditEvent): void => {
      emitted.push(event);
    },
  };
  return { sink, emitted };
}

function stampRoles(
  handler: (...args: unknown[]) => unknown,
  roles: string[],
): void {
  Reflect.defineMetadata(REQUIRED_ROLES_KEY, roles, handler);
}

describe('RoleGuard', () => {
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
  });

  it('returns true when no @RequireRole metadata is present (no-op)', async () => {
    const { sink, emitted } = makeSink();
    const guard = new RoleGuard(reflector, sink);

    const ctx = makeCtx({ request: { user: { id: 'u1', tenant: 'demo' } } });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(emitted).toHaveLength(0);
  });

  it('returns true when metadata exists but the roles array is empty', async () => {
    // Guarded by @RequireRole (which rejects empty at decoration time), but
    // defence-in-depth: if someone hand-stamps an empty array, the guard
    // should treat it like no-metadata rather than deny.
    const { sink } = makeSink();
    const guard = new RoleGuard(reflector, sink);

    const handler = function h(): void {
      return;
    };
    stampRoles(handler, []);
    const ctx = makeCtx({ handler, request: { user: { id: 'u1' } } });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('throws UnauthorizedException when metadata present but no req.user', async () => {
    const { sink, emitted } = makeSink();
    const guard = new RoleGuard(reflector, sink);

    const handler = function h(): void {
      return;
    };
    stampRoles(handler, ['admin']);
    const ctx = makeCtx({ handler, request: {} });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    // Defense-in-depth denial should NOT emit an audit event — SessionGuard
    // is responsible for auth.failure.* emissions.
    expect(emitted).toHaveLength(0);
  });

  it('allows when user holds exactly one required role (single match)', async () => {
    const { sink, emitted } = makeSink();
    const guard = new RoleGuard(reflector, sink);

    const handler = function h(): void {
      return;
    };
    stampRoles(handler, ['admin']);
    const ctx = makeCtx({
      handler,
      request: {
        user: {
          id: 'u1',
          tenant: 'demo',
          traits: { roles: ['admin'] },
        },
      },
    });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(emitted).toHaveLength(0);
  });

  it('allows OR-match: required=[a,b] and user has only [b]', async () => {
    const { sink, emitted } = makeSink();
    const guard = new RoleGuard(reflector, sink);

    const handler = function h(): void {
      return;
    };
    stampRoles(handler, ['a', 'b']);
    const ctx = makeCtx({
      handler,
      request: {
        user: {
          id: 'u1',
          tenant: 'demo',
          traits: { roles: ['b'] },
        },
      },
    });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(emitted).toHaveLength(0);
  });

  it('denies with ForbiddenException and emits authz.role.deny on no match', async () => {
    const { sink, emitted } = makeSink();
    const guard = new RoleGuard(reflector, sink);

    const handler = function routeHandler(): void {
      return;
    };
    stampRoles(handler, ['admin', 'operator']);
    const ctx = makeCtx({
      handler,
      request: {
        user: {
          id: 'user-1',
          tenant: 'demo',
          traits: { roles: ['viewer'] },
        },
      },
    });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(emitted).toHaveLength(1);
    const evt = emitted[0];
    expect(evt.event).toBe('authz.role.deny');
    expect(evt.result).toBe('deny');
    expect(evt.tenant).toBe('demo');
    expect(evt.actorId).toBe('user-1');
    expect(evt.attributes).toMatchObject({
      requiredRoles: ['admin', 'operator'],
      route: 'routeHandler',
    });
    expect(typeof evt.timestamp).toBe('string');
    // Timestamp is an ISO8601 string.
    expect(() => new Date(evt.timestamp).toISOString()).not.toThrow();
  });

  it('propagates correlationId from correlationStorage into the audit event', async () => {
    const { sink, emitted } = makeSink();
    const guard = new RoleGuard(reflector, sink);

    const handler = function h(): void {
      return;
    };
    stampRoles(handler, ['admin']);
    const ctx = makeCtx({
      handler,
      request: {
        user: {
          id: 'u1',
          tenant: 'demo',
          traits: { roles: ['viewer'] },
        },
      },
    });

    await correlationStorage.run(
      { correlationId: 'corr-123' },
      async () => {
        await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
          ForbiddenException,
        );
      },
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0].correlationId).toBe('corr-123');
  });

  it('prefers metadataPublic.roles over traits.roles (precedence)', async () => {
    const { sink, emitted } = makeSink();
    const guard = new RoleGuard(reflector, sink);

    const handler = function h(): void {
      return;
    };
    stampRoles(handler, ['admin']);
    // metadataPublic says admin, traits says viewer — metadataPublic wins.
    const ctx = makeCtx({
      handler,
      request: {
        user: {
          id: 'u1',
          tenant: 'demo',
          traits: { roles: ['viewer'] },
          metadataPublic: { roles: ['admin'] },
        },
      },
    });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(emitted).toHaveLength(0);
  });

  it('precedence: metadataPublic.roles=[viewer] beats traits.roles=[admin]', async () => {
    const { sink, emitted } = makeSink();
    const guard = new RoleGuard(reflector, sink);

    const handler = function h(): void {
      return;
    };
    stampRoles(handler, ['admin']);
    // metadataPublic overrides traits even if traits look "more privileged".
    const ctx = makeCtx({
      handler,
      request: {
        user: {
          id: 'u1',
          tenant: 'demo',
          traits: { roles: ['admin'] },
          metadataPublic: { roles: ['viewer'] },
        },
      },
    });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0].event).toBe('authz.role.deny');
  });

  it('treats IamMachinePrincipal.scope entries as roles (allow)', async () => {
    const { sink, emitted } = makeSink();
    const guard = new RoleGuard(reflector, sink);

    const handler = function h(): void {
      return;
    };
    stampRoles(handler, ['read:listings']);
    const ctx = makeCtx({
      handler,
      request: {
        user: {
          kind: 'machine',
          clientId: 'svc-1',
          scope: ['read:listings', 'write:listings'],
          tenant: 'demo',
        },
      },
    });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(emitted).toHaveLength(0);
  });

  it('machine principal missing required scope → deny with clientId actorId', async () => {
    const { sink, emitted } = makeSink();
    const guard = new RoleGuard(reflector, sink);

    const handler = function h(): void {
      return;
    };
    stampRoles(handler, ['admin']);
    const ctx = makeCtx({
      handler,
      request: {
        user: {
          kind: 'machine',
          clientId: 'svc-1',
          scope: ['read:listings'],
          tenant: 'demo',
        },
      },
    });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(emitted).toHaveLength(1);
    // When no `id` exists, fall back to clientId for actorId.
    expect(emitted[0].actorId).toBe('svc-1');
  });

  it('reads metadata via Reflector.getAllAndOverride ([handler, class])', async () => {
    const { sink } = makeSink();
    const spy = jest.spyOn(reflector, 'getAllAndOverride');
    const guard = new RoleGuard(reflector, sink);

    const handler = function h(): void {
      return;
    };
    class Ctrl {}
    stampRoles(handler, ['admin']);
    const ctx = makeCtx({
      handler,
      controllerClass: Ctrl,
      request: {
        user: {
          id: 'u1',
          tenant: 'demo',
          traits: { roles: ['admin'] },
        },
      },
    });

    await guard.canActivate(ctx);
    expect(spy).toHaveBeenCalledWith(REQUIRED_ROLES_KEY, [handler, Ctrl]);
  });

  it('handler-level metadata overrides class-level metadata', async () => {
    const { sink } = makeSink();
    const guard = new RoleGuard(reflector, sink);

    const handler = function h(): void {
      return;
    };
    class Ctrl {}
    // Class says ['admin']; handler says ['viewer']. Handler wins.
    Reflect.defineMetadata(REQUIRED_ROLES_KEY, ['admin'], Ctrl);
    Reflect.defineMetadata(REQUIRED_ROLES_KEY, ['viewer'], handler);

    const ctx = makeCtx({
      handler,
      controllerClass: Ctrl,
      request: {
        user: {
          id: 'u1',
          tenant: 'demo',
          traits: { roles: ['viewer'] },
        },
      },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('empty user.traits / no roles at all + required roles → deny', async () => {
    const { sink, emitted } = makeSink();
    const guard = new RoleGuard(reflector, sink);

    const handler = function h(): void {
      return;
    };
    stampRoles(handler, ['admin']);
    const ctx = makeCtx({
      handler,
      request: {
        user: {
          id: 'u1',
          tenant: 'demo',
          // no traits, no metadataPublic
        },
      },
    });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0].event).toBe('authz.role.deny');
  });
});
