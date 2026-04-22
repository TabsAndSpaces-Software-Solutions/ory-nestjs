/**
 * `MetadataService` — tenant-scoped read access to Hydra/Kratos metadata
 * and well-known endpoints.
 *
 *   - `version()` → upstream `MetadataApi.getVersion()` (Hydra/Kratos build
 *     version, useful for diagnostics).
 *   - `discoverJwks()` → Hydra public `/.well-known/jwks.json` via
 *     `WellknownApi.discoverJsonWebKeys()`.
 *
 * Both bypass the library's fail-closed contract — they're diagnostic endpoints
 * that return data even during partial outages.
 *
 * Zero `@ory/*` imports.
 */
import { Inject, Injectable } from '@nestjs/common';

import { correlationStorage } from '../clients/correlation-storage';
import type { TenantClients } from '../clients';
import type { TenantName, IamJsonWebKeySet } from '../dto';
import { tokenMapper } from '../dto/mappers';
import { ErrorMapper, IamConfigurationError } from '../errors';
import { TENANT_REGISTRY } from '../module/registry/tokens';
import type { TenantRegistry } from '../module/registry/tenant-registry.service';

export interface MetadataServiceFor {
  version(): Promise<{ version: string }>;
  discoverJwks(): Promise<IamJsonWebKeySet>;
}

interface MetadataApiLike {
  getVersion(): Promise<{ data: unknown }>;
}

interface WellknownApiLike {
  discoverJsonWebKeys(): Promise<{ data: unknown }>;
}

@Injectable()
export class MetadataService {
  private readonly byTenant = new Map<TenantName, MetadataServiceFor>();

  constructor(
    @Inject(TENANT_REGISTRY) private readonly registry: TenantRegistry,
  ) {}

  public forTenant(name: TenantName): MetadataServiceFor {
    const existing = this.byTenant.get(name);
    if (existing !== undefined) return existing;
    const reg = this.registry;
    const wrapper: MetadataServiceFor = {
      version: async () => {
        const api = metadata(reg, name);
        try {
          const { data } = await api.getVersion();
          const v = (data ?? {}) as { version?: unknown };
          return { version: typeof v.version === 'string' ? v.version : '' };
        } catch (err) {
          throw ErrorMapper.toNest(err, { correlationId: corrId() });
        }
      },
      discoverJwks: async () => {
        const api = wellknown(reg, name);
        try {
          const { data } = await api.discoverJsonWebKeys();
          return tokenMapper.jwksFromOry(
            data as Parameters<typeof tokenMapper.jwksFromOry>[0],
            name,
          );
        } catch (err) {
          throw ErrorMapper.toNest(err, { correlationId: corrId() });
        }
      },
    };
    this.byTenant.set(name, wrapper);
    return wrapper;
  }
}

function metadata(reg: TenantRegistry, tenant: TenantName): MetadataApiLike {
  const clients: TenantClients = reg.get(tenant);
  if (!clients.hydraMetadata) {
    throw new IamConfigurationError({
      message: `Hydra metadata API not configured for tenant '${tenant}'`,
    });
  }
  return clients.hydraMetadata as unknown as MetadataApiLike;
}

function wellknown(reg: TenantRegistry, tenant: TenantName): WellknownApiLike {
  const clients: TenantClients = reg.get(tenant);
  if (!clients.hydraWellknown) {
    throw new IamConfigurationError({
      message: `Hydra wellknown API not configured for tenant '${tenant}'`,
    });
  }
  return clients.hydraWellknown as unknown as WellknownApiLike;
}

function corrId(): string | undefined {
  return correlationStorage.getStore()?.correlationId;
}
