/**
 * `IamTestingModule` — hermetic, in-memory replacement for
 * `IamModule` consumers import from their test harnesses.
 *
 * Design goals (spec unit `tst`):
 *   - Zero Ory contact: no `@ory/*` imports anywhere in `src/testing/**`.
 *   - Zero network I/O: stubs answer purely from an in-memory
 *     `TestingState`.
 *   - Deterministic guard answers:
 *       - `FakeSessionGuard` allows when a fixture identity is present,
 *         denies 401 otherwise. `@Public()` / `@Anonymous()` short-circuit.
 *       - `FakePermissionGuard` consults the `permissions` map with a
 *         canonical `namespace:relation:object` key; default-deny.
 *       - `FakeOAuth2Guard` consults the `introspections` map; missing /
 *         inactive tokens produce 401.
 *       - The real `RoleGuard` is reused verbatim — `@RequireRole(...)`
 *         is pure in-memory metadata evaluation.
 *   - APP_GUARD stacking: session → role → permission. Each guard is a
 *     no-op when its metadata is absent, so the stacking is safe.
 *       - Consumers who need OAuth2 coverage on a specific route should
 *         pair this module with
 *           `Test.createTestingModule(...).overrideGuard(OAuth2Guard).useValue(...)`
 *         — Nest's scanner unconditionally registers `@UseGuards(ClassRef)`
 *         as a class-keyed injectable, and the only supported override at
 *         that layer is Nest's testing utility.
 *   - Service stub overrides: `IdentityService`, `SessionService`,
 *     `PermissionService`, `TokenService`, `FlowService` all resolve via
 *     DI to their stub counterparts, so `@Inject(PermissionService)` needs
 *     zero consumer code changes.
 *   - `APP_GUARD` is registered by default. Pass `global: false` to opt
 *     out and wire guards per-route via `@UseGuards(...)`.
 *
 * The DynamicModule is always returned with `global: true` at the Nest
 * module-visibility level so the stub providers remain reachable via DI
 * from any controller the test imports.
 */
import { DynamicModule, Global, Module, Provider } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';

import { AUDIT_SINK, type AuditSink } from '../audit';
import type { IamAuditEvent } from '../dto';
import {
  OAuth2Guard,
  PermissionGuard,
  RoleGuard,
  SessionGuard,
} from '../guards';
import {
  FlowService,
  IdentityService,
  PermissionService,
  SessionService,
  TokenService,
} from '../services';

import { FakeOAuth2Guard } from './guards/fake-oauth2.guard';
import { FakePermissionGuard } from './guards/fake-permission.guard';
import { FakeSessionGuard } from './guards/fake-session.guard';
import { FlowStubService } from './services/flow-stub.service';
import { IdentityStubService } from './services/identity-stub.service';
import { PermissionStubService } from './services/permission-stub.service';
import { SessionStubService } from './services/session-stub.service';
import { TokenStubService } from './services/token-stub.service';
import {
  TESTING_STATE,
  TestingState,
  type IamTestingOptions,
} from './testing-state';

@Global()
@Module({})
export class IamTestingModule {
  public static forRoot(
    options: IamTestingOptions = {},
  ): DynamicModule {
    const state = new TestingState(options);
    const registerAppGuard = options.global !== false;

    // In-memory no-op AuditSink so RoleGuard (and any real guard consumers
    // wire) can resolve its `AUDIT_SINK` dependency without emitting to
    // console or hitting the consumer's production sink.
    const noopSink: AuditSink = {
      emit(_event: IamAuditEvent): void {
        void _event;
      },
    };

    const providers: Provider[] = [
      { provide: TESTING_STATE, useValue: state },
      { provide: AUDIT_SINK, useValue: noopSink },
      Reflector,
      // Real RoleGuard is fine — it's pure in-memory logic and only needs
      // `Reflector` + `AUDIT_SINK`, both of which we provide. `@RequireRole(...)`
      // therefore works out of the box under the testing module.
      RoleGuard,
      FakeSessionGuard,
      FakePermissionGuard,
      FakeOAuth2Guard,
      // Alias the real guard / service class tokens to the stubs so
      // `moduleRef.get(SessionGuard)` (and consumer code that does
      // `@Inject(SessionService)`) hands back the stub. Factory providers
      // are used (not `useClass`) so Nest doesn't redundantly construct
      // another instance — the stub is already sitting in DI.
      //
      // NOTE: this DI-layer alias does NOT cover the enhancer-layer
      // lookup Nest does for `@UseGuards(SessionGuard)` — that scanner
      // path registers the class as an injectable under its own token
      // and isn't overridable from a regular DynamicModule. Consumers
      // who use explicit `@UseGuards(...)` should either rely on APP_GUARD
      // (the default) or pair this module with `overrideGuard(...)`.
      {
        provide: SessionGuard,
        useFactory: (fake: FakeSessionGuard) => fake,
        inject: [FakeSessionGuard],
      },
      {
        provide: PermissionGuard,
        useFactory: (fake: FakePermissionGuard) => fake,
        inject: [FakePermissionGuard],
      },
      {
        provide: OAuth2Guard,
        useFactory: (fake: FakeOAuth2Guard) => fake,
        inject: [FakeOAuth2Guard],
      },
      // Swap service implementations behind the real tokens.
      { provide: IdentityService, useClass: IdentityStubService },
      { provide: SessionService, useClass: SessionStubService },
      { provide: PermissionService, useClass: PermissionStubService },
      { provide: TokenService, useClass: TokenStubService },
      { provide: FlowService, useClass: FlowStubService },
    ];

    if (registerAppGuard) {
      // APP_GUARD is a multi-injection token — register every stub / real
      // guard so routes carrying `@RequirePermission(...)` / `@RequireRole(...)`
      // are correctly evaluated without the consumer needing explicit
      // `@UseGuards(...)` decorators. Each guard is a no-op when its metadata
      // is absent, so stacking them is safe. Ordering matches production:
      // session first (populates `req.user`), then role + permission.
      providers.push(
        { provide: APP_GUARD, useExisting: FakeSessionGuard },
        { provide: APP_GUARD, useExisting: RoleGuard },
        { provide: APP_GUARD, useExisting: FakePermissionGuard },
      );
    }

    return {
      module: IamTestingModule,
      global: true,
      providers,
      exports: [
        TESTING_STATE,
        AUDIT_SINK,
        SessionGuard,
        RoleGuard,
        PermissionGuard,
        OAuth2Guard,
        IdentityService,
        SessionService,
        PermissionService,
        TokenService,
        FlowService,
      ],
    };
  }
}
