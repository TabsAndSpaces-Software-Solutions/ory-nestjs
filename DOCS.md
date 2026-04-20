# `ory-nestjs` — Consumer Guide

This document is a hands-on guide for teams integrating `ory-nestjs` into a NestJS service. It walks through installation, the public API, and three fully-worked scenarios: a single-tenant marketplace with complex role hierarchies (customers with buyer/seller roles, platform admins, multi-type vendors), a multi-tenant setup, and custom per-role permissions via Keto.

Everything below assumes the package is available in your workspace and you have access to Ory Kratos (and optionally Keto, Hydra, Oathkeeper) — either self-hosted or via Ory Network.

---

## Table of contents

1. [Quick start (5 minutes)](#quick-start)
2. [Installation](#installation)
3. [Module registration](#module-registration)
4. [Authentication — guards and decorators](#authentication)
5. [Session caching](#caching)
6. [Authorization — roles and permissions](#authorization)
7. [Tenant-scoped services](#services)
8. [Audit events and observability](#audit)
9. [Error model](#errors)
10. [Self-service flows (login, registration, …)](#flows)
11. [Testing consumer code](#testing)
12. [Scenario A — Single-tenant marketplace (Customer / Admin / Vendor)](#scenario-a)
13. [Scenario B — Multi-tenant (Customer / Admin / Dealer)](#scenario-b)
14. [Scenario C — Custom per-role permissions with Keto](#scenario-c)
15. [Common patterns and gotchas](#gotchas)

---

<a id="quick-start"></a>

## 1. Quick start (5 minutes)

```ts
// app.module.ts
import { Module } from '@nestjs/common';
import { IamModule, InMemorySessionCache } from 'ory-nestjs';
import { AppController } from './app.controller';

@Module({
  imports: [
    IamModule.forRoot({
      sessionCache: new InMemorySessionCache(), // optional: enable in-memory caching
      tenants: {
        default: {
          mode: 'self-hosted',
          transport: 'cookie-or-bearer',
          cache: { sessionTtlMs: 300_000 }, // 5 minutes
          kratos: {
            publicUrl: 'https://kratos.example.com',
            adminUrl: 'https://kratos-admin.internal',
            adminToken: process.env.KRATOS_ADMIN_TOKEN,
          },
        },
      },
    }),
  ],
  controllers: [AppController],
})
export class AppModule {}
```

```ts
// app.controller.ts
import { Controller, Get } from '@nestjs/common';
import { CurrentUser, Public, IamIdentity } from 'ory-nestjs';

@Controller()
export class AppController {
  @Get('/health')
  @Public()
  health() {
    return 'ok';
  }

  @Get('/me')
  me(@CurrentUser() user: IamIdentity) {
    return user;
  }
}
```

That's it. Every route under this app requires a valid Kratos session by default. `@Public()` is the explicit opt-out. `@CurrentUser()` injects a library-owned DTO — you never see an `@ory/*` type in your own code.

---

<a id="installation"></a>

## 2. Installation

```bash
pnpm add ory-nestjs
# peers (you almost certainly already have these):
pnpm add @nestjs/common @nestjs/core reflect-metadata rxjs
```

Node.js 18+ (LTS) and TypeScript strict mode are recommended. The package ships **dual CommonJS + ESM** builds through `package.json#exports`, with correctly paired `.d.ts` / `.d.mts` declarations, so `require`-based and `import`-based consumers both get format-matched types (no "masquerading as CJS" warnings from `@arethetypeswrong/cli`). `@ory/client` is an internal dependency (not a peer) so consumer `package.json` files stay free of Ory.

---

<a id="module-registration"></a>

## 3. Module registration

### 3.1 `forRoot` (sync)

Use when your config values are available at module-load time (process env, literals).

```ts
IamModule.forRoot({
  tenants: { /* … */ },
  defaultTenant: 'customer', // optional; auto-picked if only one tenant
  global: true,              // default true; see §3.3
  auditSink: { provide: AUDIT_SINK, useClass: MyAuditSink }, // optional
  sessionCache: new InMemorySessionCache(), // optional
});
```

### 3.2 `forRootAsync` (async)

Use when config comes from `@nestjs/config`, a secret manager, or any async source.

```ts
IamModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (cs: ConfigService) => ({
    tenants: {
      customer: {
        mode: cs.get('IAM_MODE') as 'self-hosted' | 'cloud',
        transport: 'cookie-or-bearer',
        kratos: {
          publicUrl: cs.get('KRATOS_PUBLIC_URL'),
          adminUrl: cs.get('KRATOS_ADMIN_URL'),
          adminToken: cs.get('KRATOS_ADMIN_TOKEN'),
        },
      },
    },
  }),
});
```

Config is validated synchronously at module-init time via zod; invalid config fails boot with a descriptive `IamConfigurationError` listing every offending path. The process exits non-zero — do not catch this.

### 3.3 The `global` option

`global: true` (default) registers `SessionGuard` as `APP_GUARD`: every route is authenticated unless decorated with `@Public()`. `global: false` disables the global guard — routes default to *unauthenticated* and you opt **in** per route via `@UseGuards(SessionGuard)`. Either way, the module itself is always `@Global()` in the NestJS sense so guards/services are reachable everywhere.

### 3.4 Tenant config shape

```ts
type TenantConfig = {
  mode: 'self-hosted' | 'cloud';
  transport: 'cookie' | 'bearer' | 'cookie-or-bearer' | 'oathkeeper';
  kratos: {
    publicUrl: string;            // required
    adminUrl?: string;            // required for admin ops (identity CRUD, session revoke)
    adminToken?: string;          // required when adminUrl is set in self-hosted mode
    sessionCookieName?: string;   // default 'ory_kratos_session'
  };
  keto?: { readUrl: string; writeUrl: string; apiKey?: string };
  hydra?: {
    publicUrl: string;
    adminUrl: string;
    adminToken?: string;
    clientId?: string;            // required for TokenService.clientCredentials
    clientSecret?: string;
  };
  cloud?: { projectSlug: string; apiKey: string };  // required when mode='cloud'
  oathkeeper?: {
    identityHeader?: string;      // default 'X-User'
    signatureHeader?: string;     // default 'X-User-Signature'
    signerKeys: string[];         // non-empty; allowlist supports rotation
  };
  logging?: { level: 'error' | 'warn' | 'info' | 'debug' };
  cache?: { sessionTtlMs: number; permissionTtlMs: number; jwksTtlMs: number };
  trustProxy?: boolean;           // required true in production with cookie transport
};
```

Refinements enforced at boot:
- `mode: 'cloud'` ⇒ `cloud.projectSlug` + `cloud.apiKey` required.
- `transport: 'oathkeeper'` ⇒ non-empty `oathkeeper.signerKeys`.
- `NODE_ENV=production` + `transport: 'cookie' | 'cookie-or-bearer'` ⇒ `trustProxy: true` required.
- Multiple tenants ⇒ explicit `defaultTenant`.

---

<a id="authentication"></a>

## 4. Authentication — guards and decorators

### 4.1 Guards

| Guard | Use when | Principal attached |
|---|---|---|
| `SessionGuard` | Default; cookie-based or bearer-token Kratos sessions | `IamIdentity` |
| `OptionalSessionGuard` | Route has both auth'd and anonymous modes | `IamIdentity \| null` |
| `OAuth2Guard` | Machine-to-machine calls with Hydra-issued tokens | `IamMachinePrincipal` |
| `PermissionGuard` | Enforces `@RequirePermission` via Keto | — (runs after `SessionGuard`) |
| `RoleGuard` | Enforces `@RequireRole` against identity traits | — (runs after `SessionGuard`) |

`SessionGuard` is registered globally by default. `RoleGuard` and `PermissionGuard` run automatically when their decorators are present — no extra `@UseGuards` needed as long as the module is in global mode.

If you set `global: false`, add guards manually:

```ts
@Controller('admin')
@UseGuards(SessionGuard, RoleGuard, PermissionGuard)
export class AdminController { /* … */ }
```

### 4.2 Decorators

```ts
@Public()                      // skip SessionGuard entirely
@Anonymous()                   // method-level override; same effect as @Public but tighter scope
@Tenant('customer')            // scope this route (or controller) to a named tenant
@RequireRole('admin')          // at least one role must match (OR semantics)
@RequireRole('admin', 'staff') // still OR — user with either role passes
@RequirePermission({           // Keto check
  namespace: 'listings',
  relation: 'edit',
  object: (req) => `listings:${req.params.id}`,
})
@CurrentUser()                 // param decorator: inject the authenticated principal
```

### 4.3 Transport selection

- **`cookie`** — browser apps. Kratos session cookie (default `ory_kratos_session`).
- **`bearer`** — mobile/native. `Authorization: Bearer <kratos-session-token>`.
- **`cookie-or-bearer`** — accepts either; tries cookie first. The common default for a BFF that serves both web and mobile.
- **`oathkeeper`** — you run Oathkeeper in front of your service. It verifies sessions and forwards a signed identity envelope. `SessionGuard` never calls Kratos on the hot path; it only verifies the envelope signature against the configured allowlist.

### 4.4 Cross-tenant bleed defense

When a request's session belongs to tenant A but the route is `@Tenant('B')`, `SessionGuard` rejects with 401 and emits an `auth.tenant_mismatch` audit event — regardless of whether Kratos would otherwise validate the cookie. This is a security invariant, not a side-effect; rely on it.

---

<a id="caching"></a>

## 5. Session caching

By default, every request hits Kratos to validate the session. To reduce latency and Kratos load, you can enable session caching.

### 5.1 Enabling caching

1. Provide a `sessionCache` implementation in `IamModule.forRoot`.
2. Set `cache.sessionTtlMs > 0` for the desired tenants.

The library ships with two implementations:
- `NoopSessionCache` (default): Performs no caching.
- `InMemorySessionCache`: A simple LRU cache for single-pod deployments.

```ts
IamModule.forRoot({
  sessionCache: new InMemorySessionCache({ max: 1000 }),
  tenants: {
    default: {
      // ...
      cache: { sessionTtlMs: 60000 }, // 1 minute
    },
  },
});
```

### 5.2 Cache behavior

- **Fail-open:** If the cache backend throws an error, the library bypasses the cache and calls Kratos directly. The error is logged but doesn't fail the request.
- **TTL computation:** The actual TTL is `min(sessionTtlMs, session.expiresAt - now)`. A session is never cached beyond its Ory-defined expiry.
- **Eviction on revoke:** Calling `SessionService.revoke(sessionId)` or `IdentityService.revokeSession(userId, sessionId)` automatically evicts the session from the cache.
- **Observability:** Successful cache hits are flagged in the `auth.success` audit event as `cacheHit: true`.

### 5.3 Custom cache backends

For multi-pod deployments, implement the `SessionCache` interface (e.g., using Redis):

```ts
import { SessionCache, ResolvedSession } from 'ory-nestjs';

export class RedisSessionCache implements SessionCache {
  async get(key: string): Promise<ResolvedSession | null> { /* ... */ }
  async set(key: string, value: ResolvedSession, ttlMs: number): Promise<void> { /* ... */ }
  async delete(key: string): Promise<void> { /* ... */ }
  async deleteBySessionId(sessionId: string): Promise<void> { /* ... */ }
}
```

---

<a id="authorization"></a>

## 6. Authorization — roles and permissions

There are two independent mechanisms, and you will usually use both.

### 6.1 Role-based (in-memory)

Roles live on the identity itself, in one of two places:

1. `metadataPublic.roles: string[]` — admin-set, trusted, preferred.
2. `traits.roles: string[]` — self-serve-settable, only use for low-risk roles.

`metadataPublic.roles` wins when both are present. For machine principals (from `OAuth2Guard`), scopes double as roles — `@RequireRole('read:listings')` matches `IamMachinePrincipal { scope: ['read:listings'] }`.

```ts
@Get('/admin/users')
@Tenant('default')
@RequireRole('admin', 'support')   // admin OR support passes
listUsers() { /* … */ }
```

No network call, no Keto dependency — role checks are a pure function of the identity already on the request.

### 6.2 Relationship-based (Keto)

For data-scoped checks (can user X edit listing Y?), use `@RequirePermission`:

```ts
@Put('/listings/:id')
@RequirePermission({
  namespace: 'listings',
  relation: 'edit',
  object: (req) => `listings:${req.params.id}`,   // pure function, no I/O
})
updateListing(@Param('id') id: string) { /* … */ }
```

Under the hood the guard calls Keto's `checkPermission` with `subject = 'user:' + user.id`. Keto returns `{ allowed: boolean }`; `false` → 403, upstream 5xx → 503 (fail-closed — never 200 on error).

Stacking permissions (AND semantics):

```ts
@RequirePermission({ namespace: 'orders', relation: 'view', object: (r) => `orders:${r.params.id}` })
@RequirePermission({ namespace: 'listings', relation: 'owner', object: (r) => `listings:${r.params.listingId}` })
viewOrder() { /* both must be allowed */ }
```

### 6.3 When to use which

| Decision | Use roles | Use Keto permissions |
|---|---|---|
| Check is global to the service | ✅ | |
| Check depends on a specific object id | | ✅ |
| Role set is small and stable | ✅ | |
| Relationships are dynamic (ownership, sharing) | | ✅ |
| You need an audit trail of grants/revokes | | ✅ |

The two compose cleanly. Use roles to gate whole endpoints ("only admins hit `/admin/*`"), then Keto to gate individual records ("admins can only edit listings in their region").

---

<a id="services"></a>

## 7. Tenant-scoped services

All five services expose `.forTenant(name)` which returns a stable instance bound to that tenant's Ory clients. Calls are routed to the right Kratos/Keto/Hydra per tenant. Unknown tenant names throw `IamConfigurationError`.

```ts
import {
  IdentityService, SessionService, PermissionService, TokenService, FlowService,
} from 'ory-nestjs';

@Injectable()
export class SupportService {
  constructor(
    private readonly identities: IdentityService,
    private readonly sessions: SessionService,
    private readonly perms: PermissionService,
  ) {}

  async revokeAndAnonymize(userId: string) {
    const id = this.identities.forTenant('customer');
    const ses = this.sessions.forTenant('customer');

    for (const s of await id.listSessions(userId)) await ses.revoke(s.id);
    await id.updateTraits(userId, { email: `deleted+${userId}@example.com` });
    // OR: await id.delete(userId);  — hard delete.
  }
}
```

### Quick method reference

| Service | Method | Notes |
|---|---|---|
| `IdentityService` | `get`, `getWithTraits`, `list`, `create`, `updateTraits`, `delete`, `listSessions`, `revokeSession` | `get` is sanitized by default (no PII). Admin ops require `kratos.adminToken`. |
| `SessionService` | `whoami(req)`, `whoamiOrNull(req)`, `revoke(sessionId)` | `whoamiOrNull` returns `null` only for missing credentials; upstream 5xx still throws. |
| `PermissionService` | `check`, `grant`, `revoke`, `list` | `grant`/`revoke` are idempotent (409/404 treated as success). |
| `TokenService` | `clientCredentials(scope)`, `introspect(token)` | Requires `hydra.clientId` + `hydra.clientSecret` for `clientCredentials`. |
| `FlowService` | `initiate*/submit*/fetchFlow` across login, registration, recovery, settings, verification | Thin pass-through over Kratos Frontend API with CSRF extraction. |

---

<a id="audit"></a>

## 8. Audit events and observability

Every auth decision emits a structured event. The default `LoggerAuditSink` writes them through NestJS `Logger` with automatic redaction (JWT-shaped strings, cookies, `traits`, admin tokens all stripped).

To ship events elsewhere, provide your own sink:

```ts
import { Injectable } from '@nestjs/common';
import { AuditSink, AUDIT_SINK, IamAuditEvent } from 'ory-nestjs';

@Injectable()
export class OtelAuditSink implements AuditSink {
  async emit(event: IamAuditEvent) {
    // push to OTel log record, SIEM webhook, Kafka, whatever.
  }
}

IamModule.forRoot({
  tenants: { /* … */ },
  auditSink: { provide: AUDIT_SINK, useClass: OtelAuditSink },
});
```

Events emitted:

| Event | Source | Level |
|---|---|---|
| `auth.success` | `SessionGuard`, `OAuth2Guard` | info |
| `auth.failure.missing_credential` | `SessionGuard` | warn |
| `auth.failure.expired` | transport/mapper | warn |
| `auth.failure.malformed` | transport | warn |
| `auth.failure.token_inactive` | `OAuth2Guard` | warn |
| `auth.failure.unsigned_header` | `OathkeeperTransport` | warn |
| `auth.failure.upstream` | `SessionGuard` | warn |
| `auth.tenant_mismatch` | `SessionGuard` | warn |
| `authz.role.deny` | `RoleGuard` | warn |
| `authz.permission.grant` | `PermissionGuard`, `PermissionService.grant` | info |
| `authz.permission.deny` | `PermissionGuard` | warn |
| `authz.permission.revoke` | `PermissionService.revoke` | info |
| `authz.upstream_unavailable` | `PermissionGuard` | warn |
| `authz.session.revoke` | `SessionService.revoke`, `IdentityService.revokeSession` | info |
| `health.probe_failure` | `IamHealthIndicator` | warn |
| `config.boot_failure` | `IamModule` | error |

### Health indicator (`@nestjs/terminus`)

```ts
import { TerminusModule, HealthCheckService } from '@nestjs/terminus';
import { IamHealthIndicator } from 'ory-nestjs';

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthCheckService, private readonly iam: IamHealthIndicator) {}

  @Get()
  @Public()
  check() {
    return this.health.check([() => this.iam.isHealthy('ory-nestjs')]);
  }
}
```

Probes every configured tenant × product (`/health/ready`) with a 500ms timeout. Failure payload names the failing tenant + product only — no URLs, tokens, or project slugs leak.

### Correlation IDs

`SessionGuard` reads `X-Request-Id` off the request (or generates one), stamps it onto outbound Ory calls, and includes it on every audit event. Add your own `AsyncLocalStorage`-aware logger and requests across the stack will join neatly.

---

<a id="errors"></a>

## 9. Error model

Every library throw is one of four classes, mapped to a NestJS exception with a redacted payload:

| Thrown | Nest exception | HTTP | Payload highlights |
|---|---|---|---|
| `IamUnauthorizedError` | `UnauthorizedException` | 401 | `wwwAuthenticate: 'Bearer realm="ory-nestjs"'` |
| `IamForbiddenError` | `ForbiddenException` | 403 | — |
| `IamUpstreamUnavailableError` | `ServiceUnavailableException` | 503 | `retryAfter: 5` |
| `IamConfigurationError` | `InternalServerErrorException` | 500 | Generic message (detail logged server-side only) |

Library errors **never** echo upstream payloads. If a Kratos response contains a JWT or session token, the mapper strips it before the error leaves the library — you cannot accidentally leak PII into an error response or log line.

To surface the `wwwAuthenticate` hint and `retryAfter` as real HTTP headers, add a tiny interceptor in your app:

```ts
@Injectable()
export class IamErrorHeadersInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(
      catchError((err) => {
        if (err instanceof HttpException) {
          const res = ctx.switchToHttp().getResponse();
          const body = err.getResponse() as any;
          if (body?.wwwAuthenticate) res.setHeader('WWW-Authenticate', body.wwwAuthenticate);
          if (body?.retryAfter != null) res.setHeader('Retry-After', String(body.retryAfter));
        }
        return throwError(() => err);
      }),
    );
  }
}
```

---

<a id="flows"></a>

## 10. Self-service flows (login, registration, …)

`FlowService` is a thin server-side proxy over Kratos's self-service flow endpoints. Use it from a BFF that mediates between a browser/mobile UI and Kratos.

```ts
@Controller('auth')
@Public()                            // these endpoints must be reachable without a session
export class AuthController {
  constructor(private readonly flows: FlowService) {}

  @Get('/login')
  async initiateLogin(@Query('returnTo') returnTo?: string) {
    return this.flows.forTenant('customer').initiateLogin({ returnTo });
  }

  @Post('/login/:flowId')
  async submitLogin(@Param('flowId') id: string, @Body() body: unknown) {
    const result = await this.flows.forTenant('customer').submitLogin(id, body);
    return result; // { kind: 'success', sessionId } | { kind: 'continue', flow }
  }
}
```

Returned flow DTOs (`IamLoginFlow`, etc.) contain library-owned `IamFlowUi` nodes + an opaque `csrfToken`. Never pass Ory's UI shapes directly to your frontend; always go through these DTOs.

---

<a id="testing"></a>

## 11. Testing consumer code

```ts
import { Test } from '@nestjs/testing';
import { IamTestingModule } from 'ory-nestjs';
import request from 'supertest';

describe('ListingsController', () => {
  it('allows the owner to edit', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        IamTestingModule.forRoot({
          identity: {
            id: 'u_abc', schemaId: 'default', state: 'active',
            verifiedAddressesFlags: { email: true, phone: false },
            metadataPublic: { roles: ['seller'] },
            tenant: 'customer',
          },
          permissions: { 'listings:edit:listings:42': true },
        }),
      ],
      controllers: [ListingsController],
      providers: [ListingsService],
    }).compile();

    const app = moduleRef.createNestApplication();
    await app.init();
    await request(app.getHttpServer()).put('/listings/42').expect(200);
    await app.close();
  });

  it('denies when not owner', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        IamTestingModule.forRoot({
          identity: { /* same */ },
          permissions: { 'listings:edit:listings:42': false },
        }),
      ],
      controllers: [ListingsController],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    await request(app.getHttpServer()).put('/listings/42').expect(403);
  });

  it('rejects unauthenticated request', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [IamTestingModule.forRoot({ /* no identity */ })],
      controllers: [ListingsController],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    await request(app.getHttpServer()).put('/listings/42').expect(401);
  });
});
```

Zero network. Zero Ory dependencies. The testing module replaces all guards and services with deterministic in-memory stubs.

### Running the library's own integration tests

The library itself ships a real-Kratos integration harness under `test/integration/`. It spins up Postgres + Kratos via Testcontainers, logs in against a live API, and exercises the cookie and bearer transports end-to-end plus the session cache hit/miss/revoke paths.

```bash
# Unit + contract tests — fast, no Docker required.
pnpm test

# Integration tests — requires a running Docker daemon. Cold start is ~10s
# (container boot + migration), warm runs complete in a second.
pnpm test:integration
```

If you're onboarding a new deployment target, the integration harness is the fastest way to validate that your Kratos config is compatible: copy one of the specs under `test/integration/specs/` and point it at your cluster via the `StackHandle` override.

The `state` is mutable post-boot:

```ts
import { TESTING_STATE, TestingState } from 'ory-nestjs';
const state = moduleRef.get<TestingState>(TESTING_STATE);
state.permissions.set('listings:delete:listings:42', true);
```

> **Gotcha:** `@UseGuards(SessionGuard)` using the class reference directly bypasses the DI alias because NestJS instantiates a fresh injectable. If you need to override a specific guard class, pair the testing module with `Test.createTestingModule(...).overrideGuard(SessionGuard).useValue(fakeInstance)`. In global-guard mode (the default) this is not an issue.

---

<a id="scenario-a"></a>

## 12. Scenario A — Single-tenant marketplace (Customer / Admin / Vendor)

You are running a marketplace. All actors authenticate against one Kratos project. The actor types are:

- **Customer** — end user. Has sub-roles `buyer`, `seller` (can hold both simultaneously).
- **Platform Admin** — internal employee. Has sub-roles `admin`, `developer`, `sales`, `support`.
- **Vendor** — external partner. Has a **type** (`logistics`, `finance`, `rto`, `insurance`) and a **role within the type** (`admin` or `staff`).

### 11.1 Role modeling

Roles are set by administrators and travel on the identity's `metadataPublic`. Traits stay user-editable (name, email, phone), metadata stays server-only. We encode the model like this:

```ts
// Identity.metadataPublic (server-set, surfaced to services but NOT self-editable)
type IamMetadataPublic = {
  actorType: 'customer' | 'platform_admin' | 'vendor';
  roles: string[];              // see below
  vendor?: {
    type: 'logistics' | 'finance' | 'rto' | 'insurance';
  };
};
```

**Role name convention** — flatten the hierarchy into a single array the library can OR-match against. Use colon-separated namespaces:

| Actor | Example `roles` |
|---|---|
| Customer who buys | `['customer:buyer']` |
| Customer who buys and sells | `['customer:buyer', 'customer:seller']` |
| Platform admin (full) | `['platform:admin']` |
| Platform developer | `['platform:developer']` |
| Logistics vendor — admin | `['vendor:logistics:admin']` |
| Logistics vendor — staff | `['vendor:logistics:staff']` |
| Finance vendor — staff | `['vendor:finance:staff']` |

The library's `@RequireRole` compares strings literally, so this encoding gives you:

- A single check for "any customer" — you can't do it directly with OR, so you gate the whole controller with `@Tenant('default')` and let routes under it choose specific sub-roles.
- "Any platform admin" — `@RequireRole('platform:admin', 'platform:developer', 'platform:sales', 'platform:support')`.
- "Logistics admin specifically" — `@RequireRole('vendor:logistics:admin')`.
- "Any vendor admin" — `@RequireRole('vendor:logistics:admin', 'vendor:finance:admin', 'vendor:rto:admin', 'vendor:insurance:admin')`.

If you find yourself writing the same long OR list repeatedly, factor it into a custom decorator:

```ts
// decorators/platform-staff.decorator.ts
import { applyDecorators } from '@nestjs/common';
import { RequireRole } from 'ory-nestjs';

export const PlatformStaff = () =>
  RequireRole('platform:admin', 'platform:developer', 'platform:sales', 'platform:support');

export const VendorAdmin = (type?: 'logistics' | 'finance' | 'rto' | 'insurance') =>
  type
    ? RequireRole(`vendor:${type}:admin`)
    : RequireRole('vendor:logistics:admin', 'vendor:finance:admin', 'vendor:rto:admin', 'vendor:insurance:admin');
```

### 11.2 Module setup (single tenant)

```ts
IamModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (cs: ConfigService) => ({
    tenants: {
      default: {
        mode: 'self-hosted',
        transport: 'cookie-or-bearer',
        kratos: {
          publicUrl: cs.get('KRATOS_PUBLIC_URL'),
          adminUrl: cs.get('KRATOS_ADMIN_URL'),
          adminToken: cs.get('KRATOS_ADMIN_TOKEN'),
        },
        keto: {
          readUrl: cs.get('KETO_READ_URL'),
          writeUrl: cs.get('KETO_WRITE_URL'),
        },
        trustProxy: true,
      },
    },
    // defaultTenant: 'default',   // auto-derived since there's only one tenant
  }),
});
```

No `@Tenant()` needed on controllers — everything resolves to `default`.

### 11.3 Customer routes

```ts
@Controller('listings')
export class ListingsController {
  // Any customer can browse.
  @Get()
  @RequireRole('customer:buyer', 'customer:seller')
  list() { /* … */ }

  // Only sellers can create listings.
  @Post()
  @RequireRole('customer:seller')
  create(@CurrentUser() user: IamIdentity, @Body() body: CreateListingDto) { /* … */ }

  // Only the seller who owns this listing can edit it — Keto check.
  @Put(':id')
  @RequireRole('customer:seller')
  @RequirePermission({
    namespace: 'listings',
    relation: 'owner',
    object: (req) => `listings:${req.params.id}`,
  })
  edit(@Param('id') id: string, @Body() body: EditListingDto) { /* … */ }

  // Buyers place offers.
  @Post(':id/offers')
  @RequireRole('customer:buyer')
  makeOffer(@Param('id') id: string, @CurrentUser() user: IamIdentity) { /* … */ }
}
```

Seed Keto on listing creation so the owner check in `PUT /listings/:id` works:

```ts
await permissionService.forTenant('default').grant({
  namespace: 'listings',
  object: `listings:${newListingId}`,
  relation: 'owner',
  subject: `user:${user.id}`,
  tenant: 'default',
});
```

### 11.4 Platform admin routes

```ts
@Controller('admin')
export class AdminController {
  // Support agents and above can look up users.
  @Get('users/:id')
  @RequireRole('platform:admin', 'platform:support')
  async getUser(@Param('id') id: string) {
    return this.identity.forTenant('default').get(id);
  }

  // Only full admins can delete.
  @Delete('users/:id')
  @RequireRole('platform:admin')
  async deleteUser(@Param('id') id: string) {
    await this.identity.forTenant('default').delete(id);
  }

  // Developers only — feature flag toggles, etc.
  @Post('feature-flags/:key')
  @RequireRole('platform:developer')
  flip(@Param('key') key: string, @Body() body: { enabled: boolean }) { /* … */ }

  // Sales dashboard.
  @Get('leads')
  @PlatformStaff()                // the custom decorator from §11.1
  leads() { /* … */ }
}
```

### 11.5 Vendor routes — type + role matrix

The library's `@RequireRole` doesn't know about "vendor type". Encode both type and role in the role string (`vendor:logistics:admin`) and use a controller-level `@RequireRole` or guard to narrow by type, then method-level for role within type.

```ts
@Controller('vendor/logistics')
@RequireRole(
  'vendor:logistics:admin',
  'vendor:logistics:staff',
)
export class LogisticsVendorController {
  @Get('shipments')
  // inherits controller-level OR — either role passes
  listShipments(@CurrentUser() user: IamIdentity) { /* … */ }

  @Post('shipments/:id/cancel')
  @RequireRole('vendor:logistics:admin')          // admin only; tightens at method level
  cancelShipment(@Param('id') id: string) { /* … */ }
}
```

Repeat the pattern per vendor type (`/vendor/finance`, `/vendor/rto`, `/vendor/insurance`). If several vendor types share endpoints, parameterize:

```ts
// vendor-type.guard.ts — optional custom guard that validates route param against role
@Injectable()
export class VendorTypeGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const user = req.user as IamIdentity;
    const routeType = req.params.type as string;
    const allowed = user.metadataPublic?.vendor?.type === routeType;
    if (!allowed) throw new ForbiddenException();
    return true;
  }
}

@Controller('vendor/:type')
@RequireRole(
  'vendor:logistics:admin', 'vendor:logistics:staff',
  'vendor:finance:admin',   'vendor:finance:staff',
  'vendor:rto:admin',       'vendor:rto:staff',
  'vendor:insurance:admin', 'vendor:insurance:staff',
)
@UseGuards(VendorTypeGuard)
export class VendorController {
  @Get('invoices')
  invoices(@Param('type') type: string) { /* … */ }
}
```

---

<a id="scenario-b"></a>

## 13. Scenario B — Multi-tenant (Customer / Admin / Dealer)

Three separate Ory projects — one per tenant — in a single process. This is the recommended shape when the actor populations are genuinely disjoint and you want project-level isolation (separate identity schemas, separate admin tokens, separate audit trails).

### 13.1 Module setup

```ts
IamModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (cs: ConfigService) => ({
    defaultTenant: 'customer',
    tenants: {
      customer: {
        mode: 'cloud',
        transport: 'cookie-or-bearer',
        kratos: { publicUrl: cs.get('CUSTOMER_KRATOS_URL') },
        keto:   { readUrl: cs.get('CUSTOMER_KETO_URL'), writeUrl: cs.get('CUSTOMER_KETO_URL') },
        cloud:  { projectSlug: cs.get('CUSTOMER_PROJECT'), apiKey: cs.get('CUSTOMER_API_KEY') },
      },
      admin: {
        mode: 'self-hosted',
        transport: 'bearer',                         // admin tools call APIs directly
        kratos: {
          publicUrl: cs.get('ADMIN_KRATOS_URL'),
          adminUrl: cs.get('ADMIN_KRATOS_ADMIN_URL'),
          adminToken: cs.get('ADMIN_KRATOS_TOKEN'),
        },
      },
      dealer: {
        mode: 'self-hosted',
        transport: 'cookie-or-bearer',
        kratos: {
          publicUrl: cs.get('DEALER_KRATOS_URL'),
          adminUrl: cs.get('DEALER_KRATOS_ADMIN_URL'),
          adminToken: cs.get('DEALER_KRATOS_TOKEN'),
        },
        hydra: {                                      // dealers use OAuth2 for partner APIs
          publicUrl: cs.get('DEALER_HYDRA_URL'),
          adminUrl: cs.get('DEALER_HYDRA_ADMIN_URL'),
          adminToken: cs.get('DEALER_HYDRA_TOKEN'),
        },
      },
    },
  }),
});
```

### 13.2 Routing requests to the right tenant

Pick one of two strategies:

**Strategy 1 — route prefix per tenant (recommended).** Each controller declares its tenant at the class level.

```ts
@Controller('customer')
@Tenant('customer')
export class CustomerController { /* resolves against 'customer' */ }

@Controller('admin')
@Tenant('admin')
@UseGuards(SessionGuard)             // global is still on, but admin tools might prefer explicit
@RequireRole('platform:admin')
export class AdminController { /* resolves against 'admin' */ }

@Controller('dealer')
@Tenant('dealer')
export class DealerController { /* resolves against 'dealer' */ }
```

**Strategy 2 — subdomain/host resolver.** Write a small middleware that maps `admin.example.com` → `admin` tenant and stamps `TENANT_KEY` metadata dynamically. More work; only pick this if route prefixes aren't acceptable.

### 13.3 Cross-tenant calls (admin tool auditing a customer)

Admin routes authenticate against the `admin` tenant (their own Ory project) but need to **read** a customer identity from the `customer` tenant:

```ts
@Controller('admin/customers')
@Tenant('admin')                     // session validation uses admin Ory
@RequireRole('platform:admin', 'platform:support')
export class CustomerLookupController {
  constructor(private readonly identities: IdentityService) {}

  @Get(':id')
  async get(@Param('id') id: string) {
    // The admin is already authenticated. Use the customer tenant's services.
    return this.identities.forTenant('customer').get(id);
  }
}
```

This is the canonical pattern: authenticate against one tenant, service-call into another. Cross-tenant session bleed is still impossible — the guard always rejects a session whose `tenant` doesn't match the route's `@Tenant`.

### 13.4 OAuth2 machine-to-machine for dealers

Dealers' partner APIs accept M2M tokens:

```ts
@Controller('dealer/partner-api')
@Tenant('dealer')
@UseGuards(OAuth2Guard)              // instead of SessionGuard
export class PartnerApiController {
  @Get('inventory')
  @RequireRole('inventory:read')     // scope doubles as role for machine principals
  listInventory(@CurrentUser() principal: IamMachinePrincipal) {
    // principal.kind === 'machine'
    // principal.clientId = 'dealer-123'
    // principal.scope = ['inventory:read']
  }
}
```

Issuing tokens from the dealer's own service (if they hold your `client_id` + `client_secret`):

```ts
const token = await tokenService.forTenant('dealer').clientCredentials(['inventory:read']);
// { accessToken, tokenType: 'Bearer', expiresIn: 3600, scope: [...] }
```

### 13.5 Typed tenant names (optional)

If you want TypeScript to catch tenant-name typos:

```ts
// types/tenants.ts
export const TENANTS = ['customer', 'admin', 'dealer'] as const;
export type TenantName = (typeof TENANTS)[number];
```

Nothing in the library forces this — `TenantName` is `string` — but adopting the pattern in your own app code prevents class of bugs where `@Tenant('customr')` silently resolves wrong.

---

<a id="scenario-c"></a>

## 14. Scenario C — Custom per-role permissions with Keto

Roles give you coarse gates. Keto gives you fine gates. This section shows how to combine them for a marketplace where ownership, delegation, and team membership all matter.

### 14.1 Designing the relationship model

Start from the questions you need to answer:

- Can **user X** edit **listing Y**?
- Can **user X** view **order Z**'s internal notes?
- Can **team A** manage **vendor dashboard D**?

Express each as a `(namespace, object, relation, subject)` tuple:

| Question | Namespace | Object | Relation | Subject |
|---|---|---|---|---|
| X owns listing 42 | `listings` | `listings:42` | `owner` | `user:X` |
| X can edit listing 42 | `listings` | `listings:42` | `edit` | `user:X` |
| Team A views dashboard D | `dashboards` | `dashboards:D` | `viewer` | `group:team-A` |
| X is member of team A | `teams` | `teams:A` | `member` | `user:X` |

Keto can traverse these — defining an `edit` relation as "owner of the listing" lets one tuple (ownership) imply another (edit rights) automatically. Configure your Keto namespaces file accordingly.

### 14.2 Seeding permissions when things happen

```ts
@Injectable()
export class ListingService {
  constructor(private readonly perms: PermissionService) {}

  async create(input: CreateListingDto, user: IamIdentity) {
    const id = await this.repo.insert(input);
    await this.perms.forTenant('default').grant({
      namespace: 'listings',
      object: `listings:${id}`,
      relation: 'owner',
      subject: `user:${user.id}`,
      tenant: 'default',
    });
    return id;
  }

  async transferOwnership(listingId: string, fromUserId: string, toUserId: string) {
    const perms = this.perms.forTenant('default');
    const tuple = (subject: string) => ({
      namespace: 'listings',
      object: `listings:${listingId}`,
      relation: 'owner',
      subject,
      tenant: 'default' as const,
    });
    await perms.revoke(tuple(`user:${fromUserId}`));
    await perms.grant(tuple(`user:${toUserId}`));
    // Both revoke and grant are idempotent — safe to retry on failure.
  }
}
```

### 14.3 Enforcing at the route

```ts
@Put('listings/:id')
@RequireRole('customer:seller')                          // coarse: must be a seller
@RequirePermission({                                      // fine: must own this listing
  namespace: 'listings',
  relation: 'edit',
  object: (req) => `listings:${req.params.id}`,
})
edit(@Param('id') id: string, @Body() body: EditListingDto) { /* … */ }
```

Both must pass (AND semantics). Deny on either surfaces as a 403 with a targeted audit event (`authz.role.deny` or `authz.permission.deny`) so dashboards can tell you exactly which gate fired.

### 14.4 Dynamic object keys

The `object` resolver is a pure function of the request — it can pull from params, body, or headers. Use it for anything that's not a literal:

```ts
// From the URL path
object: (req) => `listings:${req.params.id}`

// From the body (for batch endpoints)
object: (req) => `listings:${req.body.listingId}`

// From a computed namespace
object: (req) => `tenant-${req.params.tenantId}:listings:${req.params.id}`

// Returning undefined triggers 400 Bad Request before Keto is called —
// useful for sanity-checking route shape.
object: (req) => req.params.id ? `listings:${req.params.id}` : undefined
```

The resolver must not do I/O — it runs synchronously inside the guard.

### 14.5 Checking permissions inside services

Beyond the declarative guard, call `PermissionService.check` directly when logic depends on authorization state:

```ts
async canUserViewListing(user: IamIdentity, listingId: string): Promise<boolean> {
  return this.perms.forTenant('default').check({
    namespace: 'listings',
    object: `listings:${listingId}`,
    relation: 'view',
    subject: `user:${user.id}`,
    tenant: 'default',
  });
}
```

Use for: conditional UI rendering, filtering lists in memory, soft checks that shouldn't throw.

### 14.6 Listing / auditing permissions

```ts
const { items } = await perms.forTenant('default').list({
  namespace: 'listings',
  subject: `user:${userId}`,
  tenant: 'default',
  // limit and pageToken also supported
});
```

Use for: admin tools that show "what can this user see?", bulk off-boarding, compliance reports.

### 14.7 Combining roles and Keto into "capabilities"

If your consumers want to think in terms of capabilities rather than primitive checks, build a thin wrapper:

```ts
// capabilities.ts
export const Capabilities = {
  CanEditListing: (listingId: string) =>
    applyDecorators(
      RequireRole('customer:seller'),
      RequirePermission({
        namespace: 'listings',
        relation: 'edit',
        object: () => `listings:${listingId}`,
      }),
    ),
  CanManageInternally: () =>
    applyDecorators(
      RequireRole('platform:admin', 'platform:support'),
    ),
};

// Usage
@Put('listings/:id')
@Capabilities.CanEditListing(':id')        // pseudo — real shape uses req.params in the resolver
edit() { /* … */ }
```

Keep these thin — they're ergonomic shortcuts, not another layer of abstraction. If a capability needs conditional logic beyond AND-ing decorators, write a custom guard instead.

---

<a id="gotchas"></a>

## 15. Common patterns and gotchas

**1. Don't read `req.user` directly. Use `@CurrentUser()`.** The decorator gives you typed access and survives refactors. `req.user` is an untyped any-grab-bag.

**2. Never trust `X-User-Id` or any other self-reported header.** The library deliberately does not expose a way to authenticate via a caller-supplied id. If you feel you need one, you're probably looking for the Oathkeeper transport instead (where the signer is trusted, not the header value).

**3. CORS is yours to configure.** The library documents expected CORS for cookie transport but never mutates it. Cookie transport + CORS + cross-subdomain sharing is the single most common source of "why doesn't my session work" — test it against staging early.

**4. CSRF is yours to handle for cookie flows.** Flow submissions include a CSRF token from Kratos; forward it verbatim on submit. `FlowService.submitLogin` does this automatically; hand-rolled flows need to preserve it.

**5. Boot fails fast, by design.** If config is invalid, `app.init()` throws — don't catch it. Kubernetes/PM2 will restart the pod and surface the problem in logs. Catching it hides misconfiguration until a user first logs in.

**6. `@Public()` is visible at dev-time.** In non-production, the library logs every `@Public()` route on boot. Audit the list during code review.

**7. Audit sink is synchronous by default.** If your sink blocks (HTTP webhook), wrap it with a queue inside your implementation so auth decisions aren't gated on sink availability.

**8. Ory Network DNS quirks.** `https://{slug}.projects.oryapis.com` is fine, but typos silently fail with DNS misses that only surface at first request. Double-check the slug in config.

**9. Admin tokens never hit the client.** `forRootAsync` with a `ConfigService` that reads from a secret manager is the canonical pattern. Never commit admin tokens to repo, never ship them to the browser.

**10. Key rotation for Oathkeeper.** `oathkeeper.signerKeys` is a list for a reason. Add the new key to the tail, deploy, remove the old key from the head in a follow-up deploy. The library logs (once per key per process) when a request verifies against a non-primary key — use that as the signal to complete rotation.

**11. Caching is off by default.** `cache.sessionTtlMs: 0` means every request hits Kratos. Turn on caching only after you've validated the library works against your deployment; the default errs on the side of freshness. Per-request de-duplication (two guards evaluating the same request) happens automatically via `AsyncLocalStorage`.

**12. The testing module is NOT a replacement for integration tests.** Hermetic unit tests catch controller logic. You still want at least one integration test per tenant that boots the real module against a staging Kratos — it's the only way to catch config drift before users do.

---

## Appendix — Public API checklist

Everything importable from `ory-nestjs`:

- **Module**: `IamModule`, `IamAsyncOptions`, `IamOptions`.
- **Guards**: `SessionGuard`, `OptionalSessionGuard`, `RoleGuard`, `PermissionGuard`, `OAuth2Guard`.
- **Decorators**: `Public`, `Anonymous`, `Tenant`, `RequireRole`, `RequirePermission`, `CurrentUser`.
- **Services**: `IdentityService`, `SessionService`, `PermissionService`, `TokenService`, `FlowService`.
- **DTOs**: `IamIdentity`, `IamIdentityWithTraits`, `IamSession`, `IamPermissionTuple`, `IamPermissionQuery`, `IamToken`, `IamTokenIntrospection`, `IamMachinePrincipal`, `IamLoginFlow`, `IamRegistrationFlow`, `IamRecoveryFlow`, `IamSettingsFlow`, `IamVerificationFlow`, `IamAuditEvent`, `IamFlowUi`.
- **Type guards**: `isUserPrincipal`, `isMachinePrincipal`.
- **Errors**: `IamError`, `IamConfigurationError`, `IamUnauthorizedError`, `IamForbiddenError`, `IamUpstreamUnavailableError`, `ErrorMapper`.
- **Audit**: `AuditSink` (interface), `AUDIT_SINK` (DI token), `LoggerAuditSink`, `Redactor`, `AuditEventName`.
- **Health**: `IamHealthIndicator`, `HealthCheckError`, `HealthIndicatorResult`.
- **Testing**: `IamTestingModule`, `IamTestingOptions`, `TESTING_STATE`, `TestingState`.
- **Caching**: `SessionCache` (interface), `SESSION_CACHE` (DI token), `InMemorySessionCache`, `NoopSessionCache`.
- **Config helpers**: `ConfigLoader`, `formatZodError`.
- **Utility**: `deepFreeze`.

Anything **not** in this list is internal. Do not deep-import from `ory-nestjs/dist/...`; it's unstable across minor versions.
