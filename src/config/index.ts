/**
 * Barrel for the ory-nestjs config unit.
 *
 * Public surface (re-exported by src/index.ts):
 *   - `IamOptions`, `TenantConfig`, `TransportKind`, `TenantMode`,
 *     `TenantName` — inferred TypeScript shapes for consumer `forRoot` calls.
 *   - `ConfigLoader` — NestJS service that validates + freezes options.
 *   - `formatZodError` — helper for consumers that want to format their own
 *     zod validation errors consistently with ours.
 *
 * INTENTIONALLY not exported:
 *   - `IamOptionsSchema` — the raw zod schema is internal. Consumers must
 *     go through `ConfigLoader.load()` so defaults, freezing, and error
 *     formatting stay consistent.
 */
export { ConfigLoader } from './config-loader.service';
export { formatZodError } from './format-zod-error';
export type {
  IamOptions,
  ValidatedIamOptions,
  TenantConfig,
  ValidatedTenantConfig,
  TenantMode,
  TransportKind,
} from './config.types';
