import 'reflect-metadata';
import { ServiceUnavailableException } from '@nestjs/common';

import { MetadataService } from '../../../src/services/metadata.service';
import { IamConfigurationError } from '../../../src/errors';
import type { TenantClients } from '../../../src/clients';
import { makeClients, makeRegistry, oryError } from './_helpers';

describe('MetadataService', () => {
  const metadataApi = { getVersion: jest.fn() };
  const wellknownApi = { discoverJsonWebKeys: jest.fn() };

  const registry = makeRegistry({
    default: makeClients({
      tenant: 'default',
      hydraMetadata: metadataApi as unknown as TenantClients['hydraMetadata'],
      hydraWellknown: wellknownApi as unknown as TenantClients['hydraWellknown'],
    }),
    empty: makeClients({ tenant: 'empty' }),
  });
  const svc = new MetadataService(registry);

  beforeEach(() => {
    metadataApi.getVersion.mockReset();
    wellknownApi.discoverJsonWebKeys.mockReset();
  });

  it('version() returns the version string', async () => {
    metadataApi.getVersion.mockResolvedValue({ data: { version: 'v26.2.0' } });
    const out = await svc.forTenant('default').version();
    expect(out).toEqual({ version: 'v26.2.0' });
  });

  it('discoverJwks() maps keys', async () => {
    wellknownApi.discoverJsonWebKeys.mockResolvedValue({
      data: { keys: [{ kid: 'k1', kty: 'RSA', use: 'sig' }] },
    });
    const set = await svc.forTenant('default').discoverJwks();
    expect(set.keys).toHaveLength(1);
  });

  it('propagates upstream 503', async () => {
    metadataApi.getVersion.mockRejectedValue(oryError(503));
    await expect(svc.forTenant('default').version()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('throws IamConfigurationError when absent', async () => {
    await expect(svc.forTenant('empty').version()).rejects.toBeInstanceOf(
      IamConfigurationError,
    );
  });
});
