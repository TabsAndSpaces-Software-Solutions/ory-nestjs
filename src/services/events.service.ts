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

import { AUDIT_SINK, type AuditSink } from '../audit';
import { correlationStorage } from '../clients/correlation-storage';
import type { TenantClients } from '../clients';
import type { TenantName } from '../dto';
import { ErrorMapper, IamConfigurationError } from '../errors';
import { TENANT_REGISTRY } from '../module/registry/tokens';
import type { TenantRegistry } from '../module/registry/tenant-registry.service';
import { emitAudit } from './audit-helpers';

export interface IamEventStream {
  readonly id: string;
  readonly type: string;
  readonly topicArn?: string;
  readonly roleArn?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  /** Fields from future Ory SDKs that aren't yet typed. */
  readonly additional: Record<string, unknown>;
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
    @Inject(AUDIT_SINK) private readonly audit: AuditSink,
  ) {}

  public forTenant(name: TenantName): EventsServiceFor {
    const existing = this.byTenant.get(name);
    if (existing !== undefined) return existing;
    const reg = this.registry;
    const audit = this.audit;
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
          const stream = toStream(data, name);
          await emitAudit(audit, 'iam.network.events.create', name, {
            targetId: `${projectId}/${stream.id}`,
            attributes: { streamType: input.type },
          });
          return stream;
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
          const stream = toStream(data, name);
          await emitAudit(audit, 'iam.network.events.set', name, {
            targetId: `${projectId}/${streamId}`,
          });
          return stream;
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
        await emitAudit(audit, 'iam.network.events.delete', name, {
          targetId: `${projectId}/${streamId}`,
        });
      },
    };
    this.byTenant.set(name, wrapper);
    return wrapper;
  }
}

const STREAM_KNOWN_FIELDS = new Set([
  'id',
  'type',
  'topic_arn',
  'role_arn',
  'created_at',
  'updated_at',
]);

function toStream(raw: unknown, tenant: TenantName): IamEventStream {
  const s = (raw ?? {}) as Record<string, unknown>;
  const additional: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    if (!STREAM_KNOWN_FIELDS.has(k)) additional[k] = v;
  }
  return {
    id: typeof s.id === 'string' ? s.id : '',
    type: typeof s.type === 'string' ? s.type : '',
    topicArn: typeof s.topic_arn === 'string' ? s.topic_arn : undefined,
    roleArn: typeof s.role_arn === 'string' ? s.role_arn : undefined,
    createdAt: typeof s.created_at === 'string' ? s.created_at : undefined,
    updatedAt: typeof s.updated_at === 'string' ? s.updated_at : undefined,
    additional,
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
