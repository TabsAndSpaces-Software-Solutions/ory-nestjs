/**
 * `TenantRegistry` — single source of truth mapping `TenantName` to the
 * per-tenant `TenantClients` bundle.
 *
 * Built eagerly at module init from the validated `IamOptions`. The
 * registry delegates actual `TenantClients` construction to an injected
 * `TenantClientsBuilder` function so that:
 *   - this file does not import any `@ory/*` type directly (the ESLint ban
 *     rule forbids it under `src/module/**`),
 *   - tests can stub the builder with a Jest spy and never touch the real
 *     `OryClientFactory` / axios stack,
 *   - the module assembly unit can wire the builder to
 *     `(name, cfg) => OryClientFactory.build(name, cfg, { axios: axiosFor(cfg) })`.
 *
 * Defensive invariants:
 *   - zero tenants → throw `IamConfigurationError` (ConfigLoader also
 *     rejects this, but the registry must not silently produce an empty
 *     container),
 *   - `defaultTenant` naming an absent tenant → throw (same dual-defense),
 *   - any builder failure is wrapped in `IamConfigurationError` with the
 *     offending tenant name for operator debuggability.
 *
 * Idempotency: `get(name)` returns the exact same `TenantClients` object
 * for the lifetime of the module — built once in the constructor, stored
 * in an internal `Map`.
 *
 * This class is NEVER re-exported from `src/index.ts`; it is only reachable
 * via the internal `TENANT_REGISTRY` DI token.
 */
import { Injectable } from '@nestjs/common';

import type { TenantClients } from '../../clients';
import type {
  ValidatedTenantConfig,
  ValidatedIamOptions,
} from '../../config';
import type { TenantName } from '../../dto';
import { IamConfigurationError } from '../../errors';

/**
 * Builds a `TenantClients` bundle for a single tenant. The module assembly
 * layer supplies an implementation that delegates to `OryClientFactory.build`
 * with a tenant-scoped `AxiosInstance`; unit tests supply a Jest spy.
 */
export type TenantClientsBuilder = (
  tenant: TenantName,
  config: ValidatedTenantConfig,
) => TenantClients;

@Injectable()
export class TenantRegistry {
  private readonly clientsByTenant: Map<TenantName, TenantClients>;
  private readonly resolvedDefault: TenantName | undefined;

  constructor(
    options: ValidatedIamOptions,
    build: TenantClientsBuilder,
  ) {
    const names = Object.keys(options.tenants);
    if (names.length === 0) {
      throw new IamConfigurationError({
        message:
          'TenantRegistry cannot be constructed with zero tenants. ' +
          'Declare at least one tenant in IamOptions.tenants.',
      });
    }

    if (
      options.defaultTenant !== undefined &&
      !(options.defaultTenant in options.tenants)
    ) {
      throw new IamConfigurationError({
        message:
          `defaultTenant '${options.defaultTenant}' is not declared in tenants. ` +
          `Known tenants: ${names.join(', ')}.`,
      });
    }

    const map = new Map<TenantName, TenantClients>();
    for (const name of names) {
      const cfg = options.tenants[name];
      try {
        map.set(name, build(name, cfg));
      } catch (cause) {
        throw new IamConfigurationError({
          message: `Failed to build TenantClients for tenant '${name}': ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          cause,
        });
      }
    }
    this.clientsByTenant = map;

    if (options.defaultTenant !== undefined) {
      this.resolvedDefault = options.defaultTenant;
    } else if (names.length === 1) {
      this.resolvedDefault = names[0];
    } else {
      this.resolvedDefault = undefined;
    }
  }

  /**
   * Return the `TenantClients` bundle for `name`. Throws
   * `IamConfigurationError` if `name` is not a declared tenant — unknown
   * names must fail loudly at the call site rather than silently routing
   * to a default.
   */
  public get(name: TenantName): TenantClients {
    const clients = this.clientsByTenant.get(name);
    if (clients === undefined) {
      throw new IamConfigurationError({
        message: `unknown tenant: ${name}`,
      });
    }
    return clients;
  }

  /**
   * Non-throwing variant of `get`. Useful for call sites that want to
   * distinguish unknown-tenant from other errors without a try/catch.
   */
  public tryGet(name: TenantName): TenantClients | undefined {
    return this.clientsByTenant.get(name);
  }

  /**
   * The configured (or derived) default tenant, or `undefined` when the
   * library must refuse to pick one.
   *
   * Resolution order:
   *   1. explicit `options.defaultTenant`,
   *   2. the sole tenant when exactly one is declared,
   *   3. otherwise `undefined`.
   */
  public defaultTenant(): TenantName | undefined {
    return this.resolvedDefault;
  }

  /** Names of every declared tenant, in insertion order. */
  public list(): TenantName[] {
    return [...this.clientsByTenant.keys()];
  }
}
