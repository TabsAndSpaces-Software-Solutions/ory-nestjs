/**
 * `OAuth2ClientService` — tenant-scoped Hydra OAuth2 client CRUD.
 *
 * Wraps Hydra's admin `OAuth2Api` client-management endpoints:
 *   - createOAuth2Client
 *   - getOAuth2Client
 *   - listOAuth2Clients
 *   - setOAuth2Client    (full replace)
 *   - patchOAuth2Client  (RFC 6902 JSON-Patch)
 *   - deleteOAuth2Client
 *
 * Design:
 *   - Every method reaches Hydra via the admin-bound `hydraOauth2` client.
 *     Tenants without Hydra admin config throw `IamConfigurationError`.
 *   - Library input/output is the camelCase `IamOAuth2Client` /
 *     `IamOAuth2ClientInput`. The snake_case shape Hydra expects is built
 *     inline in the adapter.
 *   - Zero `@ory/*` imports here; the mapper is the single source of type
 *     truth for the payload shape.
 */
import { Inject, Injectable } from '@nestjs/common';

import { AUDIT_SINK, type AuditSink } from '../audit';
import { correlationStorage } from '../clients/correlation-storage';
import type { TenantClients } from '../clients';
import type {
  TenantName,
  IamOAuth2Client,
  IamOAuth2ClientInput,
} from '../dto';
import { tokenMapper } from '../dto/mappers';
import { ErrorMapper, IamConfigurationError } from '../errors';
import { TENANT_REGISTRY } from '../module/registry/tokens';
import type { TenantRegistry } from '../module/registry/tenant-registry.service';
import type { IamJsonPatchOp } from './identity.service';

export interface IamOAuth2ClientList {
  items: IamOAuth2Client[];
  nextPageToken?: string;
}

export interface OAuth2ClientServiceFor {
  create(input: IamOAuth2ClientInput): Promise<IamOAuth2Client>;
  get(clientId: string): Promise<IamOAuth2Client>;
  list(opts?: {
    pageSize?: number;
    pageToken?: string;
    clientName?: string;
    owner?: string;
  }): Promise<IamOAuth2ClientList>;
  set(clientId: string, input: IamOAuth2ClientInput): Promise<IamOAuth2Client>;
  patch(
    clientId: string,
    ops: ReadonlyArray<IamJsonPatchOp>,
  ): Promise<IamOAuth2Client>;
  delete(clientId: string): Promise<void>;
}

interface OAuth2AdminLike {
  createOAuth2Client(req: unknown): Promise<{ data: unknown }>;
  getOAuth2Client(req: unknown): Promise<{ data: unknown }>;
  listOAuth2Clients(req?: unknown): Promise<{ data: unknown }>;
  setOAuth2Client(req: unknown): Promise<{ data: unknown }>;
  patchOAuth2Client(req: unknown): Promise<{ data: unknown }>;
  deleteOAuth2Client(req: unknown): Promise<{ data: unknown }>;
}

@Injectable()
export class OAuth2ClientService {
  private readonly byTenant = new Map<TenantName, OAuth2ClientServiceFor>();

  constructor(
    @Inject(TENANT_REGISTRY) private readonly registry: TenantRegistry,
    @Inject(AUDIT_SINK) private readonly audit: AuditSink,
  ) {}

  public forTenant(name: TenantName): OAuth2ClientServiceFor {
    const existing = this.byTenant.get(name);
    if (existing !== undefined) return existing;

    const registry = this.registry;
    const audit = this.audit;
    const wrapper: OAuth2ClientServiceFor = {
      create: (input) => createImpl(registry, audit, name, input),
      get: (id) => getImpl(registry, name, id),
      list: (opts) => listImpl(registry, name, opts ?? {}),
      set: (id, input) => setImpl(registry, name, id, input),
      patch: (id, ops) => patchImpl(registry, name, id, ops),
      delete: (id) => deleteImpl(registry, audit, name, id),
    };
    this.byTenant.set(name, wrapper);
    return wrapper;
  }
}

function toHydraClientBody(
  input: IamOAuth2ClientInput,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.clientName !== undefined) body.client_name = input.clientName;
  if (input.grantTypes !== undefined) body.grant_types = [...input.grantTypes];
  if (input.responseTypes !== undefined)
    body.response_types = [...input.responseTypes];
  if (input.redirectUris !== undefined)
    body.redirect_uris = [...input.redirectUris];
  if (input.scope !== undefined) body.scope = input.scope;
  if (input.audience !== undefined) body.audience = [...input.audience];
  if (input.tokenEndpointAuthMethod !== undefined)
    body.token_endpoint_auth_method = input.tokenEndpointAuthMethod;
  if (input.clientSecret !== undefined) body.client_secret = input.clientSecret;
  if (input.contacts !== undefined) body.contacts = [...input.contacts];
  if (input.clientUri !== undefined) body.client_uri = input.clientUri;
  if (input.policyUri !== undefined) body.policy_uri = input.policyUri;
  if (input.tosUri !== undefined) body.tos_uri = input.tosUri;
  if (input.logoUri !== undefined) body.logo_uri = input.logoUri;
  if (input.metadata !== undefined) body.metadata = input.metadata;
  return body;
}

async function createImpl(
  registry: TenantRegistry,
  audit: AuditSink,
  tenant: TenantName,
  input: IamOAuth2ClientInput,
): Promise<IamOAuth2Client> {
  const api = requireAdmin(registry, tenant);
  try {
    const { data } = await api.createOAuth2Client({
      oAuth2Client: toHydraClientBody(input),
    });
    const client = tokenMapper.clientFromOry(
      data as Parameters<typeof tokenMapper.clientFromOry>[0],
      tenant,
    );
    await audit.emit({
      timestamp: new Date().toISOString(),
      event: 'oauth2.client.create',
      tenant,
      targetId: client.clientId,
      result: 'success',
      attributes: { clientName: client.clientName },
      correlationId: currentCorrelationId(),
    });
    return client;
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
): Promise<IamOAuth2Client> {
  const api = requireAdmin(registry, tenant);
  try {
    const { data } = await api.getOAuth2Client({ id });
    return tokenMapper.clientFromOry(
      data as Parameters<typeof tokenMapper.clientFromOry>[0],
      tenant,
    );
  } catch (err) {
    throw ErrorMapper.toNest(err, {
      correlationId: currentCorrelationId(),
    });
  }
}

async function listImpl(
  registry: TenantRegistry,
  tenant: TenantName,
  opts: {
    pageSize?: number;
    pageToken?: string;
    clientName?: string;
    owner?: string;
  },
): Promise<IamOAuth2ClientList> {
  const api = requireAdmin(registry, tenant);
  const req: Record<string, unknown> = {};
  if (opts.pageSize !== undefined) req.pageSize = opts.pageSize;
  if (opts.pageToken !== undefined) req.pageToken = opts.pageToken;
  if (opts.clientName !== undefined) req.clientName = opts.clientName;
  if (opts.owner !== undefined) req.owner = opts.owner;

  try {
    const { data } = await api.listOAuth2Clients(req);
    const list = Array.isArray(data) ? data : [];
    const items = list.map((c) =>
      tokenMapper.clientFromOry(
        c as Parameters<typeof tokenMapper.clientFromOry>[0],
        tenant,
      ),
    );
    return { items };
  } catch (err) {
    throw ErrorMapper.toNest(err, {
      correlationId: currentCorrelationId(),
    });
  }
}

async function setImpl(
  registry: TenantRegistry,
  tenant: TenantName,
  clientId: string,
  input: IamOAuth2ClientInput,
): Promise<IamOAuth2Client> {
  const api = requireAdmin(registry, tenant);
  try {
    const { data } = await api.setOAuth2Client({
      id: clientId,
      oAuth2Client: toHydraClientBody(input),
    });
    return tokenMapper.clientFromOry(
      data as Parameters<typeof tokenMapper.clientFromOry>[0],
      tenant,
    );
  } catch (err) {
    throw ErrorMapper.toNest(err, {
      correlationId: currentCorrelationId(),
    });
  }
}

async function patchImpl(
  registry: TenantRegistry,
  tenant: TenantName,
  clientId: string,
  ops: ReadonlyArray<IamJsonPatchOp>,
): Promise<IamOAuth2Client> {
  const api = requireAdmin(registry, tenant);
  try {
    const { data } = await api.patchOAuth2Client({
      id: clientId,
      jsonPatch: ops.map((o) => {
        const out: Record<string, unknown> = { op: o.op, path: o.path };
        if (o.value !== undefined) out.value = o.value;
        if (o.from !== undefined) out.from = o.from;
        return out;
      }),
    });
    return tokenMapper.clientFromOry(
      data as Parameters<typeof tokenMapper.clientFromOry>[0],
      tenant,
    );
  } catch (err) {
    throw ErrorMapper.toNest(err, {
      correlationId: currentCorrelationId(),
    });
  }
}

async function deleteImpl(
  registry: TenantRegistry,
  audit: AuditSink,
  tenant: TenantName,
  clientId: string,
): Promise<void> {
  const api = requireAdmin(registry, tenant);
  try {
    await api.deleteOAuth2Client({ id: clientId });
  } catch (err) {
    throw ErrorMapper.toNest(err, {
      correlationId: currentCorrelationId(),
    });
  }
  await audit.emit({
    timestamp: new Date().toISOString(),
    event: 'oauth2.client.delete',
    tenant,
    targetId: clientId,
    result: 'success',
    attributes: {},
    correlationId: currentCorrelationId(),
  });
}

function requireAdmin(
  registry: TenantRegistry,
  tenant: TenantName,
): OAuth2AdminLike {
  const clients: TenantClients = registry.get(tenant);
  if (!clients.hydraOauth2) {
    throw new IamConfigurationError({
      message: `Hydra admin OAuth2 client not configured for tenant '${tenant}'`,
    });
  }
  return clients.hydraOauth2 as unknown as OAuth2AdminLike;
}

function currentCorrelationId(): string | undefined {
  return correlationStorage.getStore()?.correlationId;
}
