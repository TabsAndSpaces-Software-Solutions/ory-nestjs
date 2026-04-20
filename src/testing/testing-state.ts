/**
 * `TestingState` — the single source of truth shared by every stub the
 * `IamTestingModule` installs.
 *
 * Design notes:
 *   - Injectable via the global-symbol token `TESTING_STATE`. Symbol.for
 *     guarantees identity stability across module reloads in jest's
 *     isolate-per-test harness.
 *   - Mutable on purpose: tests poke `state.permissions.set('ns:rel:obj',
 *     true)` after module construction and the change is visible on the
 *     next guard invocation. Stubs hold the Map references, not copies.
 *   - No network I/O, no Ory imports. The class is pure data.
 *   - The constructor normalizes plain-object inputs (`permissions`,
 *     `introspections`) into `Map` form so downstream stubs only need to
 *     speak one shape. `identityStore` is already a Map on input but we
 *     shallow-copy it so caller mutations after module construction don't
 *     leak (the spec lets tests reach in via `TESTING_STATE` instead).
 */
import type {
  IamIdentity,
  IamIdentityWithTraits,
  IamTokenIntrospection,
} from '../dto';

/** Options passed to `IamTestingModule.forRoot(...)`. */
export interface IamTestingOptions {
  /** Fixture identity injected into every guarded request. */
  identity?: IamIdentity | IamIdentityWithTraits;

  /**
   * Map keyed by the canonical `namespace:relation:object` string; controls
   * the answers returned by the in-memory `PermissionGuard` /
   * `PermissionService.check` stubs.
   */
  permissions?: Record<string, boolean>;

  /**
   * Map token strings → introspection results. Consumed by the OAuth2 guard
   * stub and by the `TokenService.introspect` stub.
   */
  introspections?: Record<string, IamTokenIntrospection>;

  /**
   * Seed for `IdentityService`: keyed by `identity.id`. The stub reads from
   * this map on `.get` / `.getWithTraits`.
   */
  identityStore?: Map<string, IamIdentityWithTraits>;

  /**
   * When true (the default), registers `APP_GUARD = FakeSessionGuard` so
   * every route in the test app is authenticated unless `@Public()` /
   * `@Anonymous()` is present. Set to `false` to opt out and wire guards
   * per-route via `@UseGuards(...)`.
   */
  global?: boolean;
}

/**
 * Shared mutable state object. Not decorated with `@Injectable()` — it is
 * bound to the DI container via `{ provide: TESTING_STATE, useValue: ... }`.
 */
export class TestingState {
  /** The fixture identity (if any). Stubs mirror this into `req.user`. */
  public identity?: IamIdentity | IamIdentityWithTraits;

  /** `namespace:relation:object` → allow/deny. */
  public readonly permissions: Map<string, boolean>;

  /** Bearer-token string → introspection result. */
  public readonly introspections: Map<string, IamTokenIntrospection>;

  /** `identity.id` → full identity-with-traits record. */
  public readonly identityStore: Map<string, IamIdentityWithTraits>;

  constructor(o: IamTestingOptions = {}) {
    this.identity = o.identity;
    this.permissions = new Map<string, boolean>();
    if (o.permissions) {
      for (const [k, v] of Object.entries(o.permissions)) {
        this.permissions.set(k, v);
      }
    }
    this.introspections = new Map<string, IamTokenIntrospection>();
    if (o.introspections) {
      for (const [k, v] of Object.entries(o.introspections)) {
        this.introspections.set(k, v);
      }
    }
    this.identityStore = o.identityStore
      ? new Map(o.identityStore)
      : new Map<string, IamIdentityWithTraits>();
  }
}

/**
 * DI token for the shared `TestingState`. Consumers retrieve the state via
 * `moduleRef.get<TestingState>(TESTING_STATE)` and mutate it at runtime.
 */
export const TESTING_STATE: unique symbol = Symbol.for(
  'ory-nestjs/testing-state',
);

/** Canonical key shape shared by stubs — namespace:relation:object. */
export function permissionKey(
  namespace: string,
  relation: string,
  object: string,
): string {
  return `${namespace}:${relation}:${object}`;
}
