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
  TenantConfigInput,
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
 * Per-tenant configuration block — **input** shape.
 *
 * This is what consumers write inside `tenants: { default: { … } }` when
 * calling `IamModule.forRoot(...)`. Fields with zod-level defaults
 * (`kratos.sessionCookieName`, `oathkeeper.clockSkewMs`, etc.) are
 * optional at the call site. Consumers who factor a tenant out into a
 * shared helper should annotate the helper's return type with this,
 * not `ValidatedTenantConfig` — the latter requires every default to be
 * present in the literal.
 *
 * Breaking change in 0.4.0: before 0.4.0, this alias pointed at the
 * post-validation (output) shape, which forced every consumer factory
 * to redundantly supply defaulted fields. The two shapes are now
 * exported under distinct names so the call-site type reflects the
 * call-site ergonomics.
 */
export type TenantConfig = TenantConfigInput;

/**
 * Per-tenant configuration block — **validated output** shape, with all
 * defaults applied. This is what `ConfigLoader.load()` returns and what
 * the library's internals (transports, factory, health indicator) read.
 * Consumers rarely need this directly; use it only when writing code
 * that relies on defaulted fields being present.
 */
export type ValidatedTenantConfig = TenantConfigOutput;

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
