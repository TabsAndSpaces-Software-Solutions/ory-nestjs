/**
 * Internal DI tokens for the client layer.
 *
 * These tokens identify per-tenant client structures (`TenantClients`) in a
 * NestJS-backed DI container. They live inside the adapter boundary and
 * MUST NOT be re-exported from `src/index.ts` — consumers should never
 * handle raw `@ory/client` API instances, only the library's services.
 */

/**
 * DI token carrying the `TenantClients` struct for a given tenant. The
 * actual provider wires a map of tenant → `TenantClients`; services
 * resolve the correct tenant at call time.
 *
 * A plain string is used so it can be swapped for a NestJS-compatible
 * token in the module assembly unit without changing callers.
 */
export const TENANT_CLIENTS_TOKEN = 'ORY_NESTJS_TENANT_CLIENTS' as const;
