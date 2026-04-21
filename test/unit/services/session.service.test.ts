/**
 * Unit tests for `SessionService` (spec unit `ses`).
 *
 * Covers the full SessionService contract:
 *   - `SessionService.forTenant(name)` returns a stable, memoized wrapper.
 *   - `whoami(req)` delegates to the tenant's `SessionTransport` and returns
 *     the resolved `IamSession`.
 *   - `whoami(req)` with no credentials (transport returns null) throws
 *     `UnauthorizedException` via `ErrorMapper` (IamUnauthorizedError).
 *   - `whoami(req)` with upstream 5xx throws `ServiceUnavailableException`
 *     (IamUpstreamUnavailableError is NOT swallowed).
 *   - `whoamiOrNull(req)` with no credentials returns `null`.
 *   - `whoamiOrNull(req)` with upstream failure still throws — NO try/catch
 *     swallowing.
 *   - `revoke(id)` without `kratosIdentity` configured throws
 *     `IamConfigurationError`.
 *   - `revoke(id)` happy path: calls `disableSession({ id })` and emits an
 *     `authz.session.revoke` audit event tagged with the tenant + targetId.
 *   - `revoke(id)` upstream 404 is translated via `ErrorMapper` (NotFound
 *     is not mapped by IamError → so axios 404 rethrown unchanged, but axios
 *     5xx maps to 503). We assert the rethrow behavior for 404.
 */
import 'reflect-metadata';
import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

import { SessionService } from '../../../src/services/session.service';
import { AUDIT_SINK, type AuditSink } from '../../../src/audit';
import type { TenantClients } from '../../../src/clients';
import type { ValidatedTenantConfig } from '../../../src/config';
import type {
  TenantName,
  IamAuditEvent,
  IamIdentity,
  IamSession,
} from '../../../src/dto';
import type { TenantRegistry } from '../../../src/module/registry/tenant-registry.service';
import { TENANT_REGISTRY } from '../../../src/module/registry/tokens';
import type {
  RequestLike,
  ResolvedSession,
  SessionTransport,
} from '../../../src/transport';
import { TransportFactory } from '../../../src/transport/transport.factory';
import {
  IamConfigurationError,
  IamUnauthorizedError,
  IamUpstreamUnavailableError,
} from '../../../src/errors';

// ---------- test helpers ----------

interface MockRequest {
  headers: Record<string, string | string[] | undefined>;
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
  } as unknown as ValidatedTenantConfig;
}

function makeTenantClients(
  name: TenantName,
  config: ValidatedTenantConfig,
  overrides: Partial<TenantClients> = {},
): TenantClients {
  return {
    tenant: name,
    config,
    axios: {} as never,
    kratosFrontend: {} as never,
    ...overrides,
  } as unknown as TenantClients;
}

function makeRegistry(opts: {
  tenants: Record<TenantName, TenantClients>;
}): TenantRegistry {
  return {
    get: (name: TenantName): TenantClients => {
      const c = opts.tenants[name];
      if (c === undefined) {
        throw new IamConfigurationError({ message: `unknown tenant: ${name}` });
      }
      return c;
    },
    tryGet: (name: TenantName): TenantClients | undefined =>
      opts.tenants[name],
    defaultTenant: (): TenantName | undefined => undefined,
    list: (): TenantName[] => Object.keys(opts.tenants),
  } as unknown as TenantRegistry;
}

function makeIdentity(tenant: TenantName, id = 'user-1'): IamIdentity {
  return {
    id,
    schemaId: 'default',
    state: 'active',
    verifiedAddressesFlags: { email: true, phone: false },
    tenant,
  } as unknown as IamIdentity;
}

function makeSession(tenant: TenantName, identity: IamIdentity): IamSession {
  return {
    id: 'sess-1',
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

// ---------- tests ----------

describe('SessionService', () => {
  beforeEach(() => {
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

  describe('forTenant(name)', () => {
    it('returns a stable, memoized wrapper for the same tenant name', () => {
      const { sink } = makeSink();
      const cfg = makeTenantConfig('cookie');
      const clients = makeTenantClients('demo', cfg);
      const registry = makeRegistry({ tenants: { demo: clients } });

      const service = new SessionService(registry, sink, currentFactory);
      const a = service.forTenant('demo');
      const b = service.forTenant('demo');
      expect(a).toBe(b);
    });

    it('returns distinct wrappers for distinct tenant names', () => {
      const { sink } = makeSink();
      const cfg = makeTenantConfig('cookie');
      const a = makeTenantClients('a', cfg);
      const b = makeTenantClients('b', cfg);
      const registry = makeRegistry({ tenants: { a, b } });

      const service = new SessionService(registry, sink, currentFactory);
      const wrapA = service.forTenant('a');
      const wrapB = service.forTenant('b');
      expect(wrapA).not.toBe(wrapB);
    });
  });

  describe('whoami(req)', () => {
    it('resolves session via the tenant transport on success', async () => {
      const { sink } = makeSink();
      const cfg = makeTenantConfig('cookie');
      const clients = makeTenantClients('demo', cfg);
      const registry = makeRegistry({ tenants: { demo: clients } });

      const identity = makeIdentity('demo', 'user-42');
      const session = makeSession('demo', identity);
      const resolved: ResolvedSession = {
        identity,
        session,
        latencyMs: 10,
      };
      const spy = stubTransportForTenant(async () => resolved);

      const service = new SessionService(registry, sink, currentFactory);
      const req: MockRequest = { headers: {} };

      const result = await service.forTenant('demo').whoami(req);
      expect(result).toBe(session);
      expect(spy).toHaveBeenCalledWith(cfg);
    });

    it('throws UnauthorizedException when transport returns null (no credential)', async () => {
      const { sink } = makeSink();
      const cfg = makeTenantConfig('cookie');
      const clients = makeTenantClients('demo', cfg);
      const registry = makeRegistry({ tenants: { demo: clients } });
      stubTransportForTenant(async () => null);

      const service = new SessionService(registry, sink, currentFactory);
      const req: MockRequest = { headers: {} };

      await expect(service.forTenant('demo').whoami(req)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('throws ServiceUnavailableException when transport throws IamUpstreamUnavailableError', async () => {
      const { sink } = makeSink();
      const cfg = makeTenantConfig('cookie');
      const clients = makeTenantClients('demo', cfg);
      const registry = makeRegistry({ tenants: { demo: clients } });
      stubTransportForTenant(async () => {
        throw new IamUpstreamUnavailableError({ message: 'kratos down' });
      });

      const service = new SessionService(registry, sink, currentFactory);
      const req: MockRequest = { headers: {} };

      await expect(service.forTenant('demo').whoami(req)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('propagates IamUnauthorizedError thrown by the transport (not hidden as null)', async () => {
      const { sink } = makeSink();
      const cfg = makeTenantConfig('cookie');
      const clients = makeTenantClients('demo', cfg);
      const registry = makeRegistry({ tenants: { demo: clients } });
      stubTransportForTenant(async () => {
        throw new IamUnauthorizedError({ message: 'upstream 401' });
      });

      const service = new SessionService(registry, sink, currentFactory);
      const req: MockRequest = { headers: {} };

      await expect(service.forTenant('demo').whoami(req)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });
  });

  describe('whoamiOrNull(req)', () => {
    it('returns null when transport returns null (unauthenticated)', async () => {
      const { sink } = makeSink();
      const cfg = makeTenantConfig('cookie');
      const clients = makeTenantClients('demo', cfg);
      const registry = makeRegistry({ tenants: { demo: clients } });
      stubTransportForTenant(async () => null);

      const service = new SessionService(registry, sink, currentFactory);
      const req: MockRequest = { headers: {} };

      const result = await service.forTenant('demo').whoamiOrNull(req);
      expect(result).toBeNull();
    });

    it('returns the resolved session on success', async () => {
      const { sink } = makeSink();
      const cfg = makeTenantConfig('cookie');
      const clients = makeTenantClients('demo', cfg);
      const registry = makeRegistry({ tenants: { demo: clients } });

      const identity = makeIdentity('demo', 'user-7');
      const session = makeSession('demo', identity);
      stubTransportForTenant(async () => ({
        identity,
        session,
        latencyMs: 2,
      }));

      const service = new SessionService(registry, sink, currentFactory);
      const req: MockRequest = { headers: {} };

      const result = await service.forTenant('demo').whoamiOrNull(req);
      expect(result).toBe(session);
    });

    it('does NOT swallow upstream failures — throws on IamUpstreamUnavailableError', async () => {
      const { sink } = makeSink();
      const cfg = makeTenantConfig('cookie');
      const clients = makeTenantClients('demo', cfg);
      const registry = makeRegistry({ tenants: { demo: clients } });
      stubTransportForTenant(async () => {
        throw new IamUpstreamUnavailableError({ message: 'kratos 503' });
      });

      const service = new SessionService(registry, sink, currentFactory);
      const req: MockRequest = { headers: {} };

      await expect(
        service.forTenant('demo').whoamiOrNull(req),
      ).rejects.toBeInstanceOf(IamUpstreamUnavailableError);
    });
  });

  describe('revoke(sessionId)', () => {
    it('throws IamConfigurationError when the tenant has no kratosIdentity admin client', async () => {
      const { sink, emitted } = makeSink();
      const cfg = makeTenantConfig('cookie');
      // No kratosIdentity on this client bundle.
      const clients = makeTenantClients('demo', cfg);
      const registry = makeRegistry({ tenants: { demo: clients } });

      const service = new SessionService(registry, sink, currentFactory);
      await expect(
        service.forTenant('demo').revoke('sess-zzz'),
      ).rejects.toBeInstanceOf(IamConfigurationError);
      expect(emitted).toHaveLength(0);
    });

    it('happy path: calls disableSession({ id }) and emits authz.session.revoke', async () => {
      const { sink, emitted } = makeSink();
      const cfg = makeTenantConfig('cookie');
      const disableSession = jest.fn().mockResolvedValue({ data: undefined });
      const clients = makeTenantClients('demo', cfg, {
        kratosIdentity: { disableSession } as unknown as TenantClients['kratosIdentity'],
      });
      const registry = makeRegistry({ tenants: { demo: clients } });

      const service = new SessionService(registry, sink, currentFactory);
      await service.forTenant('demo').revoke('sess-xyz');

      expect(disableSession).toHaveBeenCalledWith({ id: 'sess-xyz' });
      expect(emitted).toHaveLength(1);
      const evt = emitted[0];
      expect(evt.event).toBe('authz.session.revoke');
      expect(evt.tenant).toBe('demo');
      expect(evt.targetId).toBe('sess-xyz');
      expect(evt.result).toBe('success');
      expect(evt.attributes).toEqual({});
      expect(typeof evt.timestamp).toBe('string');
    });

    it('upstream axios 5xx → ServiceUnavailableException via ErrorMapper; no audit event emitted', async () => {
      const { sink, emitted } = makeSink();
      const cfg = makeTenantConfig('cookie');
      const axiosErr = Object.assign(new Error('boom'), {
        isAxiosError: true,
        response: { status: 503 },
      });
      const disableSession = jest.fn().mockRejectedValue(axiosErr);
      const clients = makeTenantClients('demo', cfg, {
        kratosIdentity: { disableSession } as unknown as TenantClients['kratosIdentity'],
      });
      const registry = makeRegistry({ tenants: { demo: clients } });

      const service = new SessionService(registry, sink, currentFactory);
      await expect(
        service.forTenant('demo').revoke('sess-1'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(emitted).toHaveLength(0);
    });

    it('happy path: invalidates the session cache before emitting the audit event', async () => {
      const { sink, emitted } = makeSink();
      const cfg = makeTenantConfig('cookie');
      const disableSession = jest.fn().mockResolvedValue({ data: undefined });
      const clients = makeTenantClients('demo', cfg, {
        kratosIdentity: { disableSession } as unknown as TenantClients['kratosIdentity'],
      });
      const registry = makeRegistry({ tenants: { demo: clients } });
      const deleteBySessionId = jest.fn().mockResolvedValue(undefined);
      const cache = {
        get: jest.fn(),
        set: jest.fn(),
        delete: jest.fn(),
        deleteBySessionId,
      };

      const service = new SessionService(registry, sink, currentFactory, cache as never);
      await service.forTenant('demo').revoke('sess-xyz');

      expect(deleteBySessionId).toHaveBeenCalledWith('demo', 'sess-xyz');
      // Revoke emits exactly one audit event after successful eviction.
      expect(emitted).toHaveLength(1);
      expect(emitted[0].event).toBe('authz.session.revoke');
    });

    it('cache.deleteBySessionId throwing: revoke still succeeds and audits (fail-open)', async () => {
      const { sink, emitted } = makeSink();
      const cfg = makeTenantConfig('cookie');
      const disableSession = jest.fn().mockResolvedValue({ data: undefined });
      const clients = makeTenantClients('demo', cfg, {
        kratosIdentity: { disableSession } as unknown as TenantClients['kratosIdentity'],
      });
      const registry = makeRegistry({ tenants: { demo: clients } });
      const cache = {
        get: jest.fn(),
        set: jest.fn(),
        delete: jest.fn(),
        deleteBySessionId: jest.fn().mockRejectedValue(new Error('redis down')),
      };

      const service = new SessionService(registry, sink, currentFactory, cache as never);
      await service.forTenant('demo').revoke('sess-xyz');

      expect(disableSession).toHaveBeenCalledTimes(1);
      expect(emitted).toHaveLength(1);
      expect(emitted[0].event).toBe('authz.session.revoke');
    });

    it('upstream axios 404 → rethrow unchanged via ErrorMapper (unknown 4xx)', async () => {
      const { sink, emitted } = makeSink();
      const cfg = makeTenantConfig('cookie');
      const axiosErr = Object.assign(new Error('not found'), {
        isAxiosError: true,
        response: { status: 404 },
      });
      const disableSession = jest.fn().mockRejectedValue(axiosErr);
      const clients = makeTenantClients('demo', cfg, {
        kratosIdentity: { disableSession } as unknown as TenantClients['kratosIdentity'],
      });
      const registry = makeRegistry({ tenants: { demo: clients } });

      const service = new SessionService(registry, sink, currentFactory);
      await expect(
        service.forTenant('demo').revoke('sess-missing'),
      ).rejects.toBe(axiosErr);
      expect(emitted).toHaveLength(0);
    });
  });

  describe('DI tokens', () => {
    it('TENANT_REGISTRY and AUDIT_SINK symbols are exported (smoke)', () => {
      // Ensures the test file's DI token imports match the real tokens.
      expect(typeof TENANT_REGISTRY).toBe('symbol');
      expect(typeof AUDIT_SINK).toBe('symbol');
    });
  });
});
