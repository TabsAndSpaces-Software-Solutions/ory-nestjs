/**
 * Unit tests for `IdentityService` — the tenant-scoped facade around
 * Kratos Identity admin operations.
 *
 * The service exposes operations via `.forTenant(name)` which returns a
 * memoized `IdentityServiceFor` instance per tenant. All happy-path
 * methods translate the opaque Ory `IdentityApi` responses into library
 * DTOs via the existing `identityMapper` / `sessionMapper`; all error
 * paths are funneled through `ErrorMapper.toNest`. Missing admin-API
 * configuration on the tenant's `TenantClients` bundle surfaces as an
 * `IamConfigurationError` (never swallowed, never mapped to a NestJS
 * exception here — the caller's `ErrorMapper` decides that).
 *
 * Test strategy:
 *   - Stub `TenantRegistry` with a Map-backed implementation.
 *   - Fake `TenantClients.kratosIdentity` using Jest-spy functions.
 *   - For each method:
 *       1) Missing admin API  → throws `IamConfigurationError`.
 *       2) Happy path          → returns mapped DTO(s), spy called with
 *                                 the exact upstream payload shape.
 *       3) Upstream failure    → error propagated through
 *                                 `ErrorMapper.toNest` (401, 404/5xx).
 *   - `revokeSession` additionally asserts the `authz.session.revoke`
 *     audit event is emitted with correct tenant / result.
 *   - `.forTenant()` memoization returns stable references across calls.
 */
import 'reflect-metadata';
import {
  InternalServerErrorException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

import { IdentityService } from '../../../src/services/identity.service';
import type { AuditSink } from '../../../src/audit';
import type { TenantClients } from '../../../src/clients';
import type {
  TenantName,
  IamAuditEvent,
  IamIdentity,
  IamIdentityWithTraits,
} from '../../../src/dto';
import { IamConfigurationError } from '../../../src/errors';
import type { TenantRegistry } from '../../../src/module/registry/tenant-registry.service';

/** Minimal Ory Identity shape our stubbed spy returns. */
interface StubOryIdentity {
  id: string;
  schema_id: string;
  schema_url?: string;
  state?: 'active' | 'inactive';
  traits?: Record<string, unknown>;
  verifiable_addresses?: Array<{
    via: 'email' | 'sms' | 'phone';
    value: string;
    verified: boolean;
  }>;
  metadata_public?: Record<string, unknown>;
}

/** Minimal Ory Session shape. */
interface StubOrySession {
  id: string;
  active?: boolean;
  expires_at?: string;
  authenticated_at?: string;
  authentication_methods?: Array<{ method?: string }>;
  identity?: StubOryIdentity;
}

function buildOryIdentity(
  overrides?: Partial<StubOryIdentity>,
): StubOryIdentity {
  return {
    id: 'id-1',
    schema_id: 'default',
    schema_url: 'https://kratos/schemas/default',
    state: 'active',
    traits: { email: 'a@b.test' },
    verifiable_addresses: [
      { via: 'email', value: 'a@b.test', verified: true },
    ],
    metadata_public: { role: 'member' },
    ...overrides,
  };
}

function buildOrySession(
  overrides?: Partial<StubOrySession>,
): StubOrySession {
  return {
    id: 'sess-1',
    active: true,
    expires_at: '2030-01-01T00:00:00Z',
    authenticated_at: '2024-01-01T00:00:00Z',
    authentication_methods: [{ method: 'password' }],
    identity: buildOryIdentity(),
    ...overrides,
  };
}

interface SpyIdentityApi {
  getIdentity: jest.Mock;
  listIdentities: jest.Mock;
  createIdentity: jest.Mock;
  updateIdentity: jest.Mock;
  deleteIdentity: jest.Mock;
  listIdentitySessions: jest.Mock;
  disableSession: jest.Mock;
}

function makeSpyIdentityApi(): SpyIdentityApi {
  return {
    getIdentity: jest.fn(),
    listIdentities: jest.fn(),
    createIdentity: jest.fn(),
    updateIdentity: jest.fn(),
    deleteIdentity: jest.fn(),
    listIdentitySessions: jest.fn(),
    disableSession: jest.fn(),
  };
}

function makeClients(opts: {
  tenant: TenantName;
  identityApi?: SpyIdentityApi;
}): TenantClients {
  return {
    tenant: opts.tenant,
    config: {} as TenantClients['config'],
    axios: {} as TenantClients['axios'],
    kratosFrontend: {} as TenantClients['kratosFrontend'],
    kratosIdentity:
      opts.identityApi === undefined
        ? undefined
        : (opts.identityApi as unknown as TenantClients['kratosIdentity']),
  };
}

function makeRegistry(
  byTenant: Record<TenantName, TenantClients>,
): TenantRegistry {
  const get = (name: TenantName): TenantClients => {
    const clients = byTenant[name];
    if (!clients) {
      throw new IamConfigurationError({
        message: `unknown tenant: ${name}`,
      });
    }
    return clients;
  };
  const tryGet = (name: TenantName): TenantClients | undefined =>
    byTenant[name];
  return {
    get,
    tryGet,
    defaultTenant: () => undefined,
    list: () => Object.keys(byTenant),
  } as unknown as TenantRegistry;
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

/** Minimal AxiosError-shaped object for forcing ErrorMapper branches. */
function axiosErr(status: number): unknown {
  return {
    isAxiosError: true,
    response: { status, data: { error: 'x' } },
    message: `Request failed with status code ${status}`,
  };
}

describe('IdentityService', () => {
  describe('.forTenant() memoization', () => {
    it('returns the same instance for the same tenant across calls', () => {
      const api = makeSpyIdentityApi();
      const clients = makeClients({ tenant: 'customer', identityApi: api });
      const registry = makeRegistry({ customer: clients });
      const { sink } = makeSink();
      const service = new IdentityService(registry, sink);

      const a = service.forTenant('customer');
      const b = service.forTenant('customer');
      expect(a).toBe(b);
    });

    it('returns different instances for different tenants', () => {
      const api1 = makeSpyIdentityApi();
      const api2 = makeSpyIdentityApi();
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', identityApi: api1 }),
        admin: makeClients({ tenant: 'admin', identityApi: api2 }),
      });
      const { sink } = makeSink();
      const service = new IdentityService(registry, sink);

      const a = service.forTenant('customer');
      const b = service.forTenant('admin');
      expect(a).not.toBe(b);
    });
  });

  describe('.get(id)', () => {
    it('throws IamConfigurationError when tenant has no admin API', async () => {
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer' }),
      });
      const { sink } = makeSink();
      const service = new IdentityService(registry, sink);

      await expect(service.forTenant('customer').get('id-1')).rejects.toThrow(
        IamConfigurationError,
      );
    });

    it('returns a sanitized IamIdentity (no traits) on happy path', async () => {
      const api = makeSpyIdentityApi();
      api.getIdentity.mockResolvedValue({ data: buildOryIdentity() });
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', identityApi: api }),
      });
      const { sink } = makeSink();
      const service = new IdentityService(registry, sink);

      const out = (await service
        .forTenant('customer')
        .get('id-1')) as IamIdentity;

      expect(api.getIdentity).toHaveBeenCalledWith({ id: 'id-1' });
      expect(out.id).toBe('id-1');
      expect(out.schemaId).toBe('default');
      expect(out.state).toBe('active');
      expect(out.tenant).toBe('customer');
      expect(out.verifiedAddressesFlags).toEqual({ email: true, phone: false });
      expect((out as unknown as { traits?: unknown }).traits).toBeUndefined();
    });

    it('maps upstream 404 through ErrorMapper (rethrown as-is)', async () => {
      const api = makeSpyIdentityApi();
      api.getIdentity.mockRejectedValue(axiosErr(404));
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', identityApi: api }),
      });
      const { sink } = makeSink();
      const service = new IdentityService(registry, sink);

      // 404 is an unrecognized 4xx for ErrorMapper → rethrown.
      await expect(
        service.forTenant('customer').get('id-1'),
      ).rejects.toMatchObject({
        isAxiosError: true,
        response: { status: 404 },
      });
    });

    it('maps upstream 5xx through ErrorMapper to ServiceUnavailableException', async () => {
      const api = makeSpyIdentityApi();
      api.getIdentity.mockRejectedValue(axiosErr(503));
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', identityApi: api }),
      });
      const { sink } = makeSink();
      const service = new IdentityService(registry, sink);

      await expect(service.forTenant('customer').get('id-1')).rejects.toThrow(
        ServiceUnavailableException,
      );
    });
  });

  describe('.getWithTraits(id)', () => {
    it('throws IamConfigurationError when tenant has no admin API', async () => {
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer' }),
      });
      const { sink } = makeSink();
      const service = new IdentityService(registry, sink);

      await expect(
        service.forTenant('customer').getWithTraits('id-1'),
      ).rejects.toThrow(IamConfigurationError);
    });

    it('returns IamIdentityWithTraits including raw traits', async () => {
      const api = makeSpyIdentityApi();
      api.getIdentity.mockResolvedValue({
        data: buildOryIdentity({
          traits: { email: 'foo@bar.test', name: { first: 'F' } },
        }),
      });
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', identityApi: api }),
      });
      const { sink } = makeSink();
      const service = new IdentityService(registry, sink);

      const out = (await service
        .forTenant('customer')
        .getWithTraits('id-1')) as IamIdentityWithTraits;

      expect(api.getIdentity).toHaveBeenCalledWith({ id: 'id-1' });
      expect(out.traits).toEqual({
        email: 'foo@bar.test',
        name: { first: 'F' },
      });
      expect(out.tenant).toBe('customer');
    });

    it('maps upstream 401 through ErrorMapper to UnauthorizedException', async () => {
      const api = makeSpyIdentityApi();
      api.getIdentity.mockRejectedValue(axiosErr(401));
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', identityApi: api }),
      });
      const { sink } = makeSink();
      const service = new IdentityService(registry, sink);

      await expect(
        service.forTenant('customer').getWithTraits('id-1'),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('.list()', () => {
    it('throws IamConfigurationError when tenant has no admin API', async () => {
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer' }),
      });
      const { sink } = makeSink();
      const service = new IdentityService(registry, sink);

      await expect(service.forTenant('customer').list({})).rejects.toThrow(
        IamConfigurationError,
      );
    });

    it('maps every identity and sets nextPage when full page returned', async () => {
      const api = makeSpyIdentityApi();
      api.listIdentities.mockResolvedValue({
        data: [
          buildOryIdentity({ id: 'a' }),
          buildOryIdentity({ id: 'b' }),
        ],
      });
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', identityApi: api }),
      });
      const { sink } = makeSink();
      const service = new IdentityService(registry, sink);

      const out = await service
        .forTenant('customer')
        .list({ page: 1, perPage: 2 });

      expect(api.listIdentities).toHaveBeenCalledWith({ page: 1, perPage: 2 });
      expect(out.items.map((i) => i.id)).toEqual(['a', 'b']);
      expect(out.items.every((i) => i.tenant === 'customer')).toBe(true);
      expect(out.nextPage).toBe(2);
    });

    it('omits nextPage when returned items fewer than perPage', async () => {
      const api = makeSpyIdentityApi();
      api.listIdentities.mockResolvedValue({
        data: [buildOryIdentity({ id: 'a' })],
      });
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', identityApi: api }),
      });
      const { sink } = makeSink();
      const service = new IdentityService(registry, sink);

      const out = await service
        .forTenant('customer')
        .list({ page: 1, perPage: 5 });
      expect(out.items).toHaveLength(1);
      expect(out.nextPage).toBeUndefined();
    });

    it('maps upstream 5xx through ErrorMapper to ServiceUnavailableException', async () => {
      const api = makeSpyIdentityApi();
      api.listIdentities.mockRejectedValue(axiosErr(500));
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', identityApi: api }),
      });
      const { sink } = makeSink();
      const service = new IdentityService(registry, sink);

      await expect(service.forTenant('customer').list({})).rejects.toThrow(
        ServiceUnavailableException,
      );
    });
  });

  describe('.create(input)', () => {
    it('throws IamConfigurationError when tenant has no admin API', async () => {
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer' }),
      });
      const { sink } = makeSink();
      const service = new IdentityService(registry, sink);

      await expect(
        service.forTenant('customer').create({
          schemaId: 'default',
          traits: { email: 'a@b.test' },
        }),
      ).rejects.toThrow(IamConfigurationError);
    });

    it('translates library input into the Ory payload and returns traits', async () => {
      const api = makeSpyIdentityApi();
      const oryId = buildOryIdentity({ id: 'new-id' });
      api.createIdentity.mockResolvedValue({ data: oryId });
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', identityApi: api }),
      });
      const { sink } = makeSink();
      const service = new IdentityService(registry, sink);

      const out = await service.forTenant('customer').create({
        schemaId: 'default',
        traits: { email: 'n@t.test' },
        verifiedAddresses: [
          { via: 'email', value: 'n@t.test', verified: true },
        ],
      });

      expect(api.createIdentity).toHaveBeenCalledTimes(1);
      const call = api.createIdentity.mock.calls[0][0];
      expect(call.createIdentityBody.schema_id).toBe('default');
      expect(call.createIdentityBody.traits).toEqual({ email: 'n@t.test' });
      expect(call.createIdentityBody.verifiable_addresses).toEqual([
        { via: 'email', value: 'n@t.test', verified: true },
      ]);
      expect(out.id).toBe('new-id');
      expect(out.traits).toEqual({ email: 'a@b.test' });
      expect(out.tenant).toBe('customer');
    });

    it('maps upstream 5xx through ErrorMapper to ServiceUnavailableException', async () => {
      const api = makeSpyIdentityApi();
      api.createIdentity.mockRejectedValue(axiosErr(500));
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', identityApi: api }),
      });
      const { sink } = makeSink();
      const service = new IdentityService(registry, sink);

      await expect(
        service.forTenant('customer').create({
          schemaId: 'default',
          traits: { email: 'a@b.test' },
        }),
      ).rejects.toThrow(ServiceUnavailableException);
    });
  });

  describe('.updateTraits(id, traits)', () => {
    it('throws IamConfigurationError when tenant has no admin API', async () => {
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer' }),
      });
      const { sink } = makeSink();
      const service = new IdentityService(registry, sink);

      await expect(
        service.forTenant('customer').updateTraits('id-1', { email: 'x@y.z' }),
      ).rejects.toThrow(IamConfigurationError);
    });

    it('fetches existing identity to preserve schema_id, then updates with new traits', async () => {
      const api = makeSpyIdentityApi();
      api.getIdentity.mockResolvedValue({
        data: buildOryIdentity({ schema_id: 'custom-schema' }),
      });
      api.updateIdentity.mockResolvedValue({
        data: buildOryIdentity({
          schema_id: 'custom-schema',
          traits: { email: 'new@y.z' },
        }),
      });
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', identityApi: api }),
      });
      const { sink } = makeSink();
      const service = new IdentityService(registry, sink);

      const out = await service
        .forTenant('customer')
        .updateTraits('id-1', { email: 'new@y.z' });

      expect(api.getIdentity).toHaveBeenCalledWith({ id: 'id-1' });
      expect(api.updateIdentity).toHaveBeenCalledTimes(1);
      const call = api.updateIdentity.mock.calls[0][0];
      expect(call.id).toBe('id-1');
      expect(call.updateIdentityBody.schema_id).toBe('custom-schema');
      expect(call.updateIdentityBody.traits).toEqual({ email: 'new@y.z' });
      expect(call.updateIdentityBody.state).toBe('active');

      expect(out.traits).toEqual({ email: 'new@y.z' });
      expect(out.tenant).toBe('customer');
    });

    it('maps upstream 5xx through ErrorMapper to ServiceUnavailableException', async () => {
      const api = makeSpyIdentityApi();
      api.getIdentity.mockResolvedValue({ data: buildOryIdentity() });
      api.updateIdentity.mockRejectedValue(axiosErr(500));
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', identityApi: api }),
      });
      const { sink } = makeSink();
      const service = new IdentityService(registry, sink);

      await expect(
        service
          .forTenant('customer')
          .updateTraits('id-1', { email: 'x@y.z' }),
      ).rejects.toThrow(ServiceUnavailableException);
    });
  });

  describe('.delete(id)', () => {
    it('throws IamConfigurationError when tenant has no admin API', async () => {
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer' }),
      });
      const { sink } = makeSink();
      const service = new IdentityService(registry, sink);

      await expect(service.forTenant('customer').delete('id-1')).rejects.toThrow(
        IamConfigurationError,
      );
    });

    it('calls deleteIdentity and returns void on happy path', async () => {
      const api = makeSpyIdentityApi();
      api.deleteIdentity.mockResolvedValue({ data: undefined });
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', identityApi: api }),
      });
      const { sink } = makeSink();
      const service = new IdentityService(registry, sink);

      const out = await service.forTenant('customer').delete('id-1');

      expect(api.deleteIdentity).toHaveBeenCalledWith({ id: 'id-1' });
      expect(out).toBeUndefined();
    });

    it('maps upstream 401 through ErrorMapper to UnauthorizedException', async () => {
      const api = makeSpyIdentityApi();
      api.deleteIdentity.mockRejectedValue(axiosErr(401));
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', identityApi: api }),
      });
      const { sink } = makeSink();
      const service = new IdentityService(registry, sink);

      await expect(service.forTenant('customer').delete('id-1')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('.listSessions(id)', () => {
    it('throws IamConfigurationError when tenant has no admin API', async () => {
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer' }),
      });
      const { sink } = makeSink();
      const service = new IdentityService(registry, sink);

      await expect(
        service.forTenant('customer').listSessions('id-1'),
      ).rejects.toThrow(IamConfigurationError);
    });

    it('maps every session through sessionMapper', async () => {
      const api = makeSpyIdentityApi();
      api.listIdentitySessions.mockResolvedValue({
        data: [
          buildOrySession({ id: 's1' }),
          buildOrySession({ id: 's2' }),
        ],
      });
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', identityApi: api }),
      });
      const { sink } = makeSink();
      const service = new IdentityService(registry, sink);

      const out = await service.forTenant('customer').listSessions('id-1');

      expect(api.listIdentitySessions).toHaveBeenCalledWith({ id: 'id-1' });
      expect(out).toHaveLength(2);
      expect(out.map((s) => s.id)).toEqual(['s1', 's2']);
      expect(out.every((s) => s.tenant === 'customer')).toBe(true);
    });

    it('maps upstream 5xx through ErrorMapper to ServiceUnavailableException', async () => {
      const api = makeSpyIdentityApi();
      api.listIdentitySessions.mockRejectedValue(axiosErr(500));
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', identityApi: api }),
      });
      const { sink } = makeSink();
      const service = new IdentityService(registry, sink);

      await expect(
        service.forTenant('customer').listSessions('id-1'),
      ).rejects.toThrow(ServiceUnavailableException);
    });
  });

  describe('.revokeSession(sessionId)', () => {
    it('throws IamConfigurationError when tenant has no admin API', async () => {
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer' }),
      });
      const { sink } = makeSink();
      const service = new IdentityService(registry, sink);

      await expect(
        service.forTenant('customer').revokeSession('sess-1'),
      ).rejects.toThrow(IamConfigurationError);
    });

    it('disables the session and emits authz.session.revoke on success', async () => {
      const api = makeSpyIdentityApi();
      api.disableSession.mockResolvedValue({ data: undefined });
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', identityApi: api }),
      });
      const { sink, emitted } = makeSink();
      const service = new IdentityService(registry, sink);

      await service.forTenant('customer').revokeSession('sess-1');

      expect(api.disableSession).toHaveBeenCalledWith({ id: 'sess-1' });
      expect(emitted).toHaveLength(1);
      expect(emitted[0].event).toBe('authz.session.revoke');
      expect(emitted[0].tenant).toBe('customer');
      expect(emitted[0].result).toBe('success');
      expect(emitted[0].targetId).toBe('sess-1');
    });

    it('maps upstream 500 through ErrorMapper and does NOT emit on failure', async () => {
      const api = makeSpyIdentityApi();
      api.disableSession.mockRejectedValue(axiosErr(500));
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', identityApi: api }),
      });
      const { sink, emitted } = makeSink();
      const service = new IdentityService(registry, sink);

      await expect(
        service.forTenant('customer').revokeSession('sess-1'),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(emitted).toHaveLength(0);
    });
  });

  describe('no raw Ory payload leakage', () => {
    it('.get result has no Ory-style snake_case keys', async () => {
      const api = makeSpyIdentityApi();
      api.getIdentity.mockResolvedValue({ data: buildOryIdentity() });
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', identityApi: api }),
      });
      const { sink } = makeSink();
      const service = new IdentityService(registry, sink);

      const out = (await service
        .forTenant('customer')
        .get('id-1')) as unknown as Record<string, unknown>;
      for (const key of Object.keys(out)) {
        expect(key).not.toMatch(/_/);
      }
    });
  });

  describe('ErrorMapper InternalServerErrorException branch', () => {
    it('.get surfaces IamConfigurationError unmapped (bubbles to caller)', async () => {
      // The service itself throws IamConfigurationError; it's up to the
      // transport/guard layer to run that through ErrorMapper. The
      // service MUST NOT convert it into a NestJS exception.
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer' }),
      });
      const { sink } = makeSink();
      const service = new IdentityService(registry, sink);

      let caught: unknown;
      try {
        await service.forTenant('customer').get('id-1');
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(IamConfigurationError);
      expect(caught).not.toBeInstanceOf(InternalServerErrorException);
    });
  });
});
