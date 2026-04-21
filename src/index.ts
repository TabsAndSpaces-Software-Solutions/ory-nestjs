/**
 * ory-nestjs — public entry point.
 *
 * This barrel re-exports ONLY library-defined symbols:
 *   - DTOs (src/dto)
 *   - Errors (src/errors)
 *   - Guards (src/guards)
 *   - Decorators (src/decorators)
 *   - Services (src/services)
 *   - The IamModule (src/module)
 *   - Testing helpers (src/testing)
 *   - Types
 *
 * ZERO-ORY-LEAKAGE CONTRACT:
 * Nothing from `@ory/*` may be re-exported here, directly or transitively.
 * The adapter layer (src/clients, src/dto/mappers, src/transport) is the
 * only place allowed to import `@ory/*`, and those types must never escape
 * through this file.
 *
 * Subsequent units will populate these exports.
 */

// Library-owned DTOs, type guards, and the `deepFreeze` helper.
// Mappers under src/dto/mappers/ are NOT re-exported — they live in the
// adapter layer and are only imported by clients/services.
export * from './dto';

// Error hierarchy + central NestJS mapper.
export * from './errors';

// Audit pipeline: pluggable sink, default logger-backed sink, and the
// Redactor utility that strips tokens/cookies/PII from payloads.
export * from './audit';

// Session cache: interface, backends (Noop, InMemory), and the
// SESSION_CACHE DI token for consumers wiring a Redis-backed implementation.
export * from './cache';

// Boot configuration: zod-backed loader, inferred types, error formatter.
// The zod schema itself is NOT re-exported — consumers go through the loader.
export * from './config';

// Route-level & param decorators: @Public, @Anonymous, @Tenant, @RequireRole,
// @RequirePermission, @CurrentUser. Metadata keys are intentionally NOT
// re-exported — they are internal to the library's guards.
export * from './decorators';

// Guards: SessionGuard, OptionalSessionGuard, RoleGuard, PermissionGuard,
// OAuth2Guard.
export * from './guards';

// Tenant-scoped services: IdentityService, SessionService, PermissionService,
// TokenService, FlowService. Each exposes a `.forTenant(name)` factory.
export * from './services';

// Terminus-compatible health indicator for Ory reachability probes.
export * from './health';

// The dynamic module consumers register in their AppModule, plus the
// async-registration option types.
export * from './module';

// Hermetic testing harness: `IamTestingModule`, its options, and the
// `TESTING_STATE` handle for in-place state mutation. Side-effect-free so
// consumer production builds tree-shake the testing tree when not imported.
export * from './testing';

// `TransportFactory` is a transitive dependency of `SessionGuard` — its
// constructor signature appears in the emitted `.d.ts`, so consumers using
// `@UseGuards(SessionGuard)` outside of the module-wired DI graph (e.g.
// a custom testing module or an advanced override) must be able to
// reference the symbol at both the type and runtime levels. Exporting it
// from the transport barrel alone left the declaration half-exposed — the
// type was visible via SessionGuard's signature but not reachable from the
// public entry. We intentionally do NOT re-export concrete transports
// (Cookie/Bearer/Oathkeeper/...), the `RequestLike` type, or any other
// transport internals — those remain implementation detail.
export { TransportFactory } from './transport/transport.factory';
