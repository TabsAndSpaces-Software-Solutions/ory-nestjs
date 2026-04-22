/**
 * `JwkService` — tenant-scoped Hydra JSON Web Key Set CRUD.
 *
 * Wraps `JwkApi`:
 *   - createJsonWebKeySet  (generate a new key set with one seeded key)
 *   - getJsonWebKeySet     (fetch full set by name)
 *   - updateJsonWebKeySet  (replace keys)
 *   - deleteJsonWebKeySet  (delete the whole set)
 *   - getJsonWebKey        (single key by set + kid)
 *   - updateJsonWebKey     (replace single key)
 *   - deleteJsonWebKey     (delete single key)
 *
 * Zero `@ory/*` imports; structural access only.
 */
import { Inject, Injectable } from '@nestjs/common';

import { correlationStorage } from '../clients/correlation-storage';
import type { TenantClients } from '../clients';
import type {
  TenantName,
  IamJsonWebKey,
  IamJsonWebKeySet,
} from '../dto';
import { tokenMapper } from '../dto/mappers';
import { ErrorMapper, IamConfigurationError } from '../errors';
import { TENANT_REGISTRY } from '../module/registry/tokens';
import type { TenantRegistry } from '../module/registry/tenant-registry.service';

export interface IamJwkCreateInput {
  /** JWS algorithm, e.g. RS256, ES256, HS256. */
  readonly alg: string;
  /** Intended use: 'sig' (signature) or 'enc' (encryption). */
  readonly use: 'sig' | 'enc';
  /** Optional explicit key id. If omitted, Hydra generates one. */
  readonly kid?: string;
}

export interface JwkServiceFor {
  createSet(setName: string, input: IamJwkCreateInput): Promise<IamJsonWebKeySet>;
  getSet(setName: string): Promise<IamJsonWebKeySet>;
  updateSet(
    setName: string,
    keys: readonly IamJsonWebKey[],
  ): Promise<IamJsonWebKeySet>;
  deleteSet(setName: string): Promise<void>;
  getKey(setName: string, kid: string): Promise<IamJsonWebKey>;
  updateKey(
    setName: string,
    kid: string,
    key: IamJsonWebKey,
  ): Promise<IamJsonWebKey>;
  deleteKey(setName: string, kid: string): Promise<void>;
}

interface JwkApiLike {
  createJsonWebKeySet(req: unknown): Promise<{ data: unknown }>;
  getJsonWebKeySet(req: unknown): Promise<{ data: unknown }>;
  setJsonWebKeySet(req: unknown): Promise<{ data: unknown }>;
  deleteJsonWebKeySet(req: unknown): Promise<{ data: unknown }>;
  getJsonWebKey(req: unknown): Promise<{ data: unknown }>;
  setJsonWebKey(req: unknown): Promise<{ data: unknown }>;
  deleteJsonWebKey(req: unknown): Promise<{ data: unknown }>;
}

@Injectable()
export class JwkService {
  private readonly byTenant = new Map<TenantName, JwkServiceFor>();

  constructor(
    @Inject(TENANT_REGISTRY) private readonly registry: TenantRegistry,
  ) {}

  public forTenant(name: TenantName): JwkServiceFor {
    const existing = this.byTenant.get(name);
    if (existing !== undefined) return existing;
    const reg = this.registry;
    const wrapper: JwkServiceFor = {
      createSet: async (s, i) => {
        const api = jwkApi(reg, name);
        try {
          const { data } = await api.createJsonWebKeySet({
            set: s,
            createJsonWebKeySet: { alg: i.alg, use: i.use, kid: i.kid ?? '' },
          });
          return tokenMapper.jwksFromOry(
            data as Parameters<typeof tokenMapper.jwksFromOry>[0],
            name,
          );
        } catch (err) {
          throw ErrorMapper.toNest(err, { correlationId: corrId() });
        }
      },
      getSet: async (s) => {
        const api = jwkApi(reg, name);
        try {
          const { data } = await api.getJsonWebKeySet({ set: s });
          return tokenMapper.jwksFromOry(
            data as Parameters<typeof tokenMapper.jwksFromOry>[0],
            name,
          );
        } catch (err) {
          throw ErrorMapper.toNest(err, { correlationId: corrId() });
        }
      },
      updateSet: async (s, keys) => {
        const api = jwkApi(reg, name);
        try {
          const { data } = await api.setJsonWebKeySet({
            set: s,
            jsonWebKeySet: { keys: [...keys] },
          });
          return tokenMapper.jwksFromOry(
            data as Parameters<typeof tokenMapper.jwksFromOry>[0],
            name,
          );
        } catch (err) {
          throw ErrorMapper.toNest(err, { correlationId: corrId() });
        }
      },
      deleteSet: async (s) => {
        const api = jwkApi(reg, name);
        try {
          await api.deleteJsonWebKeySet({ set: s });
        } catch (err) {
          throw ErrorMapper.toNest(err, { correlationId: corrId() });
        }
      },
      getKey: async (s, kid) => {
        const api = jwkApi(reg, name);
        try {
          const { data } = await api.getJsonWebKey({ set: s, kid });
          const set = data as { keys?: unknown[] };
          const first = Array.isArray(set.keys) && set.keys[0];
          return tokenMapper.jwkFromOry(
            (first ?? {}) as Parameters<typeof tokenMapper.jwkFromOry>[0],
          );
        } catch (err) {
          throw ErrorMapper.toNest(err, { correlationId: corrId() });
        }
      },
      updateKey: async (s, kid, key) => {
        const api = jwkApi(reg, name);
        try {
          const { data } = await api.setJsonWebKey({
            set: s,
            kid,
            jsonWebKey: key,
          });
          return tokenMapper.jwkFromOry(
            data as Parameters<typeof tokenMapper.jwkFromOry>[0],
          );
        } catch (err) {
          throw ErrorMapper.toNest(err, { correlationId: corrId() });
        }
      },
      deleteKey: async (s, kid) => {
        const api = jwkApi(reg, name);
        try {
          await api.deleteJsonWebKey({ set: s, kid });
        } catch (err) {
          throw ErrorMapper.toNest(err, { correlationId: corrId() });
        }
      },
    };
    this.byTenant.set(name, wrapper);
    return wrapper;
  }
}

function jwkApi(registry: TenantRegistry, tenant: TenantName): JwkApiLike {
  const clients: TenantClients = registry.get(tenant);
  if (!clients.hydraJwk) {
    throw new IamConfigurationError({
      message: `Hydra JWK API not configured for tenant '${tenant}'`,
    });
  }
  return clients.hydraJwk as unknown as JwkApiLike;
}

function corrId(): string | undefined {
  return correlationStorage.getStore()?.correlationId;
}
