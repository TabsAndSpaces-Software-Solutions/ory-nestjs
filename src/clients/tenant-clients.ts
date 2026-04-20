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
 *   - `kratosIdentity` / `ketoPermission` / `ketoRelationship` / `hydraOauth2`
 *     are optional and present iff the tenant config declares the
 *     corresponding product / admin URL / cloud API key.
 *   - `config` is a direct reference to the frozen `TenantConfig` for
 *     audit/debug context. Consumers should not mutate it.
 */
import type { AxiosInstance } from 'axios';
import type {
  FrontendApi,
  IdentityApi,
  OAuth2Api,
  PermissionApi,
  RelationshipApi,
} from '@ory/client';

import type { TenantConfig } from '../config';
import type { TenantName } from '../dto';

export interface TenantClients {
  tenant: TenantName;
  config: TenantConfig;
  axios: AxiosInstance;
  kratosFrontend: FrontendApi;
  kratosIdentity?: IdentityApi;
  ketoPermission?: PermissionApi;
  ketoRelationship?: RelationshipApi;
  hydraOauth2?: OAuth2Api;
}
