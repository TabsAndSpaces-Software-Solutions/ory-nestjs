/**
 * `EventsService` — Ory Network event-stream CRUD.
 *
 * Ory Network can forward audit + telemetry events to a consumer-owned
 * stream (SNS, Kafka, etc). This service wraps `EventsApi`:
 *   - createEventStream
 *   - listEventStreams
 *   - setEventStream
 *   - deleteEventStream
 *
 * Requires cloud mode + workspace API key (same as Project/Workspace admin).
 *
 * Zero `@ory/*` imports.
 */
import { Inject, Injectable } from '@nestjs/common';

import { correlationStorage } from '../clients/correlation-storage';
import type { TenantClients } from '../clients';
import type { TenantName } from '../dto';
import { ErrorMapper, IamConfigurationError } from '../errors';
import { TENANT_REGISTRY } from '../module/registry/tokens';
import type { TenantRegistry } from '../module/registry/tenant-registry.service';

export interface IamEventStream {
  readonly id: string;
  readonly type: string;
  readonly topicArn?: string;
  readonly roleArn?: string;
  readonly raw: Record<string, unknown>;
  readonly tenant: TenantName;
}

export interface EventsServiceFor {
  create(
    projectId: string,
    input: { type: string; topicArn?: string; roleArn?: string },
  ): Promise<IamEventStream>;
  list(projectId: string): Promise<IamEventStream[]>;
  set(
    projectId: string,
    streamId: string,
    patch: Record<string, unknown>,
  ): Promise<IamEventStream>;
  delete(projectId: string, streamId: string): Promise<void>;
}

interface EventsApiLike {
  createEventStream(req: unknown): Promise<{ data: unknown }>;
  listEventStreams(req: unknown): Promise<{ data: unknown }>;
  setEventStream(req: unknown): Promise<{ data: unknown }>;
  deleteEventStream(req: unknown): Promise<{ data: unknown }>;
}

@Injectable()
export class EventsService {
  private readonly byTenant = new Map<TenantName, EventsServiceFor>();

  constructor(
    @Inject(TENANT_REGISTRY) private readonly registry: TenantRegistry,
  ) {}

  public forTenant(name: TenantName): EventsServiceFor {
    const existing = this.byTenant.get(name);
    if (existing !== undefined) return existing;
    const reg = this.registry;
    const wrapper: EventsServiceFor = {
      create: async (projectId, input) => {
        const api = events(reg, name);
        try {
          const body: Record<string, unknown> = { type: input.type };
          if (input.topicArn !== undefined) body.topic_arn = input.topicArn;
          if (input.roleArn !== undefined) body.role_arn = input.roleArn;
          const { data } = await api.createEventStream({
            project: projectId,
            createEventStreamBody: body,
          });
          return toStream(data, name);
        } catch (err) {
          throw ErrorMapper.toNest(err, { correlationId: corrId() });
        }
      },
      list: async (projectId) => {
        const api = events(reg, name);
        try {
          const { data } = await api.listEventStreams({ project: projectId });
          const list = Array.isArray(data) ? data : [];
          return list.map((s) => toStream(s, name));
        } catch (err) {
          throw ErrorMapper.toNest(err, { correlationId: corrId() });
        }
      },
      set: async (projectId, streamId, patch) => {
        const api = events(reg, name);
        try {
          const { data } = await api.setEventStream({
            project: projectId,
            eventStreamId: streamId,
            setEventStreamBody: patch,
          });
          return toStream(data, name);
        } catch (err) {
          throw ErrorMapper.toNest(err, { correlationId: corrId() });
        }
      },
      delete: async (projectId, streamId) => {
        const api = events(reg, name);
        try {
          await api.deleteEventStream({
            project: projectId,
            eventStreamId: streamId,
          });
        } catch (err) {
          throw ErrorMapper.toNest(err, { correlationId: corrId() });
        }
      },
    };
    this.byTenant.set(name, wrapper);
    return wrapper;
  }
}

function toStream(raw: unknown, tenant: TenantName): IamEventStream {
  const s = (raw ?? {}) as Record<string, unknown>;
  return {
    id: typeof s.id === 'string' ? s.id : '',
    type: typeof s.type === 'string' ? s.type : '',
    topicArn: typeof s.topic_arn === 'string' ? s.topic_arn : undefined,
    roleArn: typeof s.role_arn === 'string' ? s.role_arn : undefined,
    raw: s,
    tenant,
  };
}

function events(registry: TenantRegistry, tenant: TenantName): EventsApiLike {
  const clients: TenantClients = registry.get(tenant);
  if (!clients.networkEvents) {
    throw new IamConfigurationError({
      message: `Ory Network events API not configured for tenant '${tenant}' (requires mode: 'cloud' + cloud.workspaceApiKey)`,
    });
  }
  return clients.networkEvents as unknown as EventsApiLike;
}

function corrId(): string | undefined {
  return correlationStorage.getStore()?.correlationId;
}
