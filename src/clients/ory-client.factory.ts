/**
 * `OryClientFactory.build(tenant, tenantConfig, deps)` — assembles the
 * full `TenantClients` bundle for a tenant from:
 *   - the shared-per-tenant `AxiosInstance` (caller provides it; see
 *     `AxiosFactory.create`),
 *   - the tenant's validated `ValidatedTenantConfig`,
 *   - product selection (Kratos always; admin/keto/hydra/network by config).
 *
 * Design notes:
 *   - This is the ONLY module that instantiates `@ory/client` classes at
 *     runtime. Mappers import Ory *types* for signatures but never call
 *     constructors. Guard: the ESLint ban allows `@ory/*` inside
 *     `src/clients/**` only.
 *   - Self-hosted: per-product URLs drive `basePath`. Admin APIs carry
 *     `accessToken` from their product's `adminToken` config.
 *   - Cloud: one project URL hosts all APIs. `accessToken` comes from the
 *     cloud API key. Admin APIs are auto-provisioned because Ory Cloud
 *     does not split admin/public across separate URLs.
 *   - Hydra splits into two `OAuth2Api` instances — one bound to `adminUrl`
 *     (client CRUD, consent mediation, introspection) and one bound to
 *     `publicUrl` (token exchange, revocation). The SDK surfaces both sets
 *     of endpoints on the same class, but using the right base URL ensures
 *     requests hit the right port in a deployment that actually splits
 *     admin/public (the common prod shape).
 *   - Kratos Courier API uses the admin URL + admin token.
 *   - Ory Network admin (Project/Workspace/Events) is only wired when the
 *     tenant is in cloud mode and has an API key — it talks to the network
 *     control plane at `https://api.console.ory.sh` which is distinct from
 *     the project data plane.
 */
import type { AxiosInstance } from 'axios';
import {
  Configuration,
  CourierApi,
  EventsApi,
  FrontendApi,
  IdentityApi,
  JwkApi,
  MetadataApi,
  OAuth2Api,
  OidcApi,
  PermissionApi,
  ProjectApi,
  RelationshipApi,
  WellknownApi,
  WorkspaceApi,
} from '@ory/client';

import type { ValidatedTenantConfig } from '../config';
import type { TenantName } from '../dto';
import type { TenantClients } from './tenant-clients';

export interface OryClientFactoryDeps {
  axios: AxiosInstance;
}

/** Ory Network control-plane base URL. */
const NETWORK_CONSOLE_BASE = 'https://api.console.ory.sh';

export class OryClientFactory {
  private constructor() {
    throw new Error(
      'OryClientFactory is a static class and cannot be instantiated.',
    );
  }

  public static build(
    tenant: TenantName,
    config: ValidatedTenantConfig,
    deps: OryClientFactoryDeps,
  ): TenantClients {
    if (config.mode === 'cloud') {
      return OryClientFactory.buildCloud(tenant, config, deps);
    }
    return OryClientFactory.buildSelfHosted(tenant, config, deps);
  }

  private static buildSelfHosted(
    tenant: TenantName,
    config: ValidatedTenantConfig,
    deps: OryClientFactoryDeps,
  ): TenantClients {
    const { axios } = deps;

    const kratosFrontend = new FrontendApi(
      new Configuration({ basePath: config.kratos.publicUrl }),
      config.kratos.publicUrl,
      axios,
    );

    let kratosIdentity: IdentityApi | undefined;
    let kratosCourier: CourierApi | undefined;
    if (config.kratos.adminUrl && config.kratos.adminToken) {
      kratosIdentity = new IdentityApi(
        new Configuration({
          basePath: config.kratos.adminUrl,
          accessToken: config.kratos.adminToken,
        }),
        config.kratos.adminUrl,
        axios,
      );
      kratosCourier = new CourierApi(
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
    let hydraOauth2Public: OAuth2Api | undefined;
    let hydraJwk: JwkApi | undefined;
    let hydraOidc: OidcApi | undefined;
    let hydraWellknown: WellknownApi | undefined;
    let hydraMetadata: MetadataApi | undefined;
    if (config.hydra) {
      hydraOauth2 = new OAuth2Api(
        new Configuration({
          basePath: config.hydra.adminUrl,
          accessToken: config.hydra.adminToken,
        }),
        config.hydra.adminUrl,
        axios,
      );
      hydraOauth2Public = new OAuth2Api(
        new Configuration({ basePath: config.hydra.publicUrl }),
        config.hydra.publicUrl,
        axios,
      );
      hydraJwk = new JwkApi(
        new Configuration({
          basePath: config.hydra.adminUrl,
          accessToken: config.hydra.adminToken,
        }),
        config.hydra.adminUrl,
        axios,
      );
      hydraOidc = new OidcApi(
        new Configuration({ basePath: config.hydra.publicUrl }),
        config.hydra.publicUrl,
        axios,
      );
      hydraWellknown = new WellknownApi(
        new Configuration({ basePath: config.hydra.publicUrl }),
        config.hydra.publicUrl,
        axios,
      );
      hydraMetadata = new MetadataApi(
        new Configuration({ basePath: config.hydra.adminUrl }),
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
      kratosCourier,
      ketoPermission,
      ketoRelationship,
      hydraOauth2,
      hydraOauth2Public,
      hydraJwk,
      hydraOidc,
      hydraWellknown,
      hydraMetadata,
    };
  }

  private static buildCloud(
    tenant: TenantName,
    config: ValidatedTenantConfig,
    deps: OryClientFactoryDeps,
  ): TenantClients {
    const { axios } = deps;
    // Schema already guarantees config.cloud is present in cloud mode.
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
    const kratosCourier = new CourierApi(
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
    const hydraOauth2Public = new OAuth2Api(
      new Configuration({ basePath }),
      basePath,
      axios,
    );
    const hydraJwk = new JwkApi(
      new Configuration({ basePath, accessToken }),
      basePath,
      axios,
    );
    const hydraOidc = new OidcApi(
      new Configuration({ basePath }),
      basePath,
      axios,
    );
    const hydraWellknown = new WellknownApi(
      new Configuration({ basePath }),
      basePath,
      axios,
    );
    const hydraMetadata = new MetadataApi(
      new Configuration({ basePath }),
      basePath,
      axios,
    );

    // Ory Network control plane: only usable when a separate
    // `cloud.workspaceApiKey` is provided. The workspace key is a different
    // credential from `cloud.apiKey` (project key); absent it, Network admin
    // calls will 401 and we don't even instantiate the clients.
    let networkProject: ProjectApi | undefined;
    let networkWorkspace: WorkspaceApi | undefined;
    let networkEvents: EventsApi | undefined;
    const workspaceKey = cloud.workspaceApiKey ?? cloud.apiKey;
    if (workspaceKey) {
      networkProject = new ProjectApi(
        new Configuration({
          basePath: NETWORK_CONSOLE_BASE,
          accessToken: workspaceKey,
        }),
        NETWORK_CONSOLE_BASE,
        axios,
      );
      networkWorkspace = new WorkspaceApi(
        new Configuration({
          basePath: NETWORK_CONSOLE_BASE,
          accessToken: workspaceKey,
        }),
        NETWORK_CONSOLE_BASE,
        axios,
      );
      networkEvents = new EventsApi(
        new Configuration({
          basePath: NETWORK_CONSOLE_BASE,
          accessToken: workspaceKey,
        }),
        NETWORK_CONSOLE_BASE,
        axios,
      );
    }

    return {
      tenant,
      config,
      axios,
      kratosFrontend,
      kratosIdentity,
      kratosCourier,
      ketoPermission,
      ketoRelationship,
      hydraOauth2,
      hydraOauth2Public,
      hydraJwk,
      hydraOidc,
      hydraWellknown,
      hydraMetadata,
      networkProject,
      networkWorkspace,
      networkEvents,
    };
  }
}
