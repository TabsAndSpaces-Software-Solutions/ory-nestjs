/**
 * `CourierService` — tenant-scoped Kratos courier message read access.
 *
 * Kratos's Courier API lets admins inspect delivered / queued transactional
 * messages (verification emails, recovery codes, login magic links). This
 * service wraps it with library DTOs and **redacts message bodies by
 * default** — bodies routinely contain one-time tokens that must not land in
 * logs or dashboards without an explicit consumer opt-in.
 *
 * Zero-Ory-leakage: no `@ory/*` imports; we reach `CourierApi` structurally
 * via `TenantClients.kratosCourier`.
 */
import { Inject, Injectable } from '@nestjs/common';

import { correlationStorage } from '../clients/correlation-storage';
import { deepFreeze } from '../dto';
import type { TenantClients } from '../clients';
import type { TenantName, IamCourierMessage } from '../dto';
import { ErrorMapper, IamConfigurationError } from '../errors';
import { TENANT_REGISTRY } from '../module/registry/tokens';
import type { TenantRegistry } from '../module/registry/tenant-registry.service';

export interface IamCourierMessageList {
  items: IamCourierMessage[];
  nextPageToken?: string;
}

export interface CourierServiceFor {
  /**
   * List courier messages. By default returns metadata only (no body); pass
   * `includeBody: true` explicitly to retrieve message bodies.
   */
  list(opts?: {
    status?: 'queued' | 'sent' | 'processing' | 'abandoned';
    recipient?: string;
    pageSize?: number;
    pageToken?: string;
    includeBody?: boolean;
  }): Promise<IamCourierMessageList>;

  /** Fetch a single message by id. Body is redacted unless `includeBody`. */
  get(id: string, opts?: { includeBody?: boolean }): Promise<IamCourierMessage>;
}

interface CourierApiLike {
  listCourierMessages(req?: unknown): Promise<{ data: unknown }>;
  getCourierMessage(req: unknown): Promise<{ data: unknown }>;
}

@Injectable()
export class CourierService {
  private readonly byTenant = new Map<TenantName, CourierServiceFor>();

  constructor(
    @Inject(TENANT_REGISTRY) private readonly registry: TenantRegistry,
  ) {}

  public forTenant(name: TenantName): CourierServiceFor {
    const existing = this.byTenant.get(name);
    if (existing !== undefined) return existing;

    const wrapper: CourierServiceFor = {
      list: (opts) => listImpl(this.registry, name, opts ?? {}),
      get: (id, opts) => getImpl(this.registry, name, id, opts ?? {}),
    };
    this.byTenant.set(name, wrapper);
    return wrapper;
  }
}

async function listImpl(
  registry: TenantRegistry,
  tenant: TenantName,
  opts: {
    status?: 'queued' | 'sent' | 'processing' | 'abandoned';
    recipient?: string;
    pageSize?: number;
    pageToken?: string;
    includeBody?: boolean;
  },
): Promise<IamCourierMessageList> {
  const api = requireCourier(registry, tenant);
  const req: Record<string, unknown> = {};
  if (opts.status !== undefined) req.status = opts.status;
  if (opts.recipient !== undefined) req.recipient = opts.recipient;
  if (opts.pageSize !== undefined) req.pageSize = opts.pageSize;
  if (opts.pageToken !== undefined) req.pageToken = opts.pageToken;

  try {
    const { data } = await api.listCourierMessages(req);
    const list = Array.isArray(data) ? data : [];
    const items = list.map((m) =>
      mapMessage(m, tenant, opts.includeBody === true),
    );
    const result: IamCourierMessageList = { items };
    // Kratos returns next-page cursor as a response header, not payload —
    // consumers needing pagination should inspect the axios response in a
    // future iteration. For v1, rely on `pageSize` + `pageToken` round-trips.
    return result;
  } catch (err) {
    throw ErrorMapper.toNest(err, {
      correlationId: currentCorrelationId(),
    });
  }
}

async function getImpl(
  registry: TenantRegistry,
  tenant: TenantName,
  id: string,
  opts: { includeBody?: boolean },
): Promise<IamCourierMessage> {
  const api = requireCourier(registry, tenant);
  try {
    const { data } = await api.getCourierMessage({ id });
    return mapMessage(data, tenant, opts.includeBody === true);
  } catch (err) {
    throw ErrorMapper.toNest(err, {
      correlationId: currentCorrelationId(),
    });
  }
}

function mapMessage(
  raw: unknown,
  tenant: TenantName,
  includeBody: boolean,
): IamCourierMessage {
  const m = (raw ?? {}) as {
    id?: unknown;
    status?: unknown;
    channel?: unknown;
    recipient?: unknown;
    subject?: unknown;
    template_type?: unknown;
    created_at?: unknown;
    send_count?: unknown;
    body?: unknown;
  };
  const msg: IamCourierMessage = {
    id: typeof m.id === 'string' ? m.id : '',
    status: (typeof m.status === 'string'
      ? (m.status as IamCourierMessage['status'])
      : 'queued'),
    channel: typeof m.channel === 'string' ? m.channel : 'email',
    recipient: typeof m.recipient === 'string' ? m.recipient : '',
    subject: typeof m.subject === 'string' ? m.subject : '',
    templateType: typeof m.template_type === 'string' ? m.template_type : '',
    createdAt: typeof m.created_at === 'string' ? m.created_at : '',
    sendCount: typeof m.send_count === 'number' ? m.send_count : 0,
    ...(includeBody && typeof m.body === 'string' ? { body: m.body } : {}),
    tenant,
  };
  return deepFreeze(msg);
}

function requireCourier(
  registry: TenantRegistry,
  tenant: TenantName,
): CourierApiLike {
  const clients: TenantClients = registry.get(tenant);
  if (clients.kratosCourier === undefined) {
    throw new IamConfigurationError({
      message: `Kratos courier API not configured for tenant '${tenant}' (requires kratos.adminUrl + kratos.adminToken)`,
    });
  }
  return clients.kratosCourier as unknown as CourierApiLike;
}

function currentCorrelationId(): string | undefined {
  return correlationStorage.getStore()?.correlationId;
}
