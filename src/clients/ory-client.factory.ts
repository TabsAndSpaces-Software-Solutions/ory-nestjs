/**
 * `OryClientFactory.build(tenant, tenantConfig, deps)` — assembles the
 * full `TenantClients` bundle for a tenant from:
 *   - the shared-per-tenant `AxiosInstance` (caller provides it; see
 *     `AxiosFactory.create`),
 *   - the tenant's validated `TenantConfig`,
 *   - product selection (Kratos always; admin/keto/hydra by config).
 *
 * Design notes:
 *   - This is the ONLY module that instantiates `@ory/client` classes at
 *     runtime. Mappers import Ory *types* for signatures but never call
 *     constructors. Guard: the ESLint ban allows `@ory/*` inside
 *     `src/clients/**` only.
 *   - `Configuration.baseOptions` is unused here because the `BaseAPI`
 *     constructor accepts the axios instance as its third argument and
 *     uses it unconditionally; wiring through `baseOptions` would only
 *     affect per-call options, not the transport itself.
 *   - Self-hosted: per-product URLs drive `basePath`. Admin APIs carry
 *     `accessToken` from their product's `adminToken` config.
 *   - Cloud: one project URL hosts all APIs. `accessToken` comes from the
 *     cloud API key. Admin APIs are auto-provisioned because Ory Cloud
 *     does not split admin/public across separate URLs.
 *   - Hydra's public vs admin split: the Ory `OAuth2Api` SDK surfaces both
 *     admin and public endpoints (OAuth2 client CRUD + token introspection
 *     on the admin side, token issuance on the public side). We
 *     instantiate ONE `OAuth2Api` bound to `hydra.adminUrl` with the admin
 *     token. Public-facing token endpoints called through this same API
 *     instance will reach the admin URL — acceptable in practice because
 *     Hydra's admin port is typically reachable from the same service,
 *     and this simplification keeps the client bundle tidy.
 */
import type { AxiosInstance } from 'axios';
import {
  Configuration,
  FrontendApi,
  IdentityApi,
  OAuth2Api,
  PermissionApi,
  RelationshipApi,
} from '@ory/client';

import type { TenantConfig } from '../config';
import type { TenantName } from '../dto';
import type { TenantClients } from './tenant-clients';

export interface OryClientFactoryDeps {
  axios: AxiosInstance;
}

export class OryClientFactory {
  private constructor() {
    throw new Error(
      'OryClientFactory is a static class and cannot be instantiated.',
    );
  }

  public static build(
    tenant: TenantName,
    config: TenantConfig,
    deps: OryClientFactoryDeps,
  ): TenantClients {
    if (config.mode === 'cloud') {
      return OryClientFactory.buildCloud(tenant, config, deps);
    }
    return OryClientFactory.buildSelfHosted(tenant, config, deps);
  }

  private static buildSelfHosted(
    tenant: TenantName,
    config: TenantConfig,
    deps: OryClientFactoryDeps,
  ): TenantClients {
    const { axios } = deps;

    const kratosFrontend = new FrontendApi(
      new Configuration({ basePath: config.kratos.publicUrl }),
      config.kratos.publicUrl,
      axios,
    );

    let kratosIdentity: IdentityApi | undefined;
    if (config.kratos.adminUrl && config.kratos.adminToken) {
      kratosIdentity = new IdentityApi(
        new Configuration({
          basePath: config.kratos.adminUrl,
          accessToken: config.kratos.adminToken,
        }),
        config.kratos.adminUrl,
        axios,
      );
    }

    let ketoPermission: PermissionApi | undefined;
    let ketoRelationship: RelationshipApi | undefined;
    if (config.keto) {
      ketoPermission = new PermissionApi(
        new Configuration({
          basePath: config.keto.readUrl,
          accessToken: config.keto.apiKey,
        }),
        config.keto.readUrl,
        axios,
      );
      ketoRelationship = new RelationshipApi(
        new Configuration({
          basePath: config.keto.writeUrl,
          accessToken: config.keto.apiKey,
        }),
        config.keto.writeUrl,
        axios,
      );
    }

    let hydraOauth2: OAuth2Api | undefined;
    if (config.hydra) {
      hydraOauth2 = new OAuth2Api(
        new Configuration({
          basePath: config.hydra.adminUrl,
          accessToken: config.hydra.adminToken,
        }),
        config.hydra.adminUrl,
        axios,
      );
    }

    return {
      tenant,
      config,
      axios,
      kratosFrontend,
      kratosIdentity,
      ketoPermission,
      ketoRelationship,
      hydraOauth2,
    };
  }

  private static buildCloud(
    tenant: TenantName,
    config: TenantConfig,
    deps: OryClientFactoryDeps,
  ): TenantClients {
    const { axios } = deps;
    // Schema already guarantees config.cloud is present in cloud mode.
    // `as` is used because TS can't narrow through the superRefine.
    const cloud = config.cloud as NonNullable<typeof config.cloud>;
    const basePath = `https://${cloud.projectSlug}.projects.oryapis.com`;
    const accessToken = cloud.apiKey;

    const kratosFrontend = new FrontendApi(
      new Configuration({ basePath }),
      basePath,
      axios,
    );
    const kratosIdentity = new IdentityApi(
      new Configuration({ basePath, accessToken }),
      basePath,
      axios,
    );
    const ketoPermission = new PermissionApi(
      new Configuration({ basePath, accessToken }),
      basePath,
      axios,
    );
    const ketoRelationship = new RelationshipApi(
      new Configuration({ basePath, accessToken }),
      basePath,
      axios,
    );
    const hydraOauth2 = new OAuth2Api(
      new Configuration({ basePath, accessToken }),
      basePath,
      axios,
    );

    return {
      tenant,
      config,
      axios,
      kratosFrontend,
      kratosIdentity,
      ketoPermission,
      ketoRelationship,
      hydraOauth2,
    };
  }
}
