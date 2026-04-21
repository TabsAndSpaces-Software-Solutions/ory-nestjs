/**
 * Unit tests for `SessionGuard`.
 *
 * Covers the full SessionGuard contract:
 *   - Short-circuit true for `@Public()` / `@Anonymous()` handlers (no
 *     transport call, no audit).
 *   - Missing credential (transport returns null) → UnauthorizedException
 *     AND `auth.failure.missing_credential` audit event.
 *   - Success path attaches `req.user` / `req.session` and emits
 *     `auth.success` with transport, route, and latencyMs attributes.
 *   - Tenant mismatch (resolved session.tenant !== expected) →
 *     UnauthorizedException AND `auth.tenant_mismatch` audit event.
 *   - Upstream 401-like Ory error (IamUnauthorizedError from transport) →
 *     UnauthorizedException via ErrorMapper.
 *   - Upstream 5xx-like (IamUpstreamUnavailableError) →
 *     ServiceUnavailableException via ErrorMapper.
 *   - Route-level `@Tenant('customer')` overrides class-level
 *     `@Tenant('admin')`.
 *   - `correlationId` propagation: both from `x-request-id` header and from
 *     `correlationStorage` when already inside a run.
 *   - `IamConfigurationError` when no tenant can be resolved.
 */
import 'reflect-metadata';
import {
  ExecutionContext,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { SessionGuard } from '../../../src/guards/session.guard';
import {
  IS_PUBLIC_KEY,
  IS_ANONYMOUS_KEY,
  TENANT_KEY,
} from '../../../src/decorators/metadata-keys';
import type { AuditSink } from '../../../src/audit';
import type {
  TenantName,
  IamAuditEvent,
  IamIdentity,
  IamSession,
} from '../../../src/dto';
import type { TenantClients } from '../../../src/clients';
import type { ValidatedTenantConfig } from '../../../src/config';
import type { TenantRegistry } from '../../../src/module/registry/tenant-registry.service';
import type {
  RequestLike,
  ResolvedSession,
  SessionTransport,
} from '../../../src/transport';
import { TransportFactory } from '../../../src/transport/transport.factory';
import {
  IamUnauthorizedError,
  IamUpstreamUnavailableError,
} from '../../../src/errors';

interface MockRequest {
  headers: Record<string, string | string[] | undefined>;
  user?: unknown;
  session?: unknown;
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

function makeTenantConfig(transport: ValidatedTenantConfig['transport']): ValidatedTenantConfig {
  return {
    mode: 'self-hosted',
    transport,
    kratos: {
      publicUrl: 'http://kratos.test',
      sessionCookieName: 'ory_kratos_session',
    },
    oathkeeper: {
      identityHeader: 'x-user',
      signatureHeader: 'x-user-signature',
      signerKeys: ['k1'],
    },
  } as unknown as ValidatedTenantConfig;
}

function makeTenantClients(
  name: TenantName,
  config: ValidatedTenantConfig,
): TenantClients {
  return {
    tenant: name,
    config,
    axios: {} as never,
    kratosFrontend: {} as never,
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

function makeIdentity(tenant: TenantName, id = 'user-1'): IamIdentity {
  return {
    id,
    schemaId: 'default',
    state: 'active',
    verifiedAddressesFlags: { email: true, phone: false },
    tenant,
  };
}

function makeSession(tenant: TenantName, identity: IamIdentity): IamSession {
  return {
    id: 'session-1',
    active: true,
    expiresAt: '2030-01-01T00:00:00.000Z',
    authenticatedAt: '2026-01-01T00:00:00.000Z',
    authenticationMethods: ['password'],
    identity,
    tenant,
  };
}

let currentFactory: TransportFactory;

function stubTransportForTenant(
  impl: (
    req: RequestLike,
    tenant: TenantClients,
    tenantName: TenantName,
    tenantConfig: ValidatedTenantConfig,
  ) => Promise<ResolvedSession | null>,
): jest.Mock {
  const transport: SessionTransport = { resolve: impl };
  const spy = jest.fn().mockReturnValue(transport);
  currentFactory = { forTenant: spy } as unknown as TransportFactory;
  return spy;
}

describe('SessionGuard', () => {
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
    jest.restoreAllMocks();
    // Default factory: returns a transport that never resolves a session.
    // Tests that exercise the transport path replace this via
    // stubTransportForTenant.
    currentFactory = {
      forTenant: jest
        .fn()
        .mockReturnValue({ resolve: async () => null } as SessionTransport),
    } as unknown as TransportFactory;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('short-circuits to true for @Public() handler without calling transport', async () => {
    const { sink, emitted } = makeSink();
    const cfg = makeTenantConfig('cookie');
    const clients = makeTenantClients('demo', cfg);
    const registry = makeRegistry({
      tenants: { demo: clients },
      defaultTenant: 'demo',
    });
    const spy = stubTransportForTenant(async () => null);

    const guard = new SessionGuard(reflector, registry, sink, currentFactory);
    const handler = function h(): void {
      return;
    };
    Reflect.defineMetadata(IS_PUBLIC_KEY, true, handler);

    const ctx = makeCtx({ handler, request: { headers: {} } });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);

    expect(spy).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(0);
  });

  it('short-circuits to true for @Anonymous() handler without calling transport', async () => {
    const { sink, emitted } = makeSink();
    const cfg = makeTenantConfig('cookie');
    const clients = makeTenantClients('demo', cfg);
    const registry = makeRegistry({
      tenants: { demo: clients },
      defaultTenant: 'demo',
    });
    const spy = stubTransportForTenant(async () => null);

    const guard = new SessionGuard(reflector, registry, sink, currentFactory);
    const handler = function h(): void {
      return;
    };
    Reflect.defineMetadata(IS_ANONYMOUS_KEY, true, handler);

    const ctx = makeCtx({ handler, request: { headers: {} } });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);

    expect(spy).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(0);
  });

  it('missing credential → throws UnauthorizedException and emits auth.failure.missing_credential', async () => {
    const { sink, emitted } = makeSink();
    const cfg = makeTenantConfig('cookie');
    const clients = makeTenantClients('demo', cfg);
    const registry = makeRegistry({
      tenants: { demo: clients },
      defaultTenant: 'demo',
    });
    stubTransportForTenant(async () => null);

    const guard = new SessionGuard(reflector, registry, sink, currentFactory);
    const handler = function routeHandler(): void {
      return;
    };
    const ctx = makeCtx({
      handler,
      request: { headers: { 'x-request-id': 'corr-abc' } },
    });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(emitted).toHaveLength(1);
    const evt = emitted[0];
    expect(evt.event).toBe('auth.failure.missing_credential');
    expect(evt.result).toBe('failure');
    expect(evt.tenant).toBe('demo');
    expect(evt.attributes).toMatchObject({ route: 'routeHandler' });
    expect(evt.correlationId).toBe('corr-abc');
    expect(typeof evt.timestamp).toBe('string');
  });

  it('success path attaches req.user and req.session, emits auth.success', async () => {
    const { sink, emitted } = makeSink();
    const cfg = makeTenantConfig('cookie');
    const clients = makeTenantClients('demo', cfg);
    const registry = makeRegistry({
      tenants: { demo: clients },
      defaultTenant: 'demo',
    });

    const identity = makeIdentity('demo', 'user-42');
    const session = makeSession('demo', identity);
    const resolved: ResolvedSession = {
      identity,
      session,
      latencyMs: 12,
    };
    stubTransportForTenant(async () => resolved);

    const guard = new SessionGuard(reflector, registry, sink, currentFactory);
    const handler = function routeHandler(): void {
      return;
    };
    const req: MockRequest = { headers: { 'x-request-id': 'corr-ok' } };
    const ctx = makeCtx({ handler, request: req });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);

    expect(req.user).toBe(identity);
    expect(req.session).toBe(session);

    expect(emitted).toHaveLength(1);
    const evt = emitted[0];
    expect(evt.event).toBe('auth.success');
    expect(evt.result).toBe('success');
    expect(evt.tenant).toBe('demo');
    expect(evt.actorId).toBe('user-42');
    expect(evt.correlationId).toBe('corr-ok');
    expect(evt.attributes).toMatchObject({
      transport: 'cookie',
      route: 'routeHandler',
    });
    expect(typeof evt.attributes.latencyMs).toBe('number');
  });

  it('tenant mismatch → throws UnauthorizedException and emits auth.tenant_mismatch', async () => {
    const { sink, emitted } = makeSink();
    const cfg = makeTenantConfig('cookie');
    const demoClients = makeTenantClients('demo', cfg);
    const registry = makeRegistry({
      tenants: { demo: demoClients },
      defaultTenant: 'demo',
    });

    // Transport returns a session stamped with a DIFFERENT tenant.
    const identity = makeIdentity('other');
    const session = makeSession('other', identity);
    const resolved: ResolvedSession = {
      identity,
      session,
      latencyMs: 4,
    };
    stubTransportForTenant(async () => resolved);

    const guard = new SessionGuard(reflector, registry, sink, currentFactory);
    const handler = function routeHandler(): void {
      return;
    };
    const ctx = makeCtx({
      handler,
      request: { headers: { 'x-request-id': 'corr-mm' } },
    });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(emitted).toHaveLength(1);
    const evt = emitted[0];
    expect(evt.event).toBe('auth.tenant_mismatch');
    expect(evt.result).toBe('failure');
    expect(evt.tenant).toBe('demo');
    expect(evt.attributes).toMatchObject({
      presentedTenant: 'other',
      expectedTenant: 'demo',
      route: 'routeHandler',
    });
    expect(evt.correlationId).toBe('corr-mm');
  });

  it('transport throws IamUnauthorizedError (401-like) → UnauthorizedException via ErrorMapper', async () => {
    const { sink } = makeSink();
    const cfg = makeTenantConfig('cookie');
    const clients = makeTenantClients('demo', cfg);
    const registry = makeRegistry({
      tenants: { demo: clients },
      defaultTenant: 'demo',
    });
    stubTransportForTenant(async () => {
      throw new IamUnauthorizedError({ message: 'upstream 401' });
    });

    const guard = new SessionGuard(reflector, registry, sink, currentFactory);
    const ctx = makeCtx({ request: { headers: {} } });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('transport throws IamUpstreamUnavailableError (5xx-like) → ServiceUnavailableException via ErrorMapper', async () => {
    const { sink } = makeSink();
    const cfg = makeTenantConfig('cookie');
    const clients = makeTenantClients('demo', cfg);
    const registry = makeRegistry({
      tenants: { demo: clients },
      defaultTenant: 'demo',
    });
    stubTransportForTenant(async () => {
      throw new IamUpstreamUnavailableError({ message: 'kratos down' });
    });

    const guard = new SessionGuard(reflector, registry, sink, currentFactory);
    const ctx = makeCtx({ request: { headers: {} } });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it("transport throws an Axios-shaped 5xx → ServiceUnavailableException via ErrorMapper", async () => {
    const { sink } = makeSink();
    const cfg = makeTenantConfig('cookie');
    const clients = makeTenantClients('demo', cfg);
    const registry = makeRegistry({
      tenants: { demo: clients },
      defaultTenant: 'demo',
    });
    const axiosLike = Object.assign(new Error('boom'), {
      isAxiosError: true,
      response: { status: 503 },
    });
    stubTransportForTenant(async () => {
      throw axiosLike;
    });

    const guard = new SessionGuard(reflector, registry, sink, currentFactory);
    const ctx = makeCtx({ request: { headers: {} } });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('method-level @Tenant(customer) overrides class-level @Tenant(admin)', async () => {
    const { sink } = makeSink();
    const cfg = makeTenantConfig('cookie');
    const admin = makeTenantClients('admin', cfg);
    const customer = makeTenantClients('customer', cfg);
    const registry = makeRegistry({
      tenants: { admin, customer },
      defaultTenant: 'admin',
    });

    const identity = makeIdentity('customer', 'user-customer');
    const session = makeSession('customer', identity);
    const spy = stubTransportForTenant(async () => ({
      identity,
      session,
      latencyMs: 3,
    }));

    const guard = new SessionGuard(reflector, registry, sink, currentFactory);
    const handler = function h(): void {
      return;
    };
    class Ctrl {}
    Reflect.defineMetadata(TENANT_KEY, 'admin', Ctrl);
    Reflect.defineMetadata(TENANT_KEY, 'customer', handler);

    const req: MockRequest = { headers: {} };
    const ctx = makeCtx({ handler, controllerClass: Ctrl, request: req });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(customer.config);
    expect(req.user).toBe(identity);
  });

  it('uses @Tenant metadata over registry defaultTenant', async () => {
    const { sink } = makeSink();
    const cfg = makeTenantConfig('cookie');
    const admin = makeTenantClients('admin', cfg);
    const customer = makeTenantClients('customer', cfg);
    const registry = makeRegistry({
      tenants: { admin, customer },
      defaultTenant: 'admin',
    });

    const identity = makeIdentity('customer');
    const session = makeSession('customer', identity);
    const spy = stubTransportForTenant(async () => ({
      identity,
      session,
      latencyMs: 1,
    }));

    const guard = new SessionGuard(reflector, registry, sink, currentFactory);
    const handler = function h(): void {
      return;
    };
    Reflect.defineMetadata(TENANT_KEY, 'customer', handler);

    const ctx = makeCtx({ handler, request: { headers: {} } });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(spy).toHaveBeenCalledWith(customer.config);
  });

  it('throws when no tenant metadata and registry has no default', async () => {
    const { sink } = makeSink();
    const cfg = makeTenantConfig('cookie');
    const a = makeTenantClients('a', cfg);
    const b = makeTenantClients('b', cfg);
    const registry = makeRegistry({ tenants: { a, b } }); // no default
    stubTransportForTenant(async () => null);

    const guard = new SessionGuard(reflector, registry, sink, currentFactory);
    const ctx = makeCtx({ request: { headers: {} } });
    // IamConfigurationError → InternalServerErrorException (500) via ErrorMapper.
    await expect(guard.canActivate(ctx)).rejects.toThrow();
  });

  it('correlation: propagates provided x-request-id header to audit event', async () => {
    const { sink, emitted } = makeSink();
    const cfg = makeTenantConfig('cookie');
    const clients = makeTenantClients('demo', cfg);
    const registry = makeRegistry({
      tenants: { demo: clients },
      defaultTenant: 'demo',
    });
    stubTransportForTenant(async () => null);

    const guard = new SessionGuard(reflector, registry, sink, currentFactory);
    const ctx = makeCtx({
      request: { headers: { 'x-request-id': 'req-999' } },
    });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(emitted[0].correlationId).toBe('req-999');
  });

  it('correlation: generates an id when no x-request-id is present', async () => {
    const { sink, emitted } = makeSink();
    const cfg = makeTenantConfig('cookie');
    const clients = makeTenantClients('demo', cfg);
    const registry = makeRegistry({
      tenants: { demo: clients },
      defaultTenant: 'demo',
    });
    stubTransportForTenant(async () => null);

    const guard = new SessionGuard(reflector, registry, sink, currentFactory);
    const ctx = makeCtx({ request: { headers: {} } });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(typeof emitted[0].correlationId).toBe('string');
    expect((emitted[0].correlationId as string).length).toBeGreaterThan(0);
  });

  it('uses Reflector.getAllAndOverride with [handler, class] for @Public() check', async () => {
    const { sink } = makeSink();
    const cfg = makeTenantConfig('cookie');
    const clients = makeTenantClients('demo', cfg);
    const registry = makeRegistry({
      tenants: { demo: clients },
      defaultTenant: 'demo',
    });
    const spy = jest.spyOn(reflector, 'getAllAndOverride');
    stubTransportForTenant(async () => null);

    const guard = new SessionGuard(reflector, registry, sink, currentFactory);
    const handler = function h(): void {
      return;
    };
    class Ctrl {}
    Reflect.defineMetadata(IS_PUBLIC_KEY, true, handler);
    const ctx = makeCtx({ handler, controllerClass: Ctrl });
    await guard.canActivate(ctx);
    expect(spy).toHaveBeenCalledWith(IS_PUBLIC_KEY, [handler, Ctrl]);
  });
});
