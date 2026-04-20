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
  })
  .strict();

const OathkeeperConfigSchema = z
  .object({
    identityHeader: z.string().default('X-User'),
    signatureHeader: z.string().default('X-User-Signature'),
    signerKeys: z.array(z.string().min(1)).nonempty(),
  })
  .strict();

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
    kratos: KratosConfigSchema,
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
        !t.oathkeeper.signerKeys ||
        t.oathkeeper.signerKeys.length === 0 ||
        !t.oathkeeper.identityHeader ||
        !t.oathkeeper.signatureHeader)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['oathkeeper'],
        message:
          'oathkeeper transport requires oathkeeper.signerKeys[], identityHeader, signatureHeader',
      });
    }
    // Self-hosted mode: admin-requiring ops need `kratos.adminToken`. The
    // schema cannot know which operations the consumer will invoke, so we
    // leave `adminToken` optional but flag the more common mistake: declaring
    // an `adminUrl` (implying admin intent) without a matching token.
    if (
      t.mode === 'self-hosted' &&
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
export type TenantConfigOutput = z.output<typeof TenantConfigSchema>;
