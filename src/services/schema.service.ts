/**
 * `SchemaService` — tenant-scoped Kratos identity-schema read access.
 *
 * Identity schemas are JSON-Schema fragments that define the shape of a
 * tenant's `identity.traits`. In `@ory/client`, `listIdentitySchemas` /
 * `getIdentitySchema` are exposed on the admin `IdentityApi` even though
 * the underlying HTTP endpoints don't require authentication — the SDK
 * bundles them with the admin client. We therefore reach them through
 * `TenantClients.kratosIdentity` and require admin configuration.
 *
 * Zero-Ory-leakage: no `@ory/*` imports in this file. The `IdentityApi`
 * reference is reached structurally.
 */
import { Inject, Injectable } from '@nestjs/common';

import { correlationStorage } from '../clients/correlation-storage';
import type { TenantName, IamIdentitySchema } from '../dto';
import { deepFreeze } from '../dto';
import { ErrorMapper, IamConfigurationError } from '../errors';
import { TENANT_REGISTRY } from '../module/registry/tokens';
import type { TenantRegistry } from '../module/registry/tenant-registry.service';

export interface SchemaServiceFor {
  /** Return the JSON-Schema for a given identity schema id. */
  get(id: string): Promise<IamIdentitySchema>;
  /** List all configured identity schemas. */
  list(): Promise<IamIdentitySchema[]>;
}

interface SchemaApiLike {
  getIdentitySchema(req: unknown): Promise<{ data: unknown }>;
  listIdentitySchemas(req?: unknown): Promise<{ data: unknown }>;
}

@Injectable()
export class SchemaService {
  private readonly byTenant = new Map<TenantName, SchemaServiceFor>();

  constructor(
    @Inject(TENANT_REGISTRY) private readonly registry: TenantRegistry,
  ) {}

  public forTenant(name: TenantName): SchemaServiceFor {
    const existing = this.byTenant.get(name);
    if (existing !== undefined) return existing;

    const wrapper: SchemaServiceFor = {
      get: (id) => getImpl(this.registry, name, id),
      list: () => listImpl(this.registry, name),
    };
    this.byTenant.set(name, wrapper);
    return wrapper;
  }
}

async function getImpl(
  registry: TenantRegistry,
  tenant: TenantName,
  id: string,
): Promise<IamIdentitySchema> {
  const api = schemaApi(registry, tenant);
  try {
    const { data } = await api.getIdentitySchema({ id });
    return deepFreeze({
      id,
      schema: (data as Record<string, unknown>) ?? {},
      tenant,
    });
  } catch (err) {
    throw ErrorMapper.toNest(err, {
      correlationId: currentCorrelationId(),
    });
  }
}

async function listImpl(
  registry: TenantRegistry,
  tenant: TenantName,
): Promise<IamIdentitySchema[]> {
  const api = schemaApi(registry, tenant);
  try {
    const { data } = await api.listIdentitySchemas();
    const list = Array.isArray(data) ? data : [];
    return list.map((entry) => {
      const asObj = (entry ?? {}) as { id?: unknown; schema?: unknown };
      return deepFreeze({
        id: typeof asObj.id === 'string' ? asObj.id : '',
        schema: (asObj.schema as Record<string, unknown>) ?? {},
        tenant,
      });
    });
  } catch (err) {
    throw ErrorMapper.toNest(err, {
      correlationId: currentCorrelationId(),
    });
  }
}

function schemaApi(
  registry: TenantRegistry,
  tenant: TenantName,
): SchemaApiLike {
  const clients = registry.get(tenant);
  if (clients.kratosIdentity === undefined) {
    throw new IamConfigurationError({
      message: `Kratos identity API not configured for tenant '${tenant}' (schemas require kratos.adminUrl + kratos.adminToken)`,
    });
  }
  return clients.kratosIdentity as unknown as SchemaApiLike;
}

function currentCorrelationId(): string | undefined {
  return correlationStorage.getStore()?.correlationId;
}
