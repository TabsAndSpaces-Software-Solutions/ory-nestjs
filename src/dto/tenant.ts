/**
 * Tenant name type.
 *
 * A nominal brand is overkill for v1 — `TenantName` is just a string alias
 * so every DTO can carry a `tenant: TenantName` field and cross-tenant bleed
 * is detectable by inspection.
 */
export type TenantName = string;
