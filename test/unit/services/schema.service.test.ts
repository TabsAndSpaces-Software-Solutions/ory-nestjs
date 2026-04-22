import 'reflect-metadata';
import { ServiceUnavailableException } from '@nestjs/common';

import { SchemaService } from '../../../src/services/schema.service';
import { IamConfigurationError } from '../../../src/errors';
import type { TenantClients } from '../../../src/clients';
import { makeClients, makeRegistry, oryError } from './_helpers';

describe('SchemaService', () => {
  const schemaApi = {
    listIdentitySchemas: jest.fn(),
    getIdentitySchema: jest.fn(),
  };

  const registry = makeRegistry({
    default: makeClients({
      tenant: 'default',
      kratosIdentity: schemaApi as unknown as TenantClients['kratosIdentity'],
    }),
    empty: makeClients({ tenant: 'empty' }),
  });
  const service = new SchemaService(registry);

  beforeEach(() => {
    schemaApi.listIdentitySchemas.mockReset();
    schemaApi.getIdentitySchema.mockReset();
  });

  it('list() maps Ory schema envelopes to library DTOs', async () => {
    schemaApi.listIdentitySchemas.mockResolvedValue({
      data: [{ id: 'default', schema: { type: 'object' } }],
    });
    const out = await service.forTenant('default').list();
    expect(out).toEqual([
      { id: 'default', schema: { type: 'object' }, tenant: 'default' },
    ]);
  });

  it('get() maps a single schema', async () => {
    schemaApi.getIdentitySchema.mockResolvedValue({ data: { type: 'object' } });
    const out = await service.forTenant('default').get('default');
    expect(out.id).toBe('default');
    expect(out.schema).toEqual({ type: 'object' });
    expect(out.tenant).toBe('default');
  });

  it('throws IamConfigurationError when admin API is absent', async () => {
    await expect(service.forTenant('empty').list()).rejects.toBeInstanceOf(
      IamConfigurationError,
    );
  });

  it('maps upstream 5xx through ErrorMapper → ServiceUnavailableException', async () => {
    schemaApi.getIdentitySchema.mockRejectedValue(oryError(503));
    await expect(service.forTenant('default').get('x')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('.forTenant returns a memoized wrapper', () => {
    const a = service.forTenant('default');
    const b = service.forTenant('default');
    expect(a).toBe(b);
  });
});
