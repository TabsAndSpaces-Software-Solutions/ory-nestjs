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

import { AUDIT_SINK, type AuditSink } from '../audit';
import { correlationStorage } from '../clients/correlation-storage';
import type { TenantClients } from '../clients';
import type { TenantName } from '../dto';
import { ErrorMapper, IamConfigurationError } from '../errors';
import { TENANT_REGISTRY } from '../module/registry/tokens';
import type { TenantRegistry } from '../module/registry/tenant-registry.service';
import { emitAudit } from './audit-helpers';

export interface IamProject {
  readonly id: string;
  readonly name: string;
  readonly slug?: string;
  readonly workspaceId?: string;
  readonly environment?: 'prod' | 'stage' | 'dev' | string;
  readonly hosts?: readonly string[];
  readonly state?: 'running' | 'halted' | 'destroyed' | string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  /**
   * Forward-compatibility slot: fields introduced by future Ory SDKs that
   * aren't yet typed. Prefer named fields above when possible.
   */
  readonly additional: Record<string, unknown>;
  readonly tenant: TenantName;
}

export interface IamProjectMember {
  readonly id: string;
  readonly email: string;
  readonly role?: string;
  readonly tenant: TenantName;
}

export interface IamProjectApiKey {
  readonly id: string;
  readonly name: string;
  readonly value?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly tenant: TenantName;
}

export interface ProjectAdminServiceFor {
  create(input: { name: string; workspaceId?: string }): Promise<IamProject>;
  list(): Promise<IamProject[]>;
  get(id: string): Promise<IamProject>;
  set(id: string, patch: Record<string, unknown>): Promise<IamProject>;
  purge(id: string): Promise<void>;
  listMembers(id: string): Promise<IamProjectMember[]>;
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
    @Inject(AUDIT_SINK) private readonly audit: AuditSink,
  ) {}

  public forTenant(name: TenantName): ProjectAdminServiceFor {
    const existing = this.byTenant.get(name);
    if (existing !== undefined) return existing;
    const reg = this.registry;
    const audit = this.audit;
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
          const project = toProject(data, name);
          await emitAudit(audit, 'iam.network.project.create', name, {
            targetId: project.id,
            attributes: {
              name: input.name,
              workspaceId: input.workspaceId,
            },
          });
          return project;
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
          const project = toProject(data, name);
          await emitAudit(audit, 'iam.network.project.set', name, {
            targetId: id,
          });
          return project;
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
        // Purge is irreversible — emit with an explicit attribute so downstream
        // alerting can key off it.
        await emitAudit(audit, 'iam.network.project.purge', name, {
          targetId: id,
          attributes: { irreversible: true },
        });
      },
      listMembers: async (id) => {
        const api = projects(reg, name);
        try {
          const { data } = await api.getProjectMembers({ projectId: id });
          const list = Array.isArray(data) ? data : [];
          return list.map((m) => toMember(m, name));
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
          const key = toApiKey(data, name);
          await emitAudit(audit, 'iam.network.project.apiKey.create', name, {
            targetId: `${projectId}/${key.id}`,
            attributes: { keyName: input.name },
          });
          return key;
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
        await emitAudit(audit, 'iam.network.project.apiKey.delete', name, {
          targetId: `${projectId}/${tokenId}`,
        });
      },
    };
    this.byTenant.set(name, wrapper);
    return wrapper;
  }
}

const PROJECT_KNOWN_FIELDS = new Set([
  'id',
  'name',
  'slug',
  'workspace_id',
  'environment',
  'hosts',
  'state',
  'created_at',
  'updated_at',
]);

function toProject(raw: unknown, tenant: TenantName): IamProject {
  const p = (raw ?? {}) as Record<string, unknown>;
  const additional: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (!PROJECT_KNOWN_FIELDS.has(k)) additional[k] = v;
  }
  return {
    id: typeof p.id === 'string' ? p.id : '',
    name: typeof p.name === 'string' ? p.name : '',
    slug: typeof p.slug === 'string' ? p.slug : undefined,
    workspaceId:
      typeof p.workspace_id === 'string' ? p.workspace_id : undefined,
    environment:
      typeof p.environment === 'string'
        ? (p.environment as IamProject['environment'])
        : undefined,
    hosts: Array.isArray(p.hosts) ? (p.hosts as string[]) : undefined,
    state:
      typeof p.state === 'string' ? (p.state as IamProject['state']) : undefined,
    createdAt: typeof p.created_at === 'string' ? p.created_at : undefined,
    updatedAt: typeof p.updated_at === 'string' ? p.updated_at : undefined,
    additional,
    tenant,
  };
}

function toMember(raw: unknown, tenant: TenantName): IamProjectMember {
  const m = (raw ?? {}) as Record<string, unknown>;
  return {
    id: typeof m.id === 'string' ? m.id : '',
    email: typeof m.email === 'string' ? m.email : '',
    role: typeof m.role === 'string' ? m.role : undefined,
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
    updatedAt: typeof k.updated_at === 'string' ? k.updated_at : undefined,
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
