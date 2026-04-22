/**
 * `WorkspaceAdminService` — Ory Network workspace control-plane admin.
 *
 * Wraps `WorkspaceApi`:
 *   - createWorkspace, listWorkspaces, getWorkspace, updateWorkspace
 *   - listWorkspaceProjects
 *   - createWorkspaceApiKey, listWorkspaceApiKeys, deleteWorkspaceApiKey
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

export interface IamWorkspace {
  readonly id: string;
  readonly name: string;
  readonly raw: Record<string, unknown>;
  readonly tenant: TenantName;
}

export interface IamWorkspaceApiKey {
  readonly id: string;
  readonly name: string;
  readonly value?: string;
  readonly createdAt?: string;
  readonly tenant: TenantName;
}

export interface WorkspaceAdminServiceFor {
  create(input: { name: string }): Promise<IamWorkspace>;
  list(opts?: { pageSize?: number; pageToken?: string }): Promise<IamWorkspace[]>;
  get(id: string): Promise<IamWorkspace>;
  update(id: string, patch: Record<string, unknown>): Promise<IamWorkspace>;
  listProjects(workspaceId: string): Promise<Array<Record<string, unknown>>>;
  createApiKey(
    workspaceId: string,
    input: { name: string },
  ): Promise<IamWorkspaceApiKey>;
  listApiKeys(workspaceId: string): Promise<IamWorkspaceApiKey[]>;
  deleteApiKey(workspaceId: string, tokenId: string): Promise<void>;
}

interface WorkspaceApiLike {
  createWorkspace(req?: unknown): Promise<{ data: unknown }>;
  listWorkspaces(req?: unknown): Promise<{ data: unknown }>;
  getWorkspace(req: unknown): Promise<{ data: unknown }>;
  updateWorkspace(req: unknown): Promise<{ data: unknown }>;
  listWorkspaceProjects(req: unknown): Promise<{ data: unknown }>;
  createWorkspaceApiKey(req: unknown): Promise<{ data: unknown }>;
  listWorkspaceApiKeys(req: unknown): Promise<{ data: unknown }>;
  deleteWorkspaceApiKey(req: unknown): Promise<{ data: unknown }>;
}

@Injectable()
export class WorkspaceAdminService {
  private readonly byTenant = new Map<TenantName, WorkspaceAdminServiceFor>();

  constructor(
    @Inject(TENANT_REGISTRY) private readonly registry: TenantRegistry,
  ) {}

  public forTenant(name: TenantName): WorkspaceAdminServiceFor {
    const existing = this.byTenant.get(name);
    if (existing !== undefined) return existing;
    const reg = this.registry;
    const wrapper: WorkspaceAdminServiceFor = {
      create: async (input) => {
        const api = ws(reg, name);
        try {
          const { data } = await api.createWorkspace({
            createWorkspaceBody: { name: input.name },
          });
          return toWs(data, name);
        } catch (err) {
          throw ErrorMapper.toNest(err, { correlationId: corrId() });
        }
      },
      list: async (opts) => {
        const api = ws(reg, name);
        const req: Record<string, unknown> = {};
        if (opts?.pageSize !== undefined) req.pageSize = opts.pageSize;
        if (opts?.pageToken !== undefined) req.pageToken = opts.pageToken;
        try {
          const { data } = await api.listWorkspaces(req);
          const list = Array.isArray(data) ? data : [];
          return list.map((w) => toWs(w, name));
        } catch (err) {
          throw ErrorMapper.toNest(err, { correlationId: corrId() });
        }
      },
      get: async (id) => {
        const api = ws(reg, name);
        try {
          const { data } = await api.getWorkspace({ workspace: id });
          return toWs(data, name);
        } catch (err) {
          throw ErrorMapper.toNest(err, { correlationId: corrId() });
        }
      },
      update: async (id, patch) => {
        const api = ws(reg, name);
        try {
          const { data } = await api.updateWorkspace({
            workspace: id,
            updateWorkspaceBody: patch,
          });
          return toWs(data, name);
        } catch (err) {
          throw ErrorMapper.toNest(err, { correlationId: corrId() });
        }
      },
      listProjects: async (workspaceId) => {
        const api = ws(reg, name);
        try {
          const { data } = await api.listWorkspaceProjects({
            workspace: workspaceId,
          });
          return Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
        } catch (err) {
          throw ErrorMapper.toNest(err, { correlationId: corrId() });
        }
      },
      createApiKey: async (workspaceId, input) => {
        const api = ws(reg, name);
        try {
          const { data } = await api.createWorkspaceApiKey({
            workspace: workspaceId,
            createWorkspaceApiKeyBody: { name: input.name },
          });
          return toKey(data, name);
        } catch (err) {
          throw ErrorMapper.toNest(err, { correlationId: corrId() });
        }
      },
      listApiKeys: async (workspaceId) => {
        const api = ws(reg, name);
        try {
          const { data } = await api.listWorkspaceApiKeys({
            workspace: workspaceId,
          });
          const list = Array.isArray(data) ? data : [];
          return list.map((k) => toKey(k, name));
        } catch (err) {
          throw ErrorMapper.toNest(err, { correlationId: corrId() });
        }
      },
      deleteApiKey: async (workspaceId, tokenId) => {
        const api = ws(reg, name);
        try {
          await api.deleteWorkspaceApiKey({
            workspace: workspaceId,
            tokenId,
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

function toWs(raw: unknown, tenant: TenantName): IamWorkspace {
  const w = (raw ?? {}) as Record<string, unknown>;
  return {
    id: typeof w.id === 'string' ? w.id : '',
    name: typeof w.name === 'string' ? w.name : '',
    raw: w,
    tenant,
  };
}

function toKey(raw: unknown, tenant: TenantName): IamWorkspaceApiKey {
  const k = (raw ?? {}) as Record<string, unknown>;
  return {
    id: typeof k.id === 'string' ? k.id : '',
    name: typeof k.name === 'string' ? k.name : '',
    value: typeof k.value === 'string' ? k.value : undefined,
    createdAt: typeof k.created_at === 'string' ? k.created_at : undefined,
    tenant,
  };
}

function ws(registry: TenantRegistry, tenant: TenantName): WorkspaceApiLike {
  const clients: TenantClients = registry.get(tenant);
  if (!clients.networkWorkspace) {
    throw new IamConfigurationError({
      message: `Ory Network workspace admin not configured for tenant '${tenant}' (requires mode: 'cloud' + cloud.workspaceApiKey)`,
    });
  }
  return clients.networkWorkspace as unknown as WorkspaceApiLike;
}

function corrId(): string | undefined {
  return correlationStorage.getStore()?.correlationId;
}
