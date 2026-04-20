/**
 * Inferred TypeScript types for the ory-nestjs boot configuration.
 *
 * These are the public-facing names consumers see in their NestJS
 * `forRootAsync` factory return types and in the `ConfigLoader.load()` return
 * value. Everything here is a re-export of zod-inferred shapes from
 * `./config.schema`.
 */
import type {
  IamOptionsInput,
  IamOptionsOutput,
  TenantConfigOutput,
} from './config.schema';

/**
 * Top-level options accepted by `IamModule.forRoot` / `forRootAsync`.
 *
 * This is the **input** shape: fields with defaults (e.g. `global`,
 * `kratos.sessionCookieName`, `logging.level`) are optional at the call site.
 */
export type IamOptions = IamOptionsInput;

/**
 * Validated, defaults-applied options as returned by `ConfigLoader.load()`.
 *
 * This is the **output** shape: every field that had a `.default()` is now
 * required. Use this type internally when you want to rely on defaults having
 * been applied.
 */
export type ValidatedIamOptions = IamOptionsOutput;

/**
 * Per-tenant configuration block (output shape, defaults applied).
 */
export type TenantConfig = TenantConfigOutput;

/**
 * Supported tenant deployment modes.
 */
export type TenantMode = 'self-hosted' | 'cloud';

/**
 * Supported session-transport strategies.
 *
 * - `cookie`: read the session cookie only.
 * - `bearer`: read the `Authorization: Bearer <token>` header only.
 * - `cookie-or-bearer`: try cookie first, fall back to bearer.
 * - `oathkeeper`: consume pre-verified headers from Ory Oathkeeper.
 */
export type TransportKind =
  | 'cookie'
  | 'bearer'
  | 'cookie-or-bearer'
  | 'oathkeeper';

// Note: `TenantName` is already exported by `src/dto/tenant.ts` and flows
// through `src/dto` into the package barrel; re-exporting it here would cause
// an ambiguous-re-export TS error. Consumers import it from the main
// `ory-nestjs` barrel, which sources it from dto.
