/**
 * Unit tests for `PermissionGuard`.
 *
 * Covers the full PermissionGuard contract:
 *   - No metadata ⇒ `canActivate` returns true (no-op).
 *   - Metadata present but no `req.user` ⇒ throws UnauthorizedException
 *     (defense-in-depth; SessionGuard should have placed a principal).
 *   - Resolver returns undefined/empty ⇒ throws BadRequestException without
 *     any Keto call.
 *   - Unknown tenant ⇒ surfaces IamConfigurationError (500).
 *   - `tenant.ketoPermission` undefined ⇒ IamConfigurationError.
 *   - Keto `allowed: true` ⇒ returns true; audit `authz.permission.grant`.
 *   - Keto `allowed: false` ⇒ throws ForbiddenException; audit
 *     `authz.permission.deny` with full attributes.
 *   - Keto 5xx / network timeout ⇒ ServiceUnavailableException; audit
 *     `authz.upstream_unavailable`; never returns true.
 *   - Stacking: multiple `@RequirePermission` on the same handler are AND.
 *   - Resolver functions receive the raw request.
 */
import 'reflect-metadata';
import {
  BadRequestException,
  ExecutionContext,
  ForbiddenException,
  InternalServerErrorException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { PermissionGuard } from '../../../src/guards/permission.guard';
import {
  REQUIRED_PERMISSION_KEY,
  TENANT_KEY,
} from '../../../src/decorators/metadata-keys';
import type { AuditSink } from '../../../src/audit';
import type { TenantName, IamAuditEvent } from '../../../src/dto';
import type { TenantClients } from '../../../src/clients';
import type { TenantConfig } from '../../../src/config';
import type { TenantRegistry } from '../../../src/module/registry/tenant-registry.service';
import type { RequirePermissionSpec } from '../../../src/decorators/require-permission.decorator';
import { correlationStorage } from '../../../src/clients/correlation-storage';

interface MockRequest {
  user?: unknown;
  params?: Record<string, unknown>;
  body?: Record<string, unknown>;
  query?: Record<string, unknown>;
  headers?: Record<string, string | string[] | undefined>;
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

function makeSink(): { sink: AuditSink; emitted: IamAuditEvent[] } {
  const emitted: IamAuditEvent[] = [];
  const sink: AuditSink = {
    emit: (event: IamAuditEvent): void => {
      emitted.push(event);
    },
  };
  return { sink, emitted };
}

function makeTenantConfig(): TenantConfig {
  return {
    mode: 'self-hosted',
    transport: 'cookie',
    kratos: {
      publicUrl: 'http://kratos.test',
      sessionCookieName: 'ory_kratos_session',
    },
  } as unknown as TenantConfig;
}

interface KetoPermissionStub {
  checkPermission: jest.Mock;
}

function makeTenantClients(
  name: TenantName,
  opts: { keto?: KetoPermissionStub } = {},
): TenantClients {
  return {
    tenant: name,
    config: makeTenantConfig(),
    axios: {} as never,
    kratosFrontend: {} as never,
    ketoPermission: opts.keto as unknown as TenantClients['ketoPermission'],
  } as TenantClients;
}

function makeRegistry(opts: {
  tenants: Record<TenantName, TenantClients>;
  defaultTenant?: TenantName;
  failOnGet?: TenantName;
}): TenantRegistry {
  return {
    get: (name: TenantName) => {
      if (opts.failOnGet === name) {
        // Delegate to the real "unknown tenant" semantics — IamConfigurationError
        // is how TenantRegistry.get rejects unknowns.
        const {
          IamConfigurationError,
          // eslint-disable-next-line @typescript-eslint/no-require-imports
        } = require('../../../src/errors');
        throw new IamConfigurationError({
          message: `unknown tenant: ${name}`,
        });
      }
      const c = opts.tenants[name];
      if (c === undefined) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { IamConfigurationError } = require('../../../src/errors');
        throw new IamConfigurationError({
          message: `unknown tenant: ${name}`,
        });
      }
      return c;
    },
    tryGet: (name: TenantName) => opts.tenants[name],
    defaultTenant: () => opts.defaultTenant,
    list: () => Object.keys(opts.tenants),
  } as unknown as TenantRegistry;
}

function stampPermission(
  handler: (...args: unknown[]) => unknown,
  spec: RequirePermissionSpec | RequirePermissionSpec[],
): void {
  Reflect.defineMetadata(REQUIRED_PERMISSION_KEY, spec, handler);
}

describe('PermissionGuard', () => {
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
  });

  it('returns true when no @RequirePermission metadata is present (no-op)', async () => {
    const { sink, emitted } = makeSink();
    const keto: KetoPermissionStub = {
      checkPermission: jest.fn().mockResolvedValue({ allowed: true }),
    };
    const clients = makeTenantClients('demo', { keto });
    const registry = makeRegistry({
      tenants: { demo: clients },
      defaultTenant: 'demo',
    });
    const guard = new PermissionGuard(reflector, registry, sink);

    const ctx = makeCtx({
      request: { user: { id: 'u1', tenant: 'demo' } },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(keto.checkPermission).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(0);
  });

  it('throws UnauthorizedException when metadata present but no req.user', async () => {
    const { sink, emitted } = makeSink();
    const keto: KetoPermissionStub = {
      checkPermission: jest.fn(),
    };
    const clients = makeTenantClients('demo', { keto });
    const registry = makeRegistry({
      tenants: { demo: clients },
      defaultTenant: 'demo',
    });
    const guard = new PermissionGuard(reflector, registry, sink);

    const handler = function h(): void {
      return;
    };
    stampPermission(handler, {
      namespace: 'docs',
      relation: 'view',
      object: 'doc-1',
    });
    const ctx = makeCtx({ handler, request: {} });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(keto.checkPermission).not.toHaveBeenCalled();
    // Defense-in-depth: no audit event on missing principal.
    expect(emitted).toHaveLength(0);
  });

  it('throws BadRequestException when object resolver returns undefined (no Keto call)', async () => {
    const { sink } = makeSink();
    const keto: KetoPermissionStub = {
      checkPermission: jest.fn(),
    };
    const clients = makeTenantClients('demo', { keto });
    const registry = makeRegistry({
      tenants: { demo: clients },
      defaultTenant: 'demo',
    });
    const guard = new PermissionGuard(reflector, registry, sink);

    const handler = function h(): void {
      return;
    };
    stampPermission(handler, {
      namespace: 'docs',
      relation: 'view',
      object: (req: unknown): string | undefined => {
        const r = req as { params?: Record<string, unknown> };
        const id = r.params?.id;
        return typeof id === 'string' ? id : undefined;
      },
    });
    const ctx = makeCtx({
      handler,
      request: {
        user: { id: 'u1', tenant: 'demo' },
        params: {},
      },
    });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(keto.checkPermission).not.toHaveBeenCalled();
  });

  it('throws BadRequestException when object resolver returns an empty string', async () => {
    const { sink } = makeSink();
    const keto: KetoPermissionStub = {
      checkPermission: jest.fn(),
    };
    const clients = makeTenantClients('demo', { keto });
    const registry = makeRegistry({
      tenants: { demo: clients },
      defaultTenant: 'demo',
    });
    const guard = new PermissionGuard(reflector, registry, sink);

    const handler = function h(): void {
      return;
    };
    stampPermission(handler, {
      namespace: 'docs',
      relation: 'view',
      object: (): string | undefined => '',
    });
    const ctx = makeCtx({
      handler,
      request: { user: { id: 'u1', tenant: 'demo' } },
    });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(keto.checkPermission).not.toHaveBeenCalled();
  });

  it('surfaces IamConfigurationError (500) when tenant is unknown in the registry', async () => {
    const { sink } = makeSink();
    // Route stamps @Tenant('ghost') but the registry only has 'demo'.
    const keto: KetoPermissionStub = {
      checkPermission: jest.fn(),
    };
    const clients = makeTenantClients('demo', { keto });
    const registry = makeRegistry({
      tenants: { demo: clients },
      defaultTenant: 'demo',
    });
    const guard = new PermissionGuard(reflector, registry, sink);

    const handler = function h(): void {
      return;
    };
    stampPermission(handler, {
      namespace: 'docs',
      relation: 'view',
      object: 'doc-1',
    });
    Reflect.defineMetadata(TENANT_KEY, 'ghost', handler);

    const ctx = makeCtx({
      handler,
      request: { user: { id: 'u1', tenant: 'ghost' } },
    });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
    expect(keto.checkPermission).not.toHaveBeenCalled();
  });

  it('throws IamConfigurationError when Keto is not configured for the tenant', async () => {
    const { sink } = makeSink();
    // No ketoPermission on the tenant clients.
    const clients = makeTenantClients('demo');
    const registry = makeRegistry({
      tenants: { demo: clients },
      defaultTenant: 'demo',
    });
    const guard = new PermissionGuard(reflector, registry, sink);

    const handler = function h(): void {
      return;
    };
    stampPermission(handler, {
      namespace: 'docs',
      relation: 'view',
      object: 'doc-1',
    });

    const ctx = makeCtx({
      handler,
      request: { user: { id: 'u1', tenant: 'demo' } },
    });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  it('allows on Keto allowed:true, emits authz.permission.grant', async () => {
    const { sink, emitted } = makeSink();
    const keto: KetoPermissionStub = {
      checkPermission: jest.fn().mockResolvedValue({ allowed: true }),
    };
    const clients = makeTenantClients('demo', { keto });
    const registry = makeRegistry({
      tenants: { demo: clients },
      defaultTenant: 'demo',
    });
    const guard = new PermissionGuard(reflector, registry, sink);

    const handler = function routeHandler(): void {
      return;
    };
    stampPermission(handler, {
      namespace: 'docs',
      relation: 'view',
      object: 'doc-42',
    });
    const ctx = makeCtx({
      handler,
      request: { user: { id: 'user-1', tenant: 'demo' } },
    });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);

    expect(keto.checkPermission).toHaveBeenCalledTimes(1);
    expect(keto.checkPermission).toHaveBeenCalledWith({
      namespace: 'docs',
      object: 'doc-42',
      relation: 'view',
      subjectId: 'user:user-1',
    });

    expect(emitted).toHaveLength(1);
    const evt = emitted[0];
    expect(evt.event).toBe('authz.permission.grant');
    expect(evt.result).toBe('success');
    expect(evt.tenant).toBe('demo');
    expect(evt.actorId).toBe('user-1');
    expect(evt.attributes).toMatchObject({
      namespace: 'docs',
      relation: 'view',
      object: 'doc-42',
      route: 'routeHandler',
    });
    expect(typeof evt.timestamp).toBe('string');
  });

  it('denies on Keto allowed:false, throws ForbiddenException, emits authz.permission.deny', async () => {
    const { sink, emitted } = makeSink();
    const keto: KetoPermissionStub = {
      checkPermission: jest.fn().mockResolvedValue({ allowed: false }),
    };
    const clients = makeTenantClients('demo', { keto });
    const registry = makeRegistry({
      tenants: { demo: clients },
      defaultTenant: 'demo',
    });
    const guard = new PermissionGuard(reflector, registry, sink);

    const handler = function routeHandler(): void {
      return;
    };
    stampPermission(handler, {
      namespace: 'docs',
      relation: 'edit',
      object: 'doc-1',
    });
    const ctx = makeCtx({
      handler,
      request: { user: { id: 'user-2', tenant: 'demo' } },
    });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    expect(emitted).toHaveLength(1);
    const evt = emitted[0];
    expect(evt.event).toBe('authz.permission.deny');
    expect(evt.result).toBe('deny');
    expect(evt.tenant).toBe('demo');
    expect(evt.actorId).toBe('user-2');
    expect(evt.attributes).toMatchObject({
      namespace: 'docs',
      relation: 'edit',
      object: 'doc-1',
      route: 'routeHandler',
    });
  });

  it('Keto rejects with 5xx-like error → ServiceUnavailableException and authz.upstream_unavailable', async () => {
    const { sink, emitted } = makeSink();
    const axiosLike = Object.assign(new Error('boom'), {
      isAxiosError: true,
      response: { status: 500 },
    });
    const keto: KetoPermissionStub = {
      checkPermission: jest.fn().mockRejectedValue(axiosLike),
    };
    const clients = makeTenantClients('demo', { keto });
    const registry = makeRegistry({
      tenants: { demo: clients },
      defaultTenant: 'demo',
    });
    const guard = new PermissionGuard(reflector, registry, sink);

    const handler = function routeHandler(): void {
      return;
    };
    stampPermission(handler, {
      namespace: 'docs',
      relation: 'view',
      object: 'doc-1',
    });
    const ctx = makeCtx({
      handler,
      request: { user: { id: 'u1', tenant: 'demo' } },
    });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    // Never returns true — fail-closed.
    expect(emitted).toHaveLength(1);
    expect(emitted[0].event).toBe('authz.upstream_unavailable');
    expect(emitted[0].result).toBe('failure');
    expect(emitted[0].tenant).toBe('demo');
    expect(emitted[0].attributes).toMatchObject({
      namespace: 'docs',
      relation: 'view',
      object: 'doc-1',
      route: 'routeHandler',
    });
  });

  it('Keto rejects with timeout (ETIMEDOUT) → ServiceUnavailableException and authz.upstream_unavailable', async () => {
    const { sink, emitted } = makeSink();
    const timeoutErr = Object.assign(new Error('timeout'), {
      isAxiosError: true,
      code: 'ETIMEDOUT',
    });
    const keto: KetoPermissionStub = {
      checkPermission: jest.fn().mockRejectedValue(timeoutErr),
    };
    const clients = makeTenantClients('demo', { keto });
    const registry = makeRegistry({
      tenants: { demo: clients },
      defaultTenant: 'demo',
    });
    const guard = new PermissionGuard(reflector, registry, sink);

    const handler = function routeHandler(): void {
      return;
    };
    stampPermission(handler, {
      namespace: 'docs',
      relation: 'view',
      object: 'doc-1',
    });
    const ctx = makeCtx({
      handler,
      request: { user: { id: 'u1', tenant: 'demo' } },
    });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0].event).toBe('authz.upstream_unavailable');
  });

  it('calls the object resolver with the raw request', async () => {
    const { sink } = makeSink();
    const keto: KetoPermissionStub = {
      checkPermission: jest.fn().mockResolvedValue({ allowed: true }),
    };
    const clients = makeTenantClients('demo', { keto });
    const registry = makeRegistry({
      tenants: { demo: clients },
      defaultTenant: 'demo',
    });
    const guard = new PermissionGuard(reflector, registry, sink);

    const handler = function h(): void {
      return;
    };
    const resolver = jest.fn((req: unknown): string => {
      const r = req as { params?: Record<string, unknown> };
      return String(r.params?.id);
    });
    stampPermission(handler, {
      namespace: 'docs',
      relation: 'view',
      object: resolver,
    });
    const request: MockRequest = {
      user: { id: 'u1', tenant: 'demo' },
      params: { id: 'doc-99' },
    };
    const ctx = makeCtx({ handler, request });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledWith(request);
    expect(keto.checkPermission).toHaveBeenCalledWith({
      namespace: 'docs',
      object: 'doc-99',
      relation: 'view',
      subjectId: 'user:u1',
    });
  });

  it('stacking: multiple @RequirePermission specs all must pass (AND)', async () => {
    const { sink, emitted } = makeSink();
    const keto: KetoPermissionStub = {
      checkPermission: jest
        .fn()
        .mockResolvedValueOnce({ allowed: true })
        .mockResolvedValueOnce({ allowed: true }),
    };
    const clients = makeTenantClients('demo', { keto });
    const registry = makeRegistry({
      tenants: { demo: clients },
      defaultTenant: 'demo',
    });
    const guard = new PermissionGuard(reflector, registry, sink);

    const handler = function h(): void {
      return;
    };
    stampPermission(handler, [
      { namespace: 'docs', relation: 'view', object: 'doc-1' },
      { namespace: 'docs', relation: 'edit', object: 'doc-1' },
    ]);
    const ctx = makeCtx({
      handler,
      request: { user: { id: 'u1', tenant: 'demo' } },
    });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(keto.checkPermission).toHaveBeenCalledTimes(2);
    // Two grant events.
    expect(emitted).toHaveLength(2);
    expect(emitted.map((e) => e.event)).toEqual([
      'authz.permission.grant',
      'authz.permission.grant',
    ]);
  });

  it('stacking: if any one of multiple specs denies, guard denies', async () => {
    const { sink, emitted } = makeSink();
    const keto: KetoPermissionStub = {
      checkPermission: jest
        .fn()
        .mockResolvedValueOnce({ allowed: true })
        .mockResolvedValueOnce({ allowed: false }),
    };
    const clients = makeTenantClients('demo', { keto });
    const registry = makeRegistry({
      tenants: { demo: clients },
      defaultTenant: 'demo',
    });
    const guard = new PermissionGuard(reflector, registry, sink);

    const handler = function h(): void {
      return;
    };
    stampPermission(handler, [
      { namespace: 'docs', relation: 'view', object: 'doc-1' },
      { namespace: 'docs', relation: 'edit', object: 'doc-1' },
    ]);
    const ctx = makeCtx({
      handler,
      request: { user: { id: 'u1', tenant: 'demo' } },
    });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    // 1 grant + 1 deny
    const events = emitted.map((e) => e.event);
    expect(events).toContain('authz.permission.grant');
    expect(events).toContain('authz.permission.deny');
  });

  it('propagates correlationId from correlationStorage into audit events', async () => {
    const { sink, emitted } = makeSink();
    const keto: KetoPermissionStub = {
      checkPermission: jest.fn().mockResolvedValue({ allowed: false }),
    };
    const clients = makeTenantClients('demo', { keto });
    const registry = makeRegistry({
      tenants: { demo: clients },
      defaultTenant: 'demo',
    });
    const guard = new PermissionGuard(reflector, registry, sink);

    const handler = function h(): void {
      return;
    };
    stampPermission(handler, {
      namespace: 'docs',
      relation: 'view',
      object: 'doc-1',
    });
    const ctx = makeCtx({
      handler,
      request: { user: { id: 'u1', tenant: 'demo' } },
    });

    await correlationStorage.run({ correlationId: 'corr-777' }, async () => {
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0].correlationId).toBe('corr-777');
  });

  it('route-level @Tenant(customer) overrides registry defaultTenant', async () => {
    const { sink } = makeSink();
    const customerKeto: KetoPermissionStub = {
      checkPermission: jest.fn().mockResolvedValue({ allowed: true }),
    };
    const adminKeto: KetoPermissionStub = {
      checkPermission: jest.fn().mockResolvedValue({ allowed: true }),
    };
    const admin = makeTenantClients('admin', { keto: adminKeto });
    const customer = makeTenantClients('customer', { keto: customerKeto });
    const registry = makeRegistry({
      tenants: { admin, customer },
      defaultTenant: 'admin',
    });
    const guard = new PermissionGuard(reflector, registry, sink);

    const handler = function h(): void {
      return;
    };
    stampPermission(handler, {
      namespace: 'docs',
      relation: 'view',
      object: 'doc-1',
    });
    Reflect.defineMetadata(TENANT_KEY, 'customer', handler);

    const ctx = makeCtx({
      handler,
      request: { user: { id: 'u1', tenant: 'customer' } },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(customerKeto.checkPermission).toHaveBeenCalledTimes(1);
    expect(adminKeto.checkPermission).not.toHaveBeenCalled();
  });

  it('reads metadata via Reflector.getAllAndOverride([handler, class])', async () => {
    const { sink } = makeSink();
    const keto: KetoPermissionStub = {
      checkPermission: jest.fn().mockResolvedValue({ allowed: true }),
    };
    const clients = makeTenantClients('demo', { keto });
    const registry = makeRegistry({
      tenants: { demo: clients },
      defaultTenant: 'demo',
    });
    const spy = jest.spyOn(reflector, 'getAllAndOverride');
    const guard = new PermissionGuard(reflector, registry, sink);

    const handler = function h(): void {
      return;
    };
    class Ctrl {}
    stampPermission(handler, {
      namespace: 'docs',
      relation: 'view',
      object: 'doc-1',
    });
    const ctx = makeCtx({
      handler,
      controllerClass: Ctrl,
      request: { user: { id: 'u1', tenant: 'demo' } },
    });

    await guard.canActivate(ctx);
    expect(spy).toHaveBeenCalledWith(REQUIRED_PERMISSION_KEY, [handler, Ctrl]);
  });
});
