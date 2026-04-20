/**
 * Unit tests for `PermissionService` (spec unit `prs`).
 *
 * Contract:
 *   - `.forTenant(name)` returns a stable, memoized `PermissionServiceFor`.
 *   - `.check(tuple)`:
 *       - calls `clients.ketoPermission.checkPermission(...)` and returns
 *         `data.allowed` as a boolean.
 *       - throws `IamConfigurationError` when `ketoPermission` is absent.
 *       - upstream 5xx → `ServiceUnavailableException` via `ErrorMapper`.
 *   - `.grant(tuple)`:
 *       - calls `clients.ketoRelationship.createRelationship(...)`.
 *       - emits `authz.permission.grant` on success.
 *       - treats 409 conflict as idempotent success (no throw, still emits).
 *       - upstream 5xx → `ServiceUnavailableException` via `ErrorMapper`;
 *         no audit event emitted on failure.
 *       - throws `IamConfigurationError` when `ketoRelationship` is absent.
 *   - `.revoke(tuple)`:
 *       - calls `clients.ketoRelationship.deleteRelationships(...)`.
 *       - emits `authz.permission.revoke` on success.
 *       - treats 404 as idempotent success (no throw, still emits).
 *       - upstream 5xx → `ServiceUnavailableException` via `ErrorMapper`;
 *         no audit event emitted on failure.
 *       - throws `IamConfigurationError` when `ketoRelationship` is absent.
 *   - `.list(query)`:
 *       - calls `clients.ketoRelationship.getRelationships(...)` and maps
 *         each tuple into a `IamPermissionTuple`.
 *       - propagates `nextPageToken` when present.
 *       - throws `IamConfigurationError` when `ketoRelationship` is absent.
 */
import 'reflect-metadata';
import { ServiceUnavailableException } from '@nestjs/common';

import { PermissionService } from '../../../src/services/permission.service';
import type { AuditSink } from '../../../src/audit';
import type { TenantClients } from '../../../src/clients';
import type {
  TenantName,
  IamAuditEvent,
  IamPermissionTuple,
} from '../../../src/dto';
import { IamConfigurationError } from '../../../src/errors';
import type { TenantRegistry } from '../../../src/module/registry/tenant-registry.service';

// ---------- spy factories ----------

interface SpyPermissionApi {
  checkPermission: jest.Mock;
}

interface SpyRelationshipApi {
  createRelationship: jest.Mock;
  deleteRelationships: jest.Mock;
  getRelationships: jest.Mock;
}

function makeSpyPermissionApi(): SpyPermissionApi {
  return {
    checkPermission: jest.fn(),
  };
}

function makeSpyRelationshipApi(): SpyRelationshipApi {
  return {
    createRelationship: jest.fn(),
    deleteRelationships: jest.fn(),
    getRelationships: jest.fn(),
  };
}

function makeClients(opts: {
  tenant: TenantName;
  ketoPermission?: SpyPermissionApi;
  ketoRelationship?: SpyRelationshipApi;
}): TenantClients {
  return {
    tenant: opts.tenant,
    config: {} as TenantClients['config'],
    axios: {} as TenantClients['axios'],
    kratosFrontend: {} as TenantClients['kratosFrontend'],
    ketoPermission:
      opts.ketoPermission === undefined
        ? undefined
        : (opts.ketoPermission as unknown as TenantClients['ketoPermission']),
    ketoRelationship:
      opts.ketoRelationship === undefined
        ? undefined
        : (opts.ketoRelationship as unknown as TenantClients['ketoRelationship']),
  };
}

function makeRegistry(
  byTenant: Record<TenantName, TenantClients>,
): TenantRegistry {
  return {
    get: (name: TenantName): TenantClients => {
      const clients = byTenant[name];
      if (!clients) {
        throw new IamConfigurationError({
          message: `unknown tenant: ${name}`,
        });
      }
      return clients;
    },
    tryGet: (name: TenantName): TenantClients | undefined => byTenant[name],
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

function makeTuple(
  overrides?: Partial<IamPermissionTuple>,
): IamPermissionTuple {
  return {
    namespace: 'documents',
    object: 'doc-1',
    relation: 'viewer',
    subject: 'user:alice',
    tenant: 'customer',
    ...overrides,
  };
}

/** AxiosError-shaped object for forcing ErrorMapper branches. */
function axiosErr(status: number): unknown {
  return {
    isAxiosError: true,
    response: { status, data: { error: 'x' } },
    message: `Request failed with status code ${status}`,
  };
}

// ---------- tests ----------

describe('PermissionService', () => {
  describe('.forTenant() memoization', () => {
    it('returns the same instance for the same tenant across calls', () => {
      const perm = makeSpyPermissionApi();
      const rel = makeSpyRelationshipApi();
      const registry = makeRegistry({
        customer: makeClients({
          tenant: 'customer',
          ketoPermission: perm,
          ketoRelationship: rel,
        }),
      });
      const { sink } = makeSink();
      const service = new PermissionService(registry, sink);

      const a = service.forTenant('customer');
      const b = service.forTenant('customer');
      expect(a).toBe(b);
    });

    it('returns different instances for different tenants', () => {
      const registry = makeRegistry({
        customer: makeClients({
          tenant: 'customer',
          ketoPermission: makeSpyPermissionApi(),
          ketoRelationship: makeSpyRelationshipApi(),
        }),
        admin: makeClients({
          tenant: 'admin',
          ketoPermission: makeSpyPermissionApi(),
          ketoRelationship: makeSpyRelationshipApi(),
        }),
      });
      const { sink } = makeSink();
      const service = new PermissionService(registry, sink);

      const a = service.forTenant('customer');
      const b = service.forTenant('admin');
      expect(a).not.toBe(b);
    });
  });

  describe('.check(tuple)', () => {
    it('throws IamConfigurationError when ketoPermission is absent', async () => {
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer' }),
      });
      const { sink } = makeSink();
      const service = new PermissionService(registry, sink);

      await expect(
        service.forTenant('customer').check(makeTuple()),
      ).rejects.toThrow(IamConfigurationError);
    });

    it('returns true when upstream reports allowed=true', async () => {
      const perm = makeSpyPermissionApi();
      perm.checkPermission.mockResolvedValue({ data: { allowed: true } });
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', ketoPermission: perm }),
      });
      const { sink } = makeSink();
      const service = new PermissionService(registry, sink);

      const tuple = makeTuple();
      const out = await service.forTenant('customer').check(tuple);

      expect(out).toBe(true);
      expect(perm.checkPermission).toHaveBeenCalledWith({
        namespace: tuple.namespace,
        object: tuple.object,
        relation: tuple.relation,
        subjectId: tuple.subject,
      });
    });

    it('returns false when upstream reports allowed=false', async () => {
      const perm = makeSpyPermissionApi();
      perm.checkPermission.mockResolvedValue({ data: { allowed: false } });
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', ketoPermission: perm }),
      });
      const { sink } = makeSink();
      const service = new PermissionService(registry, sink);

      const out = await service.forTenant('customer').check(makeTuple());
      expect(out).toBe(false);
    });

    it('maps upstream 5xx through ErrorMapper to ServiceUnavailableException', async () => {
      const perm = makeSpyPermissionApi();
      perm.checkPermission.mockRejectedValue(axiosErr(503));
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', ketoPermission: perm }),
      });
      const { sink } = makeSink();
      const service = new PermissionService(registry, sink);

      await expect(
        service.forTenant('customer').check(makeTuple()),
      ).rejects.toThrow(ServiceUnavailableException);
    });
  });

  describe('.grant(tuple)', () => {
    it('throws IamConfigurationError when ketoRelationship is absent', async () => {
      const registry = makeRegistry({
        customer: makeClients({
          tenant: 'customer',
          ketoPermission: makeSpyPermissionApi(),
        }),
      });
      const { sink, emitted } = makeSink();
      const service = new PermissionService(registry, sink);

      await expect(
        service.forTenant('customer').grant(makeTuple()),
      ).rejects.toThrow(IamConfigurationError);
      expect(emitted).toHaveLength(0);
    });

    it('creates the relationship and emits authz.permission.grant', async () => {
      const rel = makeSpyRelationshipApi();
      rel.createRelationship.mockResolvedValue({ data: undefined });
      const registry = makeRegistry({
        customer: makeClients({
          tenant: 'customer',
          ketoRelationship: rel,
        }),
      });
      const { sink, emitted } = makeSink();
      const service = new PermissionService(registry, sink);

      const tuple = makeTuple();
      await service.forTenant('customer').grant(tuple);

      expect(rel.createRelationship).toHaveBeenCalledTimes(1);
      const call = rel.createRelationship.mock.calls[0][0];
      expect(call.createRelationshipBody).toEqual({
        namespace: tuple.namespace,
        object: tuple.object,
        relation: tuple.relation,
        subject_id: tuple.subject,
      });

      expect(emitted).toHaveLength(1);
      const evt = emitted[0];
      expect(evt.event).toBe('authz.permission.grant');
      expect(evt.tenant).toBe('customer');
      expect(evt.result).toBe('success');
      expect(evt.attributes).toEqual({
        namespace: tuple.namespace,
        relation: tuple.relation,
        object: tuple.object,
        subject: tuple.subject,
      });
      expect(typeof evt.timestamp).toBe('string');
    });

    it('treats a 409 conflict as idempotent success (no throw, still emits audit)', async () => {
      const rel = makeSpyRelationshipApi();
      rel.createRelationship.mockRejectedValue(axiosErr(409));
      const registry = makeRegistry({
        customer: makeClients({
          tenant: 'customer',
          ketoRelationship: rel,
        }),
      });
      const { sink, emitted } = makeSink();
      const service = new PermissionService(registry, sink);

      const tuple = makeTuple();
      await expect(
        service.forTenant('customer').grant(tuple),
      ).resolves.toBeUndefined();

      expect(emitted).toHaveLength(1);
      expect(emitted[0].event).toBe('authz.permission.grant');
      expect(emitted[0].result).toBe('success');
    });

    it('maps upstream 5xx through ErrorMapper and does NOT emit on failure', async () => {
      const rel = makeSpyRelationshipApi();
      rel.createRelationship.mockRejectedValue(axiosErr(500));
      const registry = makeRegistry({
        customer: makeClients({
          tenant: 'customer',
          ketoRelationship: rel,
        }),
      });
      const { sink, emitted } = makeSink();
      const service = new PermissionService(registry, sink);

      await expect(
        service.forTenant('customer').grant(makeTuple()),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(emitted).toHaveLength(0);
    });
  });

  describe('.revoke(tuple)', () => {
    it('throws IamConfigurationError when ketoRelationship is absent', async () => {
      const registry = makeRegistry({
        customer: makeClients({
          tenant: 'customer',
          ketoPermission: makeSpyPermissionApi(),
        }),
      });
      const { sink, emitted } = makeSink();
      const service = new PermissionService(registry, sink);

      await expect(
        service.forTenant('customer').revoke(makeTuple()),
      ).rejects.toThrow(IamConfigurationError);
      expect(emitted).toHaveLength(0);
    });

    it('deletes the relationship and emits authz.permission.revoke', async () => {
      const rel = makeSpyRelationshipApi();
      rel.deleteRelationships.mockResolvedValue({ data: undefined });
      const registry = makeRegistry({
        customer: makeClients({
          tenant: 'customer',
          ketoRelationship: rel,
        }),
      });
      const { sink, emitted } = makeSink();
      const service = new PermissionService(registry, sink);

      const tuple = makeTuple();
      await service.forTenant('customer').revoke(tuple);

      expect(rel.deleteRelationships).toHaveBeenCalledTimes(1);
      const call = rel.deleteRelationships.mock.calls[0][0];
      expect(call).toEqual({
        namespace: tuple.namespace,
        object: tuple.object,
        relation: tuple.relation,
        subjectId: tuple.subject,
      });

      expect(emitted).toHaveLength(1);
      const evt = emitted[0];
      expect(evt.event).toBe('authz.permission.revoke');
      expect(evt.tenant).toBe('customer');
      expect(evt.result).toBe('success');
      expect(evt.attributes).toEqual({
        namespace: tuple.namespace,
        relation: tuple.relation,
        object: tuple.object,
        subject: tuple.subject,
      });
    });

    it('treats a 404 as idempotent success (no throw, still emits audit)', async () => {
      const rel = makeSpyRelationshipApi();
      rel.deleteRelationships.mockRejectedValue(axiosErr(404));
      const registry = makeRegistry({
        customer: makeClients({
          tenant: 'customer',
          ketoRelationship: rel,
        }),
      });
      const { sink, emitted } = makeSink();
      const service = new PermissionService(registry, sink);

      const tuple = makeTuple();
      await expect(
        service.forTenant('customer').revoke(tuple),
      ).resolves.toBeUndefined();

      expect(emitted).toHaveLength(1);
      expect(emitted[0].event).toBe('authz.permission.revoke');
      expect(emitted[0].result).toBe('success');
    });

    it('maps upstream 5xx through ErrorMapper and does NOT emit on failure', async () => {
      const rel = makeSpyRelationshipApi();
      rel.deleteRelationships.mockRejectedValue(axiosErr(500));
      const registry = makeRegistry({
        customer: makeClients({
          tenant: 'customer',
          ketoRelationship: rel,
        }),
      });
      const { sink, emitted } = makeSink();
      const service = new PermissionService(registry, sink);

      await expect(
        service.forTenant('customer').revoke(makeTuple()),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(emitted).toHaveLength(0);
    });
  });

  describe('.list(query)', () => {
    it('throws IamConfigurationError when ketoRelationship is absent', async () => {
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer' }),
      });
      const { sink } = makeSink();
      const service = new PermissionService(registry, sink);

      await expect(
        service.forTenant('customer').list({ tenant: 'customer' }),
      ).rejects.toThrow(IamConfigurationError);
    });

    it('returns mapped tuples and forwards nextPageToken', async () => {
      const rel = makeSpyRelationshipApi();
      rel.getRelationships.mockResolvedValue({
        data: {
          relation_tuples: [
            {
              namespace: 'documents',
              object: 'doc-1',
              relation: 'viewer',
              subject_id: 'user:alice',
            },
            {
              namespace: 'documents',
              object: 'doc-2',
              relation: 'editor',
              subject_id: 'user:bob',
            },
          ],
          next_page_token: 'token-xyz',
        },
      });
      const registry = makeRegistry({
        customer: makeClients({
          tenant: 'customer',
          ketoRelationship: rel,
        }),
      });
      const { sink } = makeSink();
      const service = new PermissionService(registry, sink);

      const out = await service.forTenant('customer').list({
        tenant: 'customer',
        namespace: 'documents',
        limit: 50,
        pageToken: 'cursor-0',
      });

      expect(rel.getRelationships).toHaveBeenCalledTimes(1);
      const call = rel.getRelationships.mock.calls[0][0];
      expect(call.namespace).toBe('documents');
      expect(call.pageSize).toBe(50);
      expect(call.pageToken).toBe('cursor-0');

      expect(out.items).toHaveLength(2);
      expect(out.items[0]).toEqual({
        namespace: 'documents',
        object: 'doc-1',
        relation: 'viewer',
        subject: 'user:alice',
        tenant: 'customer',
      });
      expect(out.items[1].subject).toBe('user:bob');
      expect(out.items.every((t) => t.tenant === 'customer')).toBe(true);
      expect(out.nextPageToken).toBe('token-xyz');
    });

    it('omits nextPageToken when upstream response does not include one', async () => {
      const rel = makeSpyRelationshipApi();
      rel.getRelationships.mockResolvedValue({
        data: {
          relation_tuples: [],
        },
      });
      const registry = makeRegistry({
        customer: makeClients({
          tenant: 'customer',
          ketoRelationship: rel,
        }),
      });
      const { sink } = makeSink();
      const service = new PermissionService(registry, sink);

      const out = await service.forTenant('customer').list({
        tenant: 'customer',
      });
      expect(out.items).toEqual([]);
      expect(out.nextPageToken).toBeUndefined();
    });

    it('maps upstream 5xx through ErrorMapper to ServiceUnavailableException', async () => {
      const rel = makeSpyRelationshipApi();
      rel.getRelationships.mockRejectedValue(axiosErr(500));
      const registry = makeRegistry({
        customer: makeClients({
          tenant: 'customer',
          ketoRelationship: rel,
        }),
      });
      const { sink } = makeSink();
      const service = new PermissionService(registry, sink);

      await expect(
        service.forTenant('customer').list({ tenant: 'customer' }),
      ).rejects.toThrow(ServiceUnavailableException);
    });
  });
});
