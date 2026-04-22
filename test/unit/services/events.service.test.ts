import 'reflect-metadata';
import { ServiceUnavailableException } from '@nestjs/common';

import { EventsService } from '../../../src/services/events.service';
import { IamConfigurationError } from '../../../src/errors';
import type { TenantClients } from '../../../src/clients';
import { makeAuditSpy, makeClients, makeRegistry, oryError } from './_helpers';

describe('EventsService', () => {
  const api = {
    createEventStream: jest.fn(),
    listEventStreams: jest.fn(),
    setEventStream: jest.fn(),
    deleteEventStream: jest.fn(),
  };
  const registry = makeRegistry({
    default: makeClients({
      tenant: 'default',
      networkEvents: api as unknown as TenantClients['networkEvents'],
    }),
    empty: makeClients({ tenant: 'empty' }),
  });
  const audit = makeAuditSpy();
  const svc = new EventsService(registry, audit);

  beforeEach(() => {
    Object.values(api).forEach((m) => m.mockReset());
    audit.events.length = 0;
  });

  it('create() maps + emits audit', async () => {
    api.createEventStream.mockResolvedValue({
      data: {
        id: 's1',
        type: 'sns',
        topic_arn: 'arn:…',
        role_arn: 'arn:iam:…',
      },
    });
    const s = await svc
      .forTenant('default')
      .create('p1', { type: 'sns', topicArn: 'arn:…', roleArn: 'arn:iam:…' });
    expect(s.type).toBe('sns');
    expect(audit.events.map((e) => e.event)).toContain(
      'iam.network.events.create',
    );
  });

  it('delete() emits audit', async () => {
    api.deleteEventStream.mockResolvedValue({ data: null });
    await svc.forTenant('default').delete('p1', 's1');
    expect(audit.events.map((e) => e.event)).toContain(
      'iam.network.events.delete',
    );
  });

  it('propagates upstream 503', async () => {
    api.listEventStreams.mockRejectedValue(oryError(503));
    await expect(svc.forTenant('default').list('p1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('throws IamConfigurationError when absent', async () => {
    await expect(svc.forTenant('empty').list('p1')).rejects.toBeInstanceOf(
      IamConfigurationError,
    );
  });

  it('set() maps response + emits audit', async () => {
    api.setEventStream.mockResolvedValue({
      data: { id: 's1', type: 'sns' },
    });
    await svc.forTenant('default').set('p1', 's1', { topic_arn: 'arn:…' });
    expect(audit.events.map((e) => e.event)).toContain(
      'iam.network.events.set',
    );
  });

  it('list() maps streams', async () => {
    api.listEventStreams.mockResolvedValue({
      data: [{ id: 's1', type: 'sns' }],
    });
    const out = await svc.forTenant('default').list('p1');
    expect(out[0].id).toBe('s1');
  });
});
