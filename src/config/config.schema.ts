/**
 * Zod schemas for the `IamOptions` boot configuration.
 *
 * Design notes:
 *   - Every object is `.strict()` so unknown keys are rejected at the boundary.
 *     The library cannot silently ignore a typo in a deployment config.
 *   - Cross-field rules that span sub-objects live in `superRefine` blocks so
 *     the issue's `path` can point at the offending field, not the root.
 *   - `process.env.NODE_ENV` is read lazily inside `superRefine`, never
 *     captured at module-evaluation time. This lets tests flip it per-case.
 *   - This module is package-private. Consumers receive the inferred TypeScript
 *     types from `./config.types` and the `ConfigLoader` service, never the
 *     schema itself.
 */
import { z } from 'zod';

const KratosConfigSchema = z
  .object({
    publicUrl: z.url(),
    adminUrl: z.url().optional(),
    adminToken: z.string().min(1).optional(),
    sessionCookieName: z.string().default('ory_kratos_session'),
  })
  .strict();

const KetoConfigSchema = z
  .object({
    readUrl: z.url(),
    writeUrl: z.url(),
    apiKey: z.string().min(1).optional(),
  })
  .strict();

const HydraConfigSchema = z
  .object({
    publicUrl: z.url(),
    adminUrl: z.url(),
    adminToken: z.string().min(1).optional(),
    clientId: z.string().min(1).optional(),
    clientSecret: z.string().min(1).optional(),
  })
  .strict();

const CloudConfigSchema = z
  .object({
    projectSlug: z.string().min(1),
    apiKey: z.string().min(1),
    /**
     * Workspace-scoped API key for Ory Network control-plane operations
     * (Project/Workspace/Events APIs at api.console.ory.sh). Distinct from
     * `apiKey` (which is scoped to a single project's data plane). Optional:
     * when absent, network-admin services fall back to `apiKey` or throw
     * `IamConfigurationError` if the operation requires workspace scope.
     */
    workspaceApiKey: z.string().min(1).optional(),
  })
  .strict();

const OathkeeperJwksSchema = z
  .object({
    // Exactly one of `url` or `keys` must be supplied. Guard in superRefine.
    url: z.url().optional(),
    keys: z.array(z.record(z.string(), z.unknown())).optional(),
    algorithms: z.array(z.string().min(1)).nonempty().default(['RS256', 'ES256']),
    refreshIntervalMs: z.number().int().positive().default(600_000),
    // How long to cache the fetched JWKS before forcing a refresh on verify
    // failure. Independent of the periodic refresh above.
    cooldownMs: z.number().int().nonnegative().default(30_000),
  })
  .strict()
  .superRefine((j, ctx) => {
    const hasUrl = typeof j.url === 'string' && j.url.length > 0;
    const hasKeys = Array.isArray(j.keys) && j.keys.length > 0;
    if (hasUrl === hasKeys) {
      ctx.addIssue({
        code: 'custom',
        path: [],
        message: 'oathkeeper.jwks requires exactly one of url or keys',
      });
    }
  });

const OathkeeperReplayProtectionSchema = z
  .object({
    enabled: z.boolean().default(false),
    // Max age of a remembered jti. Should be ≥ envelope TTL so you can't
    // replay within the expiry window.
    ttlMs: z.number().int().positive().default(600_000),
  })
  .strict();

const OathkeeperConfigSchema = z
  .object({
    identityHeader: z.string().default('X-User'),
    signatureHeader: z.string().default('X-User-Signature'),

    // Verifier discriminator. Default 'hmac' preserves the pre-0.3.0
    // behaviour. Switch to 'jwt' to use asymmetric JWT verification
    // (Oathkeeper `id_token` mutator + JWKS).
    verifier: z.enum(['hmac', 'jwt']).default('hmac'),

    // HMAC mode: symmetric keys. Required when verifier === 'hmac'.
    signerKeys: z.array(z.string().min(1)).nonempty().optional(),

    // JWT mode: JWKS config. Required when verifier === 'jwt'.
    jwks: OathkeeperJwksSchema.optional(),

    // Shared, enforced across both verifier modes.
    //   - `audience` — if set, the envelope MUST declare a matching
    //     `audience` / `aud` claim. String or array of strings (first match
    //     wins). Guards against cross-service replay when multiple services
    //     share a signer.
    //   - `clockSkewMs` — leeway applied to expiry checks.
    //   - `replayProtection` — enforce one-time use via the `jti` claim.
    audience: z.union([z.string().min(1), z.array(z.string().min(1)).nonempty()]).optional(),
    clockSkewMs: z.number().int().nonnegative().default(30_000),
    replayProtection: OathkeeperReplayProtectionSchema.optional(),
  })
  .strict()
  .superRefine((o, ctx) => {
    if (o.verifier === 'hmac' && (!o.signerKeys || o.signerKeys.length === 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['signerKeys'],
        message: 'oathkeeper.verifier=hmac requires signerKeys[] (non-empty)',
      });
    }
    if (o.verifier === 'jwt' && !o.jwks) {
      ctx.addIssue({
        code: 'custom',
        path: ['jwks'],
        message:
          'oathkeeper.verifier=jwt requires oathkeeper.jwks (url or inline keys)',
      });
    }
  });

const LoggingConfigSchema = z
  .object({
    level: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  })
  .strict();

const CacheConfigSchema = z
  .object({
    sessionTtlMs: z.number().int().nonnegative().default(0),
    permissionTtlMs: z.number().int().nonnegative().default(0),
    jwksTtlMs: z.number().int().nonnegative().default(0),
  })
  .strict();

const TenantConfigSchema = z
  .object({
    mode: z.enum(['self-hosted', 'cloud']),
    transport: z.enum(['cookie', 'bearer', 'cookie-or-bearer', 'oathkeeper']),
    // `kratos` is required for `mode: 'self-hosted'` and optional for
    // `mode: 'cloud'` — Ory Cloud exposes a single project URL derived
    // from `cloud.projectSlug`, so the library can synthesize a Kratos
    // block for cloud tenants. Cloud consumers may still provide a
    // partial `kratos` block to override the derived URL or to set a
    // project-specific `sessionCookieName`. The mode/presence contract
    // is enforced below in `superRefine`, and a normalized `kratos`
    // block is guaranteed by `transform` on the way out.
    kratos: KratosConfigSchema.optional(),
    keto: KetoConfigSchema.optional(),
    hydra: HydraConfigSchema.optional(),
    cloud: CloudConfigSchema.optional(),
    oathkeeper: OathkeeperConfigSchema.optional(),
    logging: LoggingConfigSchema.optional(),
    cache: CacheConfigSchema.optional(),
    trustProxy: z.boolean().optional(),
  })
  .strict()
  .superRefine((t, ctx) => {
    // Self-hosted mode: a `kratos` block with `publicUrl` is required —
    // there's no projectSlug to derive it from. (Zod already validates
    // `publicUrl` inside `KratosConfigSchema` when the block is present.)
    if (t.mode === 'self-hosted' && !t.kratos) {
      ctx.addIssue({
        code: 'custom',
        path: ['kratos'],
        message:
          'self-hosted mode requires a kratos block with at least publicUrl',
      });
    }
    if (
      t.mode === 'cloud' &&
      (!t.cloud || !t.cloud.projectSlug || !t.cloud.apiKey)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['cloud'],
        message: 'cloud mode requires cloud.projectSlug and cloud.apiKey',
      });
    }
    if (
      t.transport === 'oathkeeper' &&
      (!t.oathkeeper ||
        !t.oathkeeper.identityHeader ||
        !t.oathkeeper.signatureHeader)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['oathkeeper'],
        message:
          'oathkeeper transport requires oathkeeper config (identityHeader, signatureHeader, + verifier-specific keys)',
      });
    }
    // Self-hosted mode: admin-requiring ops need `kratos.adminToken`. The
    // schema cannot know which operations the consumer will invoke, so we
    // leave `adminToken` optional but flag the more common mistake: declaring
    // an `adminUrl` (implying admin intent) without a matching token.
    if (
      t.mode === 'self-hosted' &&
      t.kratos !== undefined &&
      t.kratos.adminUrl !== undefined &&
      t.kratos.adminToken === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['kratos', 'adminToken'],
        message:
          'self-hosted mode with kratos.adminUrl requires kratos.adminToken',
      });
    }
    // Cookie transports in production must either trust the proxy chain or
    // declare an explicit `cookie` domain config. The latter is not yet
    // modelled in the schema, so we enforce `trustProxy: true` explicitly.
    if (
      process.env.NODE_ENV === 'production' &&
      (t.transport === 'cookie' || t.transport === 'cookie-or-bearer') &&
      t.trustProxy !== true
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['trustProxy'],
        message: 'cookie transport in production requires trustProxy: true',
      });
    }
  })
  .transform((t) => {
    // Normalize `kratos` so every downstream consumer (transports, client
    // factory, health indicator) can read `tenant.kratos.*` uniformly
    // regardless of `mode`.
    //
    //   - Cloud:       synthesize `kratos` from `cloud.projectSlug` +
    //                  `cloud.apiKey`. Consumer-supplied overrides win.
    //   - Self-hosted: the `kratos` block was required by `superRefine`,
    //                  so we re-assert its presence here to give the output
    //                  type a non-optional `kratos` field.
    //
    // `sessionCookieName` is NOT auto-derived: Ory Cloud's session cookie
    // is named with a project-specific random slug (visible in the Ory
    // Console, not the same as `cloud.projectSlug`), so any consumer using
    // the `cookie` or `cookie-or-bearer` transport with Ory Cloud MUST
    // supply `kratos.sessionCookieName` explicitly. The
    // `ory_kratos_session` default stays as a last-resort fallback.
    if (t.mode === 'cloud' && t.cloud) {
      const slug = t.cloud.projectSlug;
      const derivedUrl = `https://${slug}.projects.oryapis.com`;
      return {
        ...t,
        kratos: {
          publicUrl: t.kratos?.publicUrl ?? derivedUrl,
          adminUrl: t.kratos?.adminUrl ?? derivedUrl,
          adminToken: t.kratos?.adminToken ?? t.cloud.apiKey,
          sessionCookieName:
            t.kratos?.sessionCookieName ?? 'ory_kratos_session',
        },
      };
    }
    // superRefine guarantees `kratos` is present for self-hosted mode;
    // the non-null assertion keeps the output type uniform.
    return { ...t, kratos: t.kratos! };
  });

export const IamOptionsSchema = z
  .object({
    tenants: z.record(z.string().min(1), TenantConfigSchema),
    defaultTenant: z.string().optional(),
    global: z.boolean().default(true),
    // `auditSink` is a NestJS `Provider<AuditSink>` — that shape cannot be
    // expressed in zod, so we accept `unknown` here and re-validate at module
    // assembly time in the IamModule layer.
    auditSink: z.unknown().optional(),
    // `sessionCache` may be a SessionCache instance, a class constructor,
    // or a NestJS Provider<SessionCache>. Re-validated at module-assembly
    // time for the same reason as `auditSink`.
    sessionCache: z.unknown().optional(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const tenantKeys = Object.keys(cfg.tenants);
    if (tenantKeys.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['tenants'],
        message: 'tenants must declare at least one entry',
      });
      return;
    }
    if (cfg.defaultTenant !== undefined && !(cfg.defaultTenant in cfg.tenants)) {
      ctx.addIssue({
        code: 'custom',
        path: ['defaultTenant'],
        message: `tenant '${cfg.defaultTenant}' not in tenants`,
      });
    }
    if (cfg.defaultTenant === undefined && tenantKeys.length > 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['defaultTenant'],
        message: 'multiple tenants require an explicit defaultTenant',
      });
    }
  });

// Schema is intentionally NOT re-exported from the package barrel. Consumers
// only need the inferred types and the `ConfigLoader` service.
export type IamOptionsInput = z.input<typeof IamOptionsSchema>;
export type IamOptionsOutput = z.output<typeof IamOptionsSchema>;
export type TenantConfigInput = z.input<typeof TenantConfigSchema>;
export type TenantConfigOutput = z.output<typeof TenantConfigSchema>;
