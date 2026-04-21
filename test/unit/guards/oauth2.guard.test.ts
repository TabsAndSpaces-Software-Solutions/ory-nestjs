/**
 * Unit tests for `OAuth2Guard`.
 *
 * Covers the full OAuth2Guard contract (spec unit `ogd`):
 *   - Missing `Authorization` header → UnauthorizedException (no audit needs
 *     of form success).
 *   - `Authorization` without `Bearer ` prefix → UnauthorizedException.
 *   - Tenant resolves but has no `hydraOauth2` client →
 *     InternalServerErrorException via ErrorMapper (IamConfigurationError).
 *   - Active token → attaches `IamMachinePrincipal` to `req.user`, returns
 *     true, emits `auth.success` with `transport: 'oauth2'`.
 *   - Inactive token → UnauthorizedException, emits
 *     `auth.failure.token_inactive`.
 *   - Hydra 5xx (IamUpstreamUnavailableError) → ServiceUnavailableException
 *     via ErrorMapper.
 *
 * Stubs `hydraOauth2.introspectOAuth2Token` with Jest spies — no real Ory
 * contact.
 */
import 'reflect-metadata';
import {
  ExecutionContext,
  InternalServerErrorException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { OAuth2Guard } from '../../../src/guards/oauth2.guard';
import { TENANT_KEY } from '../../../src/decorators/metadata-keys';
import type { AuditSink } from '../../../src/audit';
import type {
  TenantName,
  IamAuditEvent,
  IamMachinePrincipal,
} from '../../../src/dto';
import type { TenantClients } from '../../../src/clients';
import type { ValidatedTenantConfig } from '../../../src/config';
import type { TenantRegistry } from '../../../src/module/registry/tenant-registry.service';

interface MockRequest {
  headers: Record<string, string | string[] | undefined>;
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
  const request = opts.request ?? { headers: {} };

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

function makeTenantConfig(): ValidatedTenantConfig {
  return {
    mode: 'self-hosted',
    transport: 'bearer',
    kratos: {
      publicUrl: 'http://kratos.test',
      sessionCookieName: 'ory_kratos_session',
    },
    hydra: {
      publicUrl: 'http://hydra.test',
      adminUrl: 'http://hydra-admin.test',
    },
  } as unknown as ValidatedTenantConfig;
}

interface IntrospectResult {
  active: boolean;
  sub?: string;
  client_id?: string;
  scope?: string;
  exp?: number;
  iat?: number;
}

function makeTenantClients(
  name: TenantName,
  config: ValidatedTenantConfig,
  introspect?: jest.Mock<Promise<{ data: IntrospectResult }>, [unknown]>,
): TenantClients {
  const hydraOauth2 = introspect
    ? { introspectOAuth2Token: introspect }
    : undefined;
  return {
    tenant: name,
    config,
    axios: {} as never,
    kratosFrontend: {} as never,
    hydraOauth2,
  } as unknown as TenantClients;
}

function makeRegistry(opts: {
  tenants: Record<TenantName, TenantClients>;
  defaultTenant?: TenantName;
}): TenantRegistry {
  return {
    get: (name: TenantName) => {
      const c = opts.tenants[name];
      if (c === undefined) {
        throw new Error(`unknown tenant: ${name}`);
      }
      return c;
    },
    tryGet: (name: TenantName) => opts.tenants[name],
    defaultTenant: () => opts.defaultTenant,
    list: () => Object.keys(opts.tenants),
  } as unknown as TenantRegistry;
}

describe('OAuth2Guard', () => {
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
    jest.restoreAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('missing Authorization header → throws UnauthorizedException', async () => {
    const { sink } = makeSink();
    const cfg = makeTenantConfig();
    const introspect = jest.fn();
    const clients = makeTenantClients('demo', cfg, introspect);
    const registry = makeRegistry({
      tenants: { demo: clients },
      defaultTenant: 'demo',
    });

    const guard = new OAuth2Guard(reflector, registry, sink);
    const ctx = makeCtx({ request: { headers: {} } });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(introspect).not.toHaveBeenCalled();
  });

  it('Authorization without Bearer prefix → throws UnauthorizedException', async () => {
    const { sink } = makeSink();
    const cfg = makeTenantConfig();
    const introspect = jest.fn();
    const clients = makeTenantClients('demo', cfg, introspect);
    const registry = makeRegistry({
      tenants: { demo: clients },
      defaultTenant: 'demo',
    });

    const guard = new OAuth2Guard(reflector, registry, sink);
    const ctx = makeCtx({
      request: { headers: { authorization: 'Basic abc123' } },
    });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(introspect).not.toHaveBeenCalled();
  });

  it('no hydraOauth2 configured → throws InternalServerErrorException via ErrorMapper', async () => {
    const { sink } = makeSink();
    const cfg = makeTenantConfig();
    // no introspect → hydraOauth2 undefined
    const clients = makeTenantClients('demo', cfg);
    const registry = makeRegistry({
      tenants: { demo: clients },
      defaultTenant: 'demo',
    });

    const guard = new OAuth2Guard(reflector, registry, sink);
    const ctx = makeCtx({
      request: { headers: { authorization: 'Bearer token-xyz' } },
    });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  it('valid active token → attaches IamMachinePrincipal and emits auth.success', async () => {
    const { sink, emitted } = makeSink();
    const cfg = makeTenantConfig();
    const introspect = jest.fn().mockResolvedValue({
      data: {
        active: true,
        sub: 'client-uuid-7',
        client_id: 'client-uuid-7',
        scope: 'read:cars write:leads',
        exp: 9999999999,
        iat: 1700000000,
      },
    });
    const clients = makeTenantClients('demo', cfg, introspect);
    const registry = makeRegistry({
      tenants: { demo: clients },
      defaultTenant: 'demo',
    });

    const guard = new OAuth2Guard(reflector, registry, sink);
    const handler = function routeHandler(): void {
      return;
    };
    const req: MockRequest = {
      headers: {
        authorization: 'Bearer good-token-abc',
        'x-request-id': 'corr-oauth-ok',
      },
    };
    const ctx = makeCtx({ handler, request: req });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);

    expect(introspect).toHaveBeenCalledTimes(1);
    expect(introspect).toHaveBeenCalledWith({ token: 'good-token-abc' });

    const principal = req.user as IamMachinePrincipal;
    expect(principal.kind).toBe('machine');
    expect(principal.clientId).toBe('client-uuid-7');
    expect(principal.scope).toEqual(['read:cars', 'write:leads']);
    expect(principal.tenant).toBe('demo');

    expect(emitted).toHaveLength(1);
    const evt = emitted[0];
    expect(evt.event).toBe('auth.success');
    expect(evt.result).toBe('success');
    expect(evt.tenant).toBe('demo');
    expect(evt.actorId).toBe('client-uuid-7');
    expect(evt.correlationId).toBe('corr-oauth-ok');
    expect(evt.attributes).toMatchObject({
      transport: 'oauth2',
      route: 'routeHandler',
    });
  });

  it('inactive token → throws UnauthorizedException and emits auth.failure.token_inactive', async () => {
    const { sink, emitted } = makeSink();
    const cfg = makeTenantConfig();
    const introspect = jest.fn().mockResolvedValue({
      data: { active: false },
    });
    const clients = makeTenantClients('demo', cfg, introspect);
    const registry = makeRegistry({
      tenants: { demo: clients },
      defaultTenant: 'demo',
    });

    const guard = new OAuth2Guard(reflector, registry, sink);
    const handler = function routeHandler(): void {
      return;
    };
    const ctx = makeCtx({
      handler,
      request: {
        headers: {
          authorization: 'Bearer bad-token',
          'x-request-id': 'corr-inactive',
        },
      },
    });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(emitted).toHaveLength(1);
    const evt = emitted[0];
    expect(evt.event).toBe('auth.failure.token_inactive');
    expect(evt.result).toBe('failure');
    expect(evt.tenant).toBe('demo');
    expect(evt.attributes).toMatchObject({ route: 'routeHandler' });
    expect(evt.correlationId).toBe('corr-inactive');
  });

  it('Hydra 5xx → throws ServiceUnavailableException via ErrorMapper', async () => {
    const { sink } = makeSink();
    const cfg = makeTenantConfig();
    const axiosLike = Object.assign(new Error('hydra boom'), {
      isAxiosError: true,
      response: { status: 503 },
    });
    const introspect = jest.fn().mockRejectedValue(axiosLike);
    const clients = makeTenantClients('demo', cfg, introspect);
    const registry = makeRegistry({
      tenants: { demo: clients },
      defaultTenant: 'demo',
    });

    const guard = new OAuth2Guard(reflector, registry, sink);
    const ctx = makeCtx({
      request: { headers: { authorization: 'Bearer any' } },
    });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('route-level @Tenant metadata overrides registry defaultTenant', async () => {
    const { sink } = makeSink();
    const cfg = makeTenantConfig();
    const introspect = jest.fn().mockResolvedValue({
      data: {
        active: true,
        client_id: 'client-customer',
        scope: 'a b',
      },
    });
    const admin = makeTenantClients('admin', cfg, jest.fn());
    const customer = makeTenantClients('customer', cfg, introspect);
    const registry = makeRegistry({
      tenants: { admin, customer },
      defaultTenant: 'admin',
    });

    const guard = new OAuth2Guard(reflector, registry, sink);
    const handler = function h(): void {
      return;
    };
    Reflect.defineMetadata(TENANT_KEY, 'customer', handler);

    const req: MockRequest = {
      headers: { authorization: 'Bearer tok' },
    };
    const ctx = makeCtx({ handler, request: req });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);

    const principal = req.user as IamMachinePrincipal;
    expect(principal.tenant).toBe('customer');
    expect(introspect).toHaveBeenCalledTimes(1);
  });
});
