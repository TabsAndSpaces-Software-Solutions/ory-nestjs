import 'reflect-metadata';
import { ServiceUnavailableException } from '@nestjs/common';

import { JwkService } from '../../../src/services/jwk.service';
import { IamConfigurationError } from '../../../src/errors';
import type { TenantClients } from '../../../src/clients';
import { makeAuditSpy, makeClients, makeRegistry, oryError } from './_helpers';

describe('JwkService', () => {
  const api = {
    createJsonWebKeySet: jest.fn(),
    getJsonWebKeySet: jest.fn(),
    setJsonWebKeySet: jest.fn(),
    deleteJsonWebKeySet: jest.fn(),
    getJsonWebKey: jest.fn(),
    setJsonWebKey: jest.fn(),
    deleteJsonWebKey: jest.fn(),
  };
  const registry = makeRegistry({
    default: makeClients({
      tenant: 'default',
      hydraJwk: api as unknown as TenantClients['hydraJwk'],
    }),
    empty: makeClients({ tenant: 'empty' }),
  });
  const audit = makeAuditSpy();
  const svc = new JwkService(registry, audit);

  beforeEach(() => {
    Object.values(api).forEach((m) => m.mockReset());
    audit.events.length = 0;
  });

  it('createSet maps response + emits iam.jwk.createSet', async () => {
    api.createJsonWebKeySet.mockResolvedValue({
      data: { keys: [{ kid: 'k1', kty: 'RSA', alg: 'RS256', use: 'sig' }] },
    });
    const set = await svc.forTenant('default').createSet('my-set', {
      alg: 'RS256',
      use: 'sig',
    });
    expect(set.keys).toHaveLength(1);
    expect(set.keys[0].kid).toBe('k1');
    expect(audit.events.map((e) => e.event)).toContain('iam.jwk.createSet');
  });

  it('deleteSet emits iam.jwk.deleteSet', async () => {
    api.deleteJsonWebKeySet.mockResolvedValue({ data: null });
    await svc.forTenant('default').deleteSet('my-set');
    expect(audit.events.map((e) => e.event)).toContain('iam.jwk.deleteSet');
  });

  it('updateKey maps single-key response + emits audit', async () => {
    api.setJsonWebKey.mockResolvedValue({
      data: { kid: 'k1', kty: 'RSA' },
    });
    await svc
      .forTenant('default')
      .updateKey('my-set', 'k1', { kid: 'k1', kty: 'RSA' });
    expect(audit.events.map((e) => e.event)).toContain('iam.jwk.updateKey');
  });

  it('propagates upstream 503', async () => {
    api.getJsonWebKeySet.mockRejectedValue(oryError(503));
    await expect(
      svc.forTenant('default').getSet('my-set'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('throws IamConfigurationError when jwk API is absent', async () => {
    await expect(
      svc.forTenant('empty').createSet('my-set', { alg: 'RS256', use: 'sig' }),
    ).rejects.toBeInstanceOf(IamConfigurationError);
  });

  it('updateSet / getKey / deleteKey cover remaining paths', async () => {
    api.setJsonWebKeySet.mockResolvedValue({
      data: { keys: [{ kid: 'k1', kty: 'RSA' }] },
    });
    api.getJsonWebKey.mockResolvedValue({
      data: { keys: [{ kid: 'k1', kty: 'RSA' }] },
    });
    api.deleteJsonWebKey.mockResolvedValue({ data: null });
    api.getJsonWebKeySet.mockResolvedValue({ data: { keys: [] } });

    const updated = await svc
      .forTenant('default')
      .updateSet('s', [{ kid: 'k1', kty: 'RSA' }]);
    expect(updated.keys).toHaveLength(1);
    expect(audit.events.map((e) => e.event)).toContain('iam.jwk.updateSet');

    const key = await svc.forTenant('default').getKey('s', 'k1');
    expect(key.kid).toBe('k1');

    await svc.forTenant('default').deleteKey('s', 'k1');
    expect(audit.events.map((e) => e.event)).toContain('iam.jwk.deleteKey');

    const set = await svc.forTenant('default').getSet('s');
    expect(set.keys).toEqual([]);
  });
});
