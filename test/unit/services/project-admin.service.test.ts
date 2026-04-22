import 'reflect-metadata';
import { ServiceUnavailableException } from '@nestjs/common';

import { ProjectAdminService } from '../../../src/services/project-admin.service';
import { IamConfigurationError } from '../../../src/errors';
import type { TenantClients } from '../../../src/clients';
import { makeAuditSpy, makeClients, makeRegistry, oryError } from './_helpers';

describe('ProjectAdminService', () => {
  const api = {
    createProject: jest.fn(),
    listProjects: jest.fn(),
    getProject: jest.fn(),
    setProject: jest.fn(),
    purgeProject: jest.fn(),
    getProjectMembers: jest.fn(),
    createProjectApiKey: jest.fn(),
    listProjectApiKeys: jest.fn(),
    deleteProjectApiKey: jest.fn(),
  };
  const registry = makeRegistry({
    default: makeClients({
      tenant: 'default',
      networkProject: api as unknown as TenantClients['networkProject'],
    }),
    empty: makeClients({ tenant: 'empty' }),
  });
  const audit = makeAuditSpy();
  const svc = new ProjectAdminService(registry, audit);

  beforeEach(() => {
    Object.values(api).forEach((m) => m.mockReset());
    audit.events.length = 0;
  });

  it('create() maps known fields + stashes unknowns in `additional`', async () => {
    api.createProject.mockResolvedValue({
      data: {
        id: 'p1',
        name: 'acme',
        slug: 'acme',
        workspace_id: 'w1',
        environment: 'prod',
        future_field: 'hello',
      },
    });
    const p = await svc.forTenant('default').create({ name: 'acme' });
    expect(p.id).toBe('p1');
    expect(p.environment).toBe('prod');
    expect(p.additional).toEqual({ future_field: 'hello' });
    expect(audit.events.map((e) => e.event)).toContain(
      'iam.network.project.create',
    );
  });

  it('listMembers maps to IamProjectMember', async () => {
    api.getProjectMembers.mockResolvedValue({
      data: [{ id: 'm1', email: 'x@y.z', role: 'owner' }],
    });
    const members = await svc.forTenant('default').listMembers('p1');
    expect(members[0].email).toBe('x@y.z');
    expect(members[0].role).toBe('owner');
  });

  it('purge() emits irreversible-flagged audit event', async () => {
    api.purgeProject.mockResolvedValue({ data: null });
    await svc.forTenant('default').purge('p1');
    const ev = audit.events.find((e) => e.event === 'iam.network.project.purge');
    expect(ev?.attributes).toEqual({ irreversible: true });
  });

  it('propagates upstream 503', async () => {
    api.getProject.mockRejectedValue(oryError(503));
    await expect(svc.forTenant('default').get('p1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('throws IamConfigurationError when network API is absent', async () => {
    await expect(svc.forTenant('empty').list()).rejects.toBeInstanceOf(
      IamConfigurationError,
    );
  });

  it('list(), get(), set() and api-key lifecycle work', async () => {
    const stub = { id: 'p1', name: 'acme' };
    api.listProjects.mockResolvedValue({ data: [stub] });
    api.getProject.mockResolvedValue({ data: stub });
    api.setProject.mockResolvedValue({ data: { ...stub, name: 'renamed' } });
    api.createProjectApiKey.mockResolvedValue({
      data: { id: 'k1', name: 'ci', value: 'secret' },
    });
    api.listProjectApiKeys.mockResolvedValue({
      data: [{ id: 'k1', name: 'ci' }],
    });
    api.deleteProjectApiKey.mockResolvedValue({ data: null });

    const list = await svc.forTenant('default').list();
    expect(list).toHaveLength(1);
    const got = await svc.forTenant('default').get('p1');
    expect(got.id).toBe('p1');
    const updated = await svc.forTenant('default').set('p1', {});
    expect(updated.name).toBe('renamed');
    const key = await svc.forTenant('default').createApiKey('p1', {
      name: 'ci',
    });
    expect(key.id).toBe('k1');
    const keys = await svc.forTenant('default').listApiKeys('p1');
    expect(keys).toHaveLength(1);
    await svc.forTenant('default').deleteApiKey('p1', 'k1');
    expect(audit.events.map((e) => e.event)).toContain(
      'iam.network.project.apiKey.delete',
    );
  });
});
