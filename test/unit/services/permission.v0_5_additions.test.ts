/**
 * Coverage for v0.5.0 PermissionService additions: expand() + checkBatch().
 */
import 'reflect-metadata';
import { ServiceUnavailableException } from '@nestjs/common';

import { PermissionService } from '../../../src/services/permission.service';
import type { TenantClients } from '../../../src/clients';
import { makeAuditSpy, makeClients, makeRegistry, oryError } from './_helpers';

describe('PermissionService v0.5.0 additions', () => {
  const ketoRead = {
    checkPermission: jest.fn(),
    expandPermissions: jest.fn(),
  };
  const ketoWrite = {
    createRelationship: jest.fn(),
    deleteRelationships: jest.fn(),
    getRelationships: jest.fn(),
  };
  const registry = makeRegistry({
    default: makeClients({
      tenant: 'default',
      ketoPermission: ketoRead as unknown as TenantClients['ketoPermission'],
      ketoRelationship: ketoWrite as unknown as TenantClients['ketoRelationship'],
    }),
  });
  const audit = makeAuditSpy();
  const svc = new PermissionService(registry, audit);

  beforeEach(() => {
    ketoRead.checkPermission.mockReset();
    ketoRead.expandPermissions.mockReset();
    audit.events.length = 0;
  });

  it('expand() maps leaf tree node', async () => {
    ketoRead.expandPermissions.mockResolvedValue({
      data: {
        type: 'union',
        children: [
          {
            type: 'leaf',
            tuple: {
              namespace: 'listings',
              object: 'listings:1',
              relation: 'view',
              subject_id: 'user:alice',
            },
          },
        ],
      },
    });
    const tree = await svc.forTenant('default').expand({
      namespace: 'listings',
      object: 'listings:1',
      relation: 'view',
    });
    expect(tree.root.type).toBe('union');
    expect(tree.root.children?.[0].type).toBe('leaf');
  });

  it('checkBatch() returns per-tuple results', async () => {
    ketoRead.checkPermission
      .mockResolvedValueOnce({ data: { allowed: true } })
      .mockResolvedValueOnce({ data: { allowed: false } });
    const out = await svc.forTenant('default').checkBatch([
      { namespace: 'l', object: 'l:1', relation: 'r', subject: 'u:a', tenant: 'default' },
      { namespace: 'l', object: 'l:2', relation: 'r', subject: 'u:a', tenant: 'default' },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].allowed).toBe(true);
    expect(out[1].allowed).toBe(false);
  });

  it('checkBatch() surfaces per-tuple error without aborting batch', async () => {
    ketoRead.checkPermission
      .mockResolvedValueOnce({ data: { allowed: true } })
      .mockRejectedValueOnce(oryError(503));
    const out = await svc.forTenant('default').checkBatch([
      { namespace: 'l', object: 'l:1', relation: 'r', subject: 'u:a', tenant: 'default' },
      { namespace: 'l', object: 'l:2', relation: 'r', subject: 'u:a', tenant: 'default' },
    ]);
    expect(out[0].allowed).toBe(true);
    expect(out[1].allowed).toBe(false);
    expect(out[1].error).toBeDefined();
  });

  it('expand() propagates 503 as ServiceUnavailableException', async () => {
    ketoRead.expandPermissions.mockRejectedValue(oryError(503));
    await expect(
      svc.forTenant('default').expand({
        namespace: 'x',
        object: 'x:1',
        relation: 'r',
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
