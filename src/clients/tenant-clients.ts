/**
 * `TenantClients` — the internal per-tenant struct that bundles the shared
 * axios instance plus one API instance per configured Ory product.
 *
 * This struct is the output of `OryClientFactory.build(tenant, deps)` and
 * the input to every internal service in `src/services/`. It is NEVER
 * exposed to consumers: all interaction happens via library-owned DTOs
 * and services.
 *
 * Invariants:
 *   - `kratosFrontend` is always present — every tenant has a public
 *     Kratos URL.
 *   - `kratosIdentity` / `kratosCourier` / `ketoPermission` / `ketoRelationship`
 *     / `hydraOauth2Admin` / `hydraOauth2Public` / `hydraJwk` / `hydraOidc`
 *     / `hydraWellknown` / `hydraMetadata` / `networkProject` /
 *     `networkWorkspace` / `networkEvents` are optional and present iff the
 *     tenant config declares the corresponding product / admin URL /
 *     cloud API key.
 *   - `config` is a direct reference to the frozen `ValidatedTenantConfig` for
 *     audit/debug context. Consumers should not mutate it.
 */
import type { AxiosInstance } from 'axios';
import type {
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

export interface TenantClients {
  tenant: TenantName;
  config: ValidatedTenantConfig;
  axios: AxiosInstance;
  kratosFrontend: FrontendApi;
  kratosIdentity?: IdentityApi;
  kratosCourier?: CourierApi;
  ketoPermission?: PermissionApi;
  ketoRelationship?: RelationshipApi;
  /** OAuth2Api bound to Hydra ADMIN URL (client CRUD, consent, introspect). */
  hydraOauth2?: OAuth2Api;
  /** OAuth2Api bound to Hydra PUBLIC URL (token exchange, revoke). */
  hydraOauth2Public?: OAuth2Api;
  hydraJwk?: JwkApi;
  hydraOidc?: OidcApi;
  hydraWellknown?: WellknownApi;
  hydraMetadata?: MetadataApi;
  /** Ory Network project admin (cloud only). */
  networkProject?: ProjectApi;
  /** Ory Network workspace admin (cloud only). */
  networkWorkspace?: WorkspaceApi;
  /** Ory Network event streams (cloud only). */
  networkEvents?: EventsApi;
}
