import 'reflect-metadata';
import { ServiceUnavailableException } from '@nestjs/common';

import { OAuth2ClientService } from '../../../src/services/oauth2-client.service';
import { IamConfigurationError } from '../../../src/errors';
import type { TenantClients } from '../../../src/clients';
import { makeAuditSpy, makeClients, makeRegistry, oryError } from './_helpers';

describe('OAuth2ClientService', () => {
  const admin = {
    createOAuth2Client: jest.fn(),
    getOAuth2Client: jest.fn(),
    listOAuth2Clients: jest.fn(),
    setOAuth2Client: jest.fn(),
    patchOAuth2Client: jest.fn(),
    deleteOAuth2Client: jest.fn(),
  };
  const registry = makeRegistry({
    default: makeClients({
      tenant: 'default',
      hydraOauth2: admin as unknown as TenantClients['hydraOauth2'],
    }),
    empty: makeClients({ tenant: 'empty' }),
  });
  const audit = makeAuditSpy();
  const svc = new OAuth2ClientService(registry, audit);

  beforeEach(() => {
    Object.values(admin).forEach((m) => m.mockReset());
    audit.events.length = 0;
  });

  it('create() maps the response and emits iam.oauth2.client.create', async () => {
    admin.createOAuth2Client.mockResolvedValue({
      data: {
        client_id: 'c1',
        client_name: 'acme',
        grant_types: ['client_credentials'],
        response_types: [],
        redirect_uris: [],
        scope: 'read:things',
        token_endpoint_auth_method: 'client_secret_basic',
        client_secret: 's3cret',
        audience: [],
      },
    });
    const out = await svc.forTenant('default').create({ clientName: 'acme' });
    expect(out.clientId).toBe('c1');
    expect(out.clientSecret).toBe('s3cret');
    expect(audit.events.map((e) => e.event)).toContain(
      'oauth2.client.create',
    );
  });

  it('delete() emits oauth2.client.delete', async () => {
    admin.deleteOAuth2Client.mockResolvedValue({ data: null });
    await svc.forTenant('default').delete('c1');
    expect(audit.events.map((e) => e.event)).toContain(
      'oauth2.client.delete',
    );
  });

  it('patch() forwards JSON-Patch ops', async () => {
    admin.patchOAuth2Client.mockResolvedValue({
      data: {
        client_id: 'c1',
        client_name: 'renamed',
        grant_types: [],
        response_types: [],
        redirect_uris: [],
        scope: '',
        token_endpoint_auth_method: 'client_secret_basic',
        audience: [],
      },
    });
    const out = await svc
      .forTenant('default')
      .patch('c1', [{ op: 'replace', path: '/client_name', value: 'renamed' }]);
    expect(out.clientName).toBe('renamed');
    expect(admin.patchOAuth2Client).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c1' }),
    );
  });

  it('maps upstream 500 → ServiceUnavailableException', async () => {
    admin.getOAuth2Client.mockRejectedValue(oryError(500));
    await expect(svc.forTenant('default').get('c1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('throws IamConfigurationError when Hydra admin client is absent', async () => {
    await expect(
      svc.forTenant('empty').create({ clientName: 'x' }),
    ).rejects.toBeInstanceOf(IamConfigurationError);
  });

  it('get() + list() + set() all map responses', async () => {
    const stub = {
      client_id: 'c1',
      client_name: 'acme',
      grant_types: [],
      response_types: [],
      redirect_uris: [],
      scope: '',
      token_endpoint_auth_method: 'none',
      audience: [],
    };
    admin.getOAuth2Client.mockResolvedValue({ data: stub });
    admin.listOAuth2Clients.mockResolvedValue({ data: [stub] });
    admin.setOAuth2Client.mockResolvedValue({ data: stub });
    const got = await svc.forTenant('default').get('c1');
    expect(got.clientId).toBe('c1');
    const { items } = await svc.forTenant('default').list();
    expect(items).toHaveLength(1);
    const set = await svc.forTenant('default').set('c1', { clientName: 'n' });
    expect(set.clientId).toBe('c1');
  });
});
