import 'reflect-metadata';
import { ServiceUnavailableException } from '@nestjs/common';

import { CourierService } from '../../../src/services/courier.service';
import { IamConfigurationError } from '../../../src/errors';
import type { TenantClients } from '../../../src/clients';
import { makeAuditSpy, makeClients, makeRegistry, oryError } from './_helpers';

describe('CourierService', () => {
  const courierApi = {
    listCourierMessages: jest.fn(),
    getCourierMessage: jest.fn(),
  };
  const registry = makeRegistry({
    default: makeClients({
      tenant: 'default',
      kratosCourier: courierApi as unknown as TenantClients['kratosCourier'],
    }),
    empty: makeClients({ tenant: 'empty' }),
  });
  const audit = makeAuditSpy();
  const service = new CourierService(registry, audit);

  beforeEach(() => {
    courierApi.listCourierMessages.mockReset();
    courierApi.getCourierMessage.mockReset();
    audit.events.length = 0;
  });

  it('list() returns redacted messages (body stripped)', async () => {
    courierApi.listCourierMessages.mockResolvedValue({
      data: [
        {
          id: 'm1',
          status: 'sent',
          channel: 'email',
          recipient: 'a@b.c',
          subject: 'Hi',
          template_type: 'verification_valid',
          send_count: 1,
          body: 'SECRET',
        },
      ],
    });
    const { items } = await service.forTenant('default').list();
    expect(items[0].body).toBeUndefined();
    expect(items[0].recipient).toBe('a@b.c');
    expect(items[0].subject).toBe('Hi');
  });

  it('get({ includeBody: true }) returns body AND emits an access audit event', async () => {
    courierApi.getCourierMessage.mockResolvedValue({
      data: { id: 'm2', body: 'SECRET', status: 'sent', channel: 'email' },
    });
    const msg = await service
      .forTenant('default')
      .get('m2', { includeBody: true });
    expect(msg.body).toBe('SECRET');
    expect(audit.events.some((e) => e.event === 'iam.courier.message.access'))
      .toBe(true);
  });

  it('maps upstream 503 through ErrorMapper', async () => {
    courierApi.getCourierMessage.mockRejectedValue(oryError(503));
    await expect(
      service.forTenant('default').get('m3'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('throws IamConfigurationError when courier client is absent', async () => {
    await expect(service.forTenant('empty').list()).rejects.toBeInstanceOf(
      IamConfigurationError,
    );
  });
});
