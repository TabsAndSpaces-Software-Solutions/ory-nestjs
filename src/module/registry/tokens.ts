/**
 * Internal DI token for the `TenantRegistry` provider.
 *
 * The registry resolves tenant names to their `TenantClients` bundle. It is
 * consumed by every internal service, guard, and transport — but the token
 * MUST NEVER be re-exported from `src/index.ts`. Consumers interact with the
 * library only through its public DTOs, services, and `IamModule`.
 *
 * `Symbol.for` is used so the token survives module reloads (e.g. during
 * NestJS hot-reload in tests) without creating distinct identities.
 */
export const TENANT_REGISTRY: unique symbol = Symbol.for(
  'ory-nestjs/tenant-registry',
);
