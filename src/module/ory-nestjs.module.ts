/**
 * `IamModule` — the DynamicModule consumers register in their
 * `AppModule` to wire the full IAM stack into a NestJS application.
 *
 * Design notes:
 *
 * 1. Two entry points:
 *      - `forRoot(options)`: synchronous registration. Validates the options
 *        eagerly via `ConfigLoader.load`, so boot fails fast with an
 *        `IamConfigurationError` if the options are malformed.
 *      - `forRootAsync(options)`: asynchronous registration (useFactory /
 *        useClass / useExisting). The raw factory output is resolved
 *        asynchronously but validated synchronously inside the validated-
 *        options provider's factory — Nest surfaces the thrown error during
 *        module initialization.
 *
 * 2. Consumer-visible wiring:
 *      - All guards (`SessionGuard`, `OptionalSessionGuard`, `RoleGuard`,
 *        `PermissionGuard`, `OAuth2Guard`).
 *      - All services (`IdentityService`, `SessionService`,
 *        `PermissionService`, `TokenService`, `FlowService`).
 *      - `IamHealthIndicator`.
 *      - `AUDIT_SINK` — consumer-provided `Provider` wins; otherwise a
 *        `LoggerAuditSink` default is installed.
 *
 * 3. APP_GUARD (controlled by `options.global`):
 *      - When `options.global !== false` (the default), we bind `APP_GUARD`
 *        to `SessionGuard` so every controller route is authenticated
 *        unless it carries `@Public()` / `@Anonymous()`.
 *      - When `options.global: false`, NO `APP_GUARD` is registered —
 *        consumers opt in per-route via their own `@UseGuards(SessionGuard)`.
 *      - IMPORTANT: `options.global` ONLY controls the APP_GUARD binding.
 *        It does NOT control NestJS module visibility. See (4).
 *
 * 4. Module visibility (`@Global()` / DynamicModule `global`):
 *      - The DynamicModule is ALWAYS returned with `global: true` regardless
 *        of `options.global`. Guards/services/tokens inside this module
 *        (notably `SessionGuard` and its internal `TENANT_REGISTRY`
 *        dependency) must be reachable via DI from anywhere in the host
 *        app so that consumer-side `@UseGuards(SessionGuard)` — and any
 *        direct `@Inject(SessionService)` etc. — continues to work even
 *        when the APP_GUARD is disabled.
 *
 * 5. Internal tokens (`TENANT_REGISTRY`, raw/validated option symbols,
 *    tenant-clients builder) are intentionally NOT re-exported from the
 *    module barrel — they remain internal to the library.
 *
 * 6. Zero-Ory-leakage: `@ory/*` is not imported here. Tenant client
 *    construction delegates to `OryClientFactory` (from `src/clients`),
 *    which is the single file allowed to instantiate Ory SDK classes.
 */
import {
  DynamicModule,
  InjectionToken,
  Logger,
  Module,
  OnApplicationBootstrap,
  OptionalFactoryDependency,
  Provider,
  Type,
} from '@nestjs/common';
import { APP_GUARD, DiscoveryModule, Reflector } from '@nestjs/core';

import {
  AUDIT_SINK,
  LoggerAuditSink,
  Redactor,
} from '../audit';
import {
  InMemoryReplayCache,
  NoopSessionCache,
  REPLAY_CACHE,
  SESSION_CACHE,
  type ReplayCache,
  type SessionCache,
} from '../cache';
import {
  AxiosFactory,
  OryClientFactory,
  type TenantClients,
} from '../clients';
import {
  ConfigLoader,
  type ValidatedTenantConfig,
  type IamOptions,
  type ValidatedIamOptions,
} from '../config';
import type { TenantName } from '../dto';
import { IamConfigurationError } from '../errors';
import {
  OAuth2Guard,
  OptionalSessionGuard,
  PermissionGuard,
  RoleGuard,
  SessionGuard,
} from '../guards';
import { IamHealthIndicator } from '../health';
import {
  ConsentService,
  CourierService,
  EventsService,
  FlowService,
  IdentityService,
  JwkService,
  MetadataService,
  OAuth2ClientService,
  PermissionService,
  ProjectAdminService,
  SchemaService,
  SessionService,
  TokenService,
  TrustedIssuerService,
  WorkspaceAdminService,
} from '../services';
import { TransportFactory } from '../transport/transport.factory';

import { PublicRoutesWarner } from './public-routes-warner';
import { TenantRegistry } from './registry/tenant-registry.service';
import { TENANT_REGISTRY } from './registry/tokens';
import type {
  IamAsyncOptions,
  IamOptionsFactory,
} from './ory-nestjs-options.interface';

/**
 * Internal DI tokens for plumbing async option resolution + tenant-clients
 * builder through the Nest injector. `Symbol.for` so identity survives
 * module reloads (e.g. in jest / watch mode).
 *
 * These tokens are NOT exported from the module barrel — consumers never
 * touch them.
 */
const IAM_OPTIONS_RAW: unique symbol = Symbol.for('ory-nestjs/options-raw');
const IAM_OPTIONS_VALIDATED: unique symbol = Symbol.for(
  'ory-nestjs/options-validated',
);
const TENANT_CLIENTS_BUILDER: unique symbol = Symbol.for(
  'ory-nestjs/tenant-clients-builder',
);

type TenantClientsBuilderFn = (
  name: TenantName,
  cfg: ValidatedTenantConfig,
) => TenantClients;

/**
 * Structural check: a `Provider` is either a class (constructor) or an
 * object carrying `provide`. This guard is used to tell apart consumer-
 * supplied `auditSink` providers from arbitrary garbage.
 */
function isProvider(candidate: unknown): candidate is Provider {
  if (typeof candidate === 'function') return true;
  if (
    candidate !== null &&
    typeof candidate === 'object' &&
    'provide' in (candidate as object)
  ) {
    return true;
  }
  return false;
}

@Module({})
export class IamModule {
  /**
   * Synchronous registration. Validates `options` eagerly; throws
   * `IamConfigurationError` if they are malformed.
   */
  public static forRoot(options: IamOptions): DynamicModule {
    // Validate synchronously so boot fails fast at the call site.
    let validated: ValidatedIamOptions;
    try {
      validated = new ConfigLoader().load(options);
    } catch (err) {
      IamModule.logBootFailure(err);
      throw err;
    }

    // `options.global` is an APP_GUARD toggle (see class JSDoc, section 3).
    // It does NOT change NestJS module visibility — the DynamicModule is
    // always `global: true` so SessionGuard and its transitive
    // dependencies (TENANT_REGISTRY, AUDIT_SINK) remain reachable via DI
    // anywhere the consumer uses `@UseGuards(SessionGuard)`.
    const registerAppGuard = options.global !== false;
    const consumerSink = IamModule.resolveConsumerSink(options.auditSink);
    const cacheProvider = IamModule.resolveSessionCacheProvider(
      options.sessionCache,
      validated,
    );

    const validatedProvider: Provider = {
      provide: IAM_OPTIONS_VALIDATED,
      useValue: validated,
    };

    return {
      module: IamModule,
      global: true,
      imports: [DiscoveryModule],
      providers: [
        validatedProvider,
        cacheProvider,
        IamModule.buildReplayCacheProvider(validated),
        ...IamModule.coreProviders(registerAppGuard, consumerSink),
      ],
      exports: IamModule.coreExports(),
    };
  }

  /**
   * Async registration. The factory's return value is validated lazily
   * inside the `IAM_OPTIONS_VALIDATED` provider's factory — a malformed
   * config surfaces as an `IamConfigurationError` during Nest module
   * initialization.
   */
  public static forRootAsync(options: IamAsyncOptions): DynamicModule {
    if (
      options.useFactory === undefined &&
      options.useClass === undefined &&
      options.useExisting === undefined
    ) {
      throw new IamConfigurationError({
        message:
          'IamModule.forRootAsync requires exactly one of useFactory / useClass / useExisting.',
      });
    }

    // At module-assembly time the raw options aren't in hand yet, so we
    // can't inspect `options.global`. The async path therefore defaults to
    // the "secure by default" stance of `forRoot` — APP_GUARD is
    // registered. Consumers who need to disable the global guard should
    // use `forRoot({ ..., global: false })` (or override APP_GUARD in a
    // downstream module).
    const asyncProviders = IamModule.buildAsyncRawProviders(options);

    const validatedProvider: Provider = {
      provide: IAM_OPTIONS_VALIDATED,
      useFactory: (raw: IamOptions) => {
        try {
          return new ConfigLoader().load(raw);
        } catch (err) {
          IamModule.logBootFailure(err);
          throw err;
        }
      },
      inject: [IAM_OPTIONS_RAW],
    };

    // For async the sink is always the default LoggerAuditSink because the
    // raw options aren't in hand at module-assembly time. Consumers wanting
    // a custom sink in the async path can override the AUDIT_SINK provider
    // in their own module. Reading `auditSink` off the resolved raw options
    // would require another layer of indirection for little gain.
    //
    // Same applies to `sessionCache`: the async path installs a
    // `NoopSessionCache` default. Consumers wiring a Redis backend must
    // override the `SESSION_CACHE` token in their own module (e.g. via
    // `{ provide: SESSION_CACHE, useClass: MyRedisSessionCache }`). The
    // boot-time "ttl > 0 requires a backend" check is deferred to the
    // `SESSION_CACHE` provider's factory, so a misconfigured deployment
    // still fails loudly at module initialization — the check reads the
    // validated options that were resolved by the factory pipeline.

    const defaultCacheProvider: Provider = {
      provide: SESSION_CACHE,
      useFactory: (validated: ValidatedIamOptions): SessionCache => {
        IamModule.assertNoSessionCacheRequired(validated);
        return new NoopSessionCache();
      },
      inject: [IAM_OPTIONS_VALIDATED],
    };

    const replayCacheProvider: Provider = {
      provide: REPLAY_CACHE,
      useFactory: (validated: ValidatedIamOptions): ReplayCache | undefined =>
        IamModule.buildReplayCacheInstance(validated),
      inject: [IAM_OPTIONS_VALIDATED],
    };

    return {
      module: IamModule,
      // Always globally visible — see class JSDoc, section 4.
      global: true,
      imports: [DiscoveryModule, ...(options.imports ?? [])],
      providers: [
        ...asyncProviders,
        validatedProvider,
        defaultCacheProvider,
        replayCacheProvider,
        ...IamModule.coreProviders(true, undefined),
      ],
      exports: IamModule.coreExports(),
    };
  }

  /**
   * Translate consumer input (undefined | Provider | ctor | instance) into
   * a Provider bound to `SESSION_CACHE`. When the consumer omits a backend
   * we install a `NoopSessionCache` default — but we refuse to boot if
   * `cache.sessionTtlMs > 0` is configured for any tenant (silent
   * in-memory caching would be a correctness footgun for multi-pod
   * deployments).
   */
  private static resolveSessionCacheProvider(
    raw: unknown,
    validated: ValidatedIamOptions,
  ): Provider {
    if (raw === undefined || raw === null) {
      IamModule.assertNoSessionCacheRequired(validated);
      return {
        provide: SESSION_CACHE,
        useValue: new NoopSessionCache(),
      };
    }
    // Consumer supplied an instance (duck-typed: implements the cache shape)?
    if (
      typeof raw === 'object' &&
      raw !== null &&
      typeof (raw as SessionCache).get === 'function' &&
      typeof (raw as SessionCache).set === 'function' &&
      typeof (raw as SessionCache).delete === 'function' &&
      typeof (raw as SessionCache).deleteBySessionId === 'function'
    ) {
      return {
        provide: SESSION_CACHE,
        useValue: raw as SessionCache,
      };
    }
    if (typeof raw === 'function') {
      return { provide: SESSION_CACHE, useClass: raw as Type<SessionCache> };
    }
    if (isProvider(raw)) {
      return raw;
    }
    throw new IamConfigurationError({
      message:
        'options.sessionCache must be a SessionCache instance, a class constructor, or a NestJS Provider.',
    });
  }

  /**
   * Build a `REPLAY_CACHE` provider tied to the sync `forRoot` path. When
   * at least one tenant enables `oathkeeper.replayProtection`, install an
   * `InMemoryReplayCache` by default — consumers wanting multi-pod
   * guarantees override the `REPLAY_CACHE` token with a Redis-backed
   * implementation in their own module.
   */
  private static buildReplayCacheProvider(
    validated: ValidatedIamOptions,
  ): Provider {
    return {
      provide: REPLAY_CACHE,
      useValue: IamModule.buildReplayCacheInstance(validated),
    };
  }

  /**
   * Produces the actual `ReplayCache` instance — or `undefined` when no
   * tenant opts in. `undefined` is a legitimate value for an `@Optional()`
   * DI dependency; the transport falls closed if a tenant has
   * `replayProtection.enabled: true` and the binding resolves to
   * `undefined`, which surfaces as a 401 rather than silently disabling
   * protection.
   */
  private static buildReplayCacheInstance(
    validated: ValidatedIamOptions,
  ): ReplayCache | undefined {
    for (const tenant of Object.values(validated.tenants)) {
      if (tenant.oathkeeper?.replayProtection?.enabled === true) {
        return new InMemoryReplayCache();
      }
    }
    return undefined;
  }

  /**
   * Guard: if any tenant declares `cache.sessionTtlMs > 0`, the consumer
   * must supply a `sessionCache` backend. Silent in-memory fallback would
   * serve stale sessions across pods and mask revocation — better to fail
   * at boot.
   */
  private static assertNoSessionCacheRequired(
    validated: ValidatedIamOptions,
  ): void {
    const tenantsWithCaching: string[] = [];
    for (const [name, tenant] of Object.entries(validated.tenants)) {
      const ttl = tenant.cache?.sessionTtlMs ?? 0;
      if (ttl > 0) tenantsWithCaching.push(name);
    }
    if (tenantsWithCaching.length === 0) return;
    throw new IamConfigurationError({
      message:
        `cache.sessionTtlMs > 0 is set for tenant(s) [${tenantsWithCaching.join(', ')}] ` +
        `but no sessionCache backend was provided. ` +
        `Pass a SessionCache implementation via IamModule.forRoot({ sessionCache }) ` +
        `or override the SESSION_CACHE provider in your module. ` +
        `Use InMemorySessionCache only for single-process deployments.`,
    });
  }

  /**
   * Translate consumer input (undefined | Provider | ctor) into a Provider
   * bound to `AUDIT_SINK`, or undefined when the consumer didn't supply
   * one (in which case the default sink provider is used).
   */
  private static resolveConsumerSink(
    raw: unknown,
  ): Provider | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw === 'function') {
      // A bare class — treat as useClass binding.
      return { provide: AUDIT_SINK, useClass: raw as Type<unknown> };
    }
    if (isProvider(raw)) {
      // Already a Provider object. If it doesn't target AUDIT_SINK we still
      // forward it as-is — that's the consumer's explicit choice.
      return raw;
    }
    // Unknown shape: ignore to avoid silently hiding a misconfig. The zod
    // schema accepts `unknown` so there's no earlier gate.
    throw new IamConfigurationError({
      message:
        'options.auditSink must be a NestJS Provider or a class constructor.',
    });
  }

  /**
   * Build the raw-options provider set for async registration: exactly one
   * of useFactory / useClass / useExisting resolves to `IAM_OPTIONS_RAW`.
   */
  private static buildAsyncRawProviders(
    options: IamAsyncOptions,
  ): Provider[] {
    if (options.useFactory !== undefined) {
      const inject: Array<InjectionToken | OptionalFactoryDependency> = [
        ...(options.inject ?? []),
      ];
      return [
        {
          provide: IAM_OPTIONS_RAW,
          useFactory: options.useFactory,
          inject,
        },
      ];
    }
    if (options.useClass !== undefined) {
      return [
        options.useClass,
        {
          provide: IAM_OPTIONS_RAW,
          useFactory: async (factory: IamOptionsFactory) =>
            factory.createIamOptions(),
          inject: [options.useClass],
        },
      ];
    }
    // useExisting branch (guarded at the entry point).
    return [
      {
        provide: IAM_OPTIONS_RAW,
        useFactory: async (factory: IamOptionsFactory) =>
          factory.createIamOptions(),
        inject: [options.useExisting as Type<IamOptionsFactory>],
      },
    ];
  }

  /**
   * The shared set of providers installed regardless of sync vs async
   * registration. `IAM_OPTIONS_VALIDATED` is expected to be provided by
   * the caller of this helper.
   *
   * `registerAppGuard` reflects `options.global !== false`: it only
   * controls whether `APP_GUARD = SessionGuard` is appended to the
   * provider list. The DynamicModule-level `global` visibility flag is
   * orthogonal and always `true` (set at the call sites).
   */
  private static coreProviders(
    registerAppGuard: boolean,
    consumerSink: Provider | undefined,
  ): Provider[] {
    const providers: Provider[] = [
      // Nest injects Reflector for us, but register explicitly so the module
      // is self-contained when imported elsewhere.
      Reflector,

      // Redactor singleton — feeds LoggerAuditSink + axios factory.
      { provide: Redactor, useClass: Redactor },

      // AuditSink: consumer-provided Provider wins; default is
      // LoggerAuditSink backed by the shared Redactor.
      consumerSink ?? {
        provide: AUDIT_SINK,
        useFactory: (redactor: Redactor) => new LoggerAuditSink(redactor),
        inject: [Redactor],
      },

      // Tenant-clients builder closure, consumed by the TenantRegistry.
      {
        provide: TENANT_CLIENTS_BUILDER,
        useFactory: (redactor: Redactor): TenantClientsBuilderFn => {
          return (name: TenantName, cfg: ValidatedTenantConfig): TenantClients => {
            const axios = AxiosFactory.create(cfg, { redactor });
            return OryClientFactory.build(name, cfg, { axios });
          };
        },
        inject: [Redactor],
      },

      // TenantRegistry — one per module.
      {
        provide: TENANT_REGISTRY,
        useFactory: (
          opts: ValidatedIamOptions,
          builder: TenantClientsBuilderFn,
        ) => new TenantRegistry(opts, builder),
        inject: [IAM_OPTIONS_VALIDATED, TENANT_CLIENTS_BUILDER],
      },

      // Transport factory — picks the right SessionTransport per tenant and
      // wraps it in a CachingSessionTransport when the SESSION_CACHE backend
      // is registered and the tenant has a positive sessionTtlMs.
      TransportFactory,

      // Guards.
      SessionGuard,
      OptionalSessionGuard,
      RoleGuard,
      PermissionGuard,
      OAuth2Guard,

      // Services.
      IdentityService,
      SessionService,
      PermissionService,
      TokenService,
      FlowService,
      SchemaService,
      CourierService,
      OAuth2ClientService,
      ConsentService,
      JwkService,
      TrustedIssuerService,
      ProjectAdminService,
      WorkspaceAdminService,
      EventsService,
      MetadataService,

      // Health indicator.
      IamHealthIndicator,
    ];

    // Non-production boot warning for @Public() routes.
    if (process.env.NODE_ENV !== 'production') {
      providers.push(PublicRoutesWarner);
    }

    // Global guards — only when `options.global !== false`. Module-level
    // visibility is handled separately (see forRoot/forRootAsync).
    //
    // Order matters. NestJS runs APP_GUARDs in the order they are declared
    // within a module, so SessionGuard runs first and populates `req.user`
    // before RoleGuard / PermissionGuard inspect it. RoleGuard and
    // PermissionGuard each short-circuit when the route carries no
    // corresponding metadata, making the full chain safe to register
    // globally even for routes that don't opt in to role/permission checks.
    if (registerAppGuard) {
      providers.push(
        { provide: APP_GUARD, useExisting: SessionGuard },
        { provide: APP_GUARD, useExisting: RoleGuard },
        { provide: APP_GUARD, useExisting: PermissionGuard },
      );
    }

    return providers;
  }

  /**
   * Exports visible to importing modules: guards, services, health
   * indicator, plus the internal tokens that are transitive dependencies
   * of exported guards.
   *
   * Why `TENANT_REGISTRY` is exported even though it is "internal":
   *   - NestJS instantiates class-form `@UseGuards(GuardClass)` enhancers
   *     in the scope of the CONTROLLER's containing module, not in the
   *     module that originally declared the guard. That new instantiation
   *     has to resolve `SessionGuard`'s constructor dependencies
   *     (`Reflector`, `TENANT_REGISTRY`, `AUDIT_SINK`) from the consumer's
   *     module tree.
   *   - Without exporting `TENANT_REGISTRY`, a consumer doing
   *     `@UseGuards(SessionGuard)` in any feature module (including the
   *     common `options.global: false` deployment) would get
   *     `UnknownDependenciesException` at boot.
   *   - The public barrel (`src/index.ts`) still does NOT re-export the
   *     symbol, so the token remains private to the library's consumers
   *     at the type/import layer; only the runtime DI graph knows it.
   *
   * Raw/validated option symbols and the tenant-clients builder remain
   * unexported — nothing outside the module needs to inject them.
   */
  private static coreExports(): Array<Type<unknown> | symbol> {
    return [
      SessionGuard,
      OptionalSessionGuard,
      RoleGuard,
      PermissionGuard,
      OAuth2Guard,
      IdentityService,
      SessionService,
      PermissionService,
      TokenService,
      FlowService,
      SchemaService,
      CourierService,
      OAuth2ClientService,
      ConsentService,
      JwkService,
      TrustedIssuerService,
      ProjectAdminService,
      WorkspaceAdminService,
      EventsService,
      MetadataService,
      IamHealthIndicator,
      AUDIT_SINK,
      TENANT_REGISTRY,
      TransportFactory,
      SESSION_CACHE,
      REPLAY_CACHE,
    ];
  }

  /**
   * Emit `config.boot_failure` via the Nest Logger — the audit sink may
   * not be constructed yet when boot fails, so we cannot route through it.
   */
  private static logBootFailure(err: unknown): void {
    const logger = new Logger('IamModule');
    logger.error(
      `config.boot_failure: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * `OnApplicationBootstrap` wiring lives on `PublicRoutesWarner`. The type
 * import above keeps the interface referenced for documentation tooling.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _BootstrapHook = OnApplicationBootstrap;
