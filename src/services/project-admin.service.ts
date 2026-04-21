/**
 * `ProjectAdminService` — Ory Network project control-plane admin.
 *
 * Wraps `ProjectApi`:
 *   - createProject, listProjects, getProject, setProject, purgeProject
 *   - getProjectMembers
 *   - createProjectApiKey, listProjectApiKeys, deleteProjectApiKey
 *
 * Requires cloud mode + a valid workspace/project API key. Self-hosted
 * tenants throw `IamConfigurationError`.
 *
 * Results pass through mostly unaltered — the Ory Network project object is
 * a large opaque envelope; we expose it as `Record<string, unknown>` with
 * `tenant` stamped on top. If type safety matters, build a DTO downstream.
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

export interface IamProject {
  readonly id: string;
  readonly name: string;
  readonly slug?: string;
  readonly workspaceId?: string;
  readonly raw: Record<string, unknown>;
  readonly tenant: TenantName;
}

export interface IamProjectApiKey {
  readonly id: string;
  readonly name: string;
  readonly value?: string;
  readonly createdAt?: string;
  readonly tenant: TenantName;
}

export interface ProjectAdminServiceFor {
  create(input: { name: string; workspaceId?: string }): Promise<IamProject>;
  list(): Promise<IamProject[]>;
  get(id: string): Promise<IamProject>;
  set(id: string, patch: Record<string, unknown>): Promise<IamProject>;
  purge(id: string): Promise<void>;
  listMembers(id: string): Promise<Array<Record<string, unknown>>>;
  createApiKey(
    projectId: string,
    input: { name: string },
  ): Promise<IamProjectApiKey>;
  listApiKeys(projectId: string): Promise<IamProjectApiKey[]>;
  deleteApiKey(projectId: string, tokenId: string): Promise<void>;
}

interface ProjectApiLike {
  createProject(req?: unknown): Promise<{ data: unknown }>;
  listProjects(): Promise<{ data: unknown }>;
  getProject(req: unknown): Promise<{ data: unknown }>;
  setProject(req: unknown): Promise<{ data: unknown }>;
  purgeProject(req: unknown): Promise<{ data: unknown }>;
  getProjectMembers(req: unknown): Promise<{ data: unknown }>;
  createProjectApiKey(req: unknown): Promise<{ data: unknown }>;
  listProjectApiKeys(req: unknown): Promise<{ data: unknown }>;
  deleteProjectApiKey(req: unknown): Promise<{ data: unknown }>;
}

@Injectable()
export class ProjectAdminService {
  private readonly byTenant = new Map<TenantName, ProjectAdminServiceFor>();

  constructor(
    @Inject(TENANT_REGISTRY) private readonly registry: TenantRegistry,
  ) {}

  public forTenant(name: TenantName): ProjectAdminServiceFor {
    const existing = this.byTenant.get(name);
    if (existing !== undefined) return existing;
    const reg = this.registry;
    const wrapper: ProjectAdminServiceFor = {
      create: async (input) => {
        const api = projects(reg, name);
        try {
          const { data } = await api.createProject({
            createProjectBody: {
              name: input.name,
              ...(input.workspaceId ? { workspace_id: input.workspaceId } : {}),
            },
          });
          return toProject(data, name);
        } catch (err) {
          throw ErrorMapper.toNest(err, { correlationId: corrId() });
        }
      },
      list: async () => {
        const api = projects(reg, name);
        try {
          const { data } = await api.listProjects();
          const list = Array.isArray(data) ? data : [];
          return list.map((p) => toProject(p, name));
        } catch (err) {
          throw ErrorMapper.toNest(err, { correlationId: corrId() });
        }
      },
      get: async (id) => {
        const api = projects(reg, name);
        try {
          const { data } = await api.getProject({ projectId: id });
          return toProject(data, name);
        } catch (err) {
          throw ErrorMapper.toNest(err, { correlationId: corrId() });
        }
      },
      set: async (id, patch) => {
        const api = projects(reg, name);
        try {
          const { data } = await api.setProject({
            projectId: id,
            setProject: patch,
          });
          return toProject(data, name);
        } catch (err) {
          throw ErrorMapper.toNest(err, { correlationId: corrId() });
        }
      },
      purge: async (id) => {
        const api = projects(reg, name);
        try {
          await api.purgeProject({ projectId: id });
        } catch (err) {
          throw ErrorMapper.toNest(err, { correlationId: corrId() });
        }
      },
      listMembers: async (id) => {
        const api = projects(reg, name);
        try {
          const { data } = await api.getProjectMembers({ projectId: id });
          return Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
        } catch (err) {
          throw ErrorMapper.toNest(err, { correlationId: corrId() });
        }
      },
      createApiKey: async (projectId, input) => {
        const api = projects(reg, name);
        try {
          const { data } = await api.createProjectApiKey({
            project: projectId,
            createProjectApiKeyRequest: { name: input.name },
          });
          return toApiKey(data, name);
        } catch (err) {
          throw ErrorMapper.toNest(err, { correlationId: corrId() });
        }
      },
      listApiKeys: async (projectId) => {
        const api = projects(reg, name);
        try {
          const { data } = await api.listProjectApiKeys({ project: projectId });
          const list = Array.isArray(data) ? data : [];
          return list.map((k) => toApiKey(k, name));
        } catch (err) {
          throw ErrorMapper.toNest(err, { correlationId: corrId() });
        }
      },
      deleteApiKey: async (projectId, tokenId) => {
        const api = projects(reg, name);
        try {
          await api.deleteProjectApiKey({ project: projectId, tokenId });
        } catch (err) {
          throw ErrorMapper.toNest(err, { correlationId: corrId() });
        }
      },
    };
    this.byTenant.set(name, wrapper);
    return wrapper;
  }
}

function toProject(raw: unknown, tenant: TenantName): IamProject {
  const p = (raw ?? {}) as Record<string, unknown>;
  return {
    id: typeof p.id === 'string' ? p.id : '',
    name: typeof p.name === 'string' ? p.name : '',
    slug: typeof p.slug === 'string' ? p.slug : undefined,
    workspaceId:
      typeof p.workspace_id === 'string' ? p.workspace_id : undefined,
    raw: p,
    tenant,
  };
}

function toApiKey(raw: unknown, tenant: TenantName): IamProjectApiKey {
  const k = (raw ?? {}) as Record<string, unknown>;
  return {
    id: typeof k.id === 'string' ? k.id : '',
    name: typeof k.name === 'string' ? k.name : '',
    value: typeof k.value === 'string' ? k.value : undefined,
    createdAt: typeof k.created_at === 'string' ? k.created_at : undefined,
    tenant,
  };
}

function projects(registry: TenantRegistry, tenant: TenantName): ProjectApiLike {
  const clients: TenantClients = registry.get(tenant);
  if (!clients.networkProject) {
    throw new IamConfigurationError({
      message: `Ory Network project admin not configured for tenant '${tenant}' (requires mode: 'cloud' + cloud.workspaceApiKey)`,
    });
  }
  return clients.networkProject as unknown as ProjectApiLike;
}

function corrId(): string | undefined {
  return correlationStorage.getStore()?.correlationId;
}
