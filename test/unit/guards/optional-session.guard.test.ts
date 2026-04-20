/**
 * Unit tests for `OptionalSessionGuard`.
 *
 * Same flow as SessionGuard, but when the credential is missing the guard
 * MUST set `req.user = null` and return true instead of throwing. Upstream
 * errors (e.g. Ory 401 / 5xx) still surface via ErrorMapper.
 */
import 'reflect-metadata';
import {
  ExecutionContext,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { OptionalSessionGuard } from '../../../src/guards/optional-session.guard';
import {
  IS_PUBLIC_KEY,
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
import type { TenantConfig } from '../../../src/config';
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

function makeTenantConfig(transport: TenantConfig['transport']): TenantConfig {
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
  } as unknown as TenantConfig;
}

function makeTenantClients(
  name: TenantName,
  config: TenantConfig,
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
    tenantConfig: TenantConfig,
  ) => Promise<ResolvedSession | null>,
): jest.Mock {
  const transport: SessionTransport = { resolve: impl };
  const spy = jest.fn().mockReturnValue(transport);
  currentFactory = { forTenant: spy } as unknown as TransportFactory;
  return spy;
}

describe('OptionalSessionGuard', () => {
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
    jest.restoreAllMocks();
    currentFactory = {
      forTenant: jest
        .fn()
        .mockReturnValue({ resolve: async () => null } as SessionTransport),
    } as unknown as TransportFactory;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('short-circuits true for @Public() handler', async () => {
    const { sink, emitted } = makeSink();
    const cfg = makeTenantConfig('cookie');
    const clients = makeTenantClients('demo', cfg);
    const registry = makeRegistry({
      tenants: { demo: clients },
      defaultTenant: 'demo',
    });
    const spy = stubTransportForTenant(async () => null);

    const guard = new OptionalSessionGuard(reflector, registry, sink, currentFactory);
    const handler = function h(): void {
      return;
    };
    Reflect.defineMetadata(IS_PUBLIC_KEY, true, handler);
    const ctx = makeCtx({ handler });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);

    expect(spy).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(0);
  });

  it('missing credential → returns true and sets req.user = null (NO audit)', async () => {
    const { sink, emitted } = makeSink();
    const cfg = makeTenantConfig('cookie');
    const clients = makeTenantClients('demo', cfg);
    const registry = makeRegistry({
      tenants: { demo: clients },
      defaultTenant: 'demo',
    });
    stubTransportForTenant(async () => null);

    const guard = new OptionalSessionGuard(reflector, registry, sink, currentFactory);
    const req: MockRequest = { headers: {} };
    const ctx = makeCtx({ request: req });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.user).toBeNull();
    // OptionalSessionGuard must NOT emit a missing-credential failure audit —
    // missing credentials are a legitimate state for optional auth.
    expect(emitted).toHaveLength(0);
  });

  it('success → attaches user + session, emits auth.success', async () => {
    const { sink, emitted } = makeSink();
    const cfg = makeTenantConfig('cookie');
    const clients = makeTenantClients('demo', cfg);
    const registry = makeRegistry({
      tenants: { demo: clients },
      defaultTenant: 'demo',
    });

    const identity = makeIdentity('demo', 'user-opt');
    const session = makeSession('demo', identity);
    stubTransportForTenant(async () => ({ identity, session, latencyMs: 7 }));

    const guard = new OptionalSessionGuard(reflector, registry, sink, currentFactory);
    const req: MockRequest = { headers: {} };
    const ctx = makeCtx({ request: req });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.user).toBe(identity);
    expect(req.session).toBe(session);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].event).toBe('auth.success');
    expect(emitted[0].actorId).toBe('user-opt');
  });

  it('tenant mismatch → emits auth.tenant_mismatch and still throws UnauthorizedException', async () => {
    const { sink, emitted } = makeSink();
    const cfg = makeTenantConfig('cookie');
    const clients = makeTenantClients('demo', cfg);
    const registry = makeRegistry({
      tenants: { demo: clients },
      defaultTenant: 'demo',
    });

    const identity = makeIdentity('other');
    const session = makeSession('other', identity);
    stubTransportForTenant(async () => ({ identity, session, latencyMs: 1 }));

    const guard = new OptionalSessionGuard(reflector, registry, sink, currentFactory);
    const ctx = makeCtx({ request: { headers: {} } });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0].event).toBe('auth.tenant_mismatch');
  });

  it('upstream IamUnauthorizedError → UnauthorizedException via ErrorMapper', async () => {
    const { sink } = makeSink();
    const cfg = makeTenantConfig('cookie');
    const clients = makeTenantClients('demo', cfg);
    const registry = makeRegistry({
      tenants: { demo: clients },
      defaultTenant: 'demo',
    });
    stubTransportForTenant(async () => {
      throw new IamUnauthorizedError({ message: '401 upstream' });
    });

    const guard = new OptionalSessionGuard(reflector, registry, sink, currentFactory);
    const ctx = makeCtx({ request: { headers: {} } });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('upstream IamUpstreamUnavailableError → ServiceUnavailableException via ErrorMapper', async () => {
    const { sink } = makeSink();
    const cfg = makeTenantConfig('cookie');
    const clients = makeTenantClients('demo', cfg);
    const registry = makeRegistry({
      tenants: { demo: clients },
      defaultTenant: 'demo',
    });
    stubTransportForTenant(async () => {
      throw new IamUpstreamUnavailableError({ message: '503 upstream' });
    });

    const guard = new OptionalSessionGuard(reflector, registry, sink, currentFactory);
    const ctx = makeCtx({ request: { headers: {} } });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('method-level @Tenant overrides class-level @Tenant', async () => {
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
      latencyMs: 3,
    }));

    const guard = new OptionalSessionGuard(reflector, registry, sink, currentFactory);
    const handler = function h(): void {
      return;
    };
    class Ctrl {}
    Reflect.defineMetadata(TENANT_KEY, 'admin', Ctrl);
    Reflect.defineMetadata(TENANT_KEY, 'customer', handler);

    const ctx = makeCtx({ handler, controllerClass: Ctrl });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(spy).toHaveBeenCalledWith(customer.config);
  });
});
