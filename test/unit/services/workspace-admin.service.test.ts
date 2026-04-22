import 'reflect-metadata';
import { ServiceUnavailableException } from '@nestjs/common';

import { WorkspaceAdminService } from '../../../src/services/workspace-admin.service';
import { IamConfigurationError } from '../../../src/errors';
import type { TenantClients } from '../../../src/clients';
import { makeAuditSpy, makeClients, makeRegistry, oryError } from './_helpers';

describe('WorkspaceAdminService', () => {
  const api = {
    createWorkspace: jest.fn(),
    listWorkspaces: jest.fn(),
    getWorkspace: jest.fn(),
    updateWorkspace: jest.fn(),
    listWorkspaceProjects: jest.fn(),
    createWorkspaceApiKey: jest.fn(),
    listWorkspaceApiKeys: jest.fn(),
    deleteWorkspaceApiKey: jest.fn(),
  };
  const registry = makeRegistry({
    default: makeClients({
      tenant: 'default',
      networkWorkspace: api as unknown as TenantClients['networkWorkspace'],
    }),
    empty: makeClients({ tenant: 'empty' }),
  });
  const audit = makeAuditSpy();
  const svc = new WorkspaceAdminService(registry, audit);

  beforeEach(() => {
    Object.values(api).forEach((m) => m.mockReset());
    audit.events.length = 0;
  });

  it('create() maps known fields + emits audit', async () => {
    api.createWorkspace.mockResolvedValue({
      data: {
        id: 'w1',
        name: 'prod-eu',
        subscription_plan: 'scale',
        future_field: 42,
      },
    });
    const w = await svc.forTenant('default').create({ name: 'prod-eu' });
    expect(w.subscriptionPlan).toBe('scale');
    expect(w.additional).toEqual({ future_field: 42 });
    expect(audit.events.map((e) => e.event)).toContain(
      'iam.network.workspace.create',
    );
  });

  it('listProjects maps to IamWorkspaceProject', async () => {
    api.listWorkspaceProjects.mockResolvedValue({
      data: [{ id: 'p1', name: 'a' }],
    });
    const projects = await svc.forTenant('default').listProjects('w1');
    expect(projects[0].name).toBe('a');
  });

  it('deleteApiKey emits audit', async () => {
    api.deleteWorkspaceApiKey.mockResolvedValue({ data: null });
    await svc.forTenant('default').deleteApiKey('w1', 't1');
    expect(audit.events.map((e) => e.event)).toContain(
      'iam.network.workspace.apiKey.delete',
    );
  });

  it('propagates upstream 503', async () => {
    api.getWorkspace.mockRejectedValue(oryError(503));
    await expect(svc.forTenant('default').get('w1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('throws IamConfigurationError when absent', async () => {
    await expect(svc.forTenant('empty').list()).rejects.toBeInstanceOf(
      IamConfigurationError,
    );
  });

  it('list / get / update + api-key lifecycle', async () => {
    const stub = { id: 'w1', name: 'ws' };
    api.listWorkspaces.mockResolvedValue({ data: [stub] });
    api.getWorkspace.mockResolvedValue({ data: stub });
    api.updateWorkspace.mockResolvedValue({
      data: { ...stub, name: 'renamed' },
    });
    api.createWorkspaceApiKey.mockResolvedValue({
      data: { id: 'k1', name: 'ci', value: 's' },
    });
    api.listWorkspaceApiKeys.mockResolvedValue({
      data: [{ id: 'k1', name: 'ci' }],
    });

    const list = await svc.forTenant('default').list();
    expect(list).toHaveLength(1);
    const got = await svc.forTenant('default').get('w1');
    expect(got.id).toBe('w1');
    const updated = await svc.forTenant('default').update('w1', {});
    expect(updated.name).toBe('renamed');
    const key = await svc.forTenant('default').createApiKey('w1', {
      name: 'ci',
    });
    expect(key.id).toBe('k1');
    const keys = await svc.forTenant('default').listApiKeys('w1');
    expect(keys).toHaveLength(1);
  });
});
