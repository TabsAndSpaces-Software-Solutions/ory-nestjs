/**
 * Async-registration options for `IamModule.forRootAsync`.
 *
 * Mirrors the NestJS convention used throughout the ecosystem
 * (`TypeOrmModule.forRootAsync`, `MongooseModule.forRootAsync`, etc.): a
 * consumer may supply exactly one of `useFactory` / `useClass` / `useExisting`.
 *
 *   - `useFactory`: a function (sync or async) that returns `IamOptions`.
 *     Dependencies consumed by the factory must be listed in `inject` and
 *     provided by a module named in `imports`.
 *   - `useClass`: a class whose `createIamOptions()` method returns the
 *     options. Nest instantiates the class in the module's scope.
 *   - `useExisting`: a DI token resolving to an already-registered provider
 *     exposing `createIamOptions()`.
 *
 * The raw options are then run through `ConfigLoader.load()` so defaults,
 * freezing, and error formatting stay consistent with `forRoot`.
 *
 * ### Semantics of `IamOptions.global`
 *
 * The `global` flag on `IamOptions` controls ONLY the registration of
 * `APP_GUARD = SessionGuard`. It does NOT change NestJS module visibility
 * — `IamModule` is always declared as a global DynamicModule so its
 * guards and services (including `SessionGuard` and its internal
 * `TENANT_REGISTRY` dependency) remain injectable from any consumer
 * module.
 *
 *   - `global: true` (default) — registers `SessionGuard` as an
 *     `APP_GUARD`, so every controller route is authenticated by default.
 *     Opt-out per route with `@Public()` / `@Anonymous()`.
 *   - `global: false` — does NOT register `APP_GUARD`. Consumers must
 *     apply `@UseGuards(SessionGuard)` on any route that requires a
 *     session. Because the module is still globally visible, this works
 *     without the consumer importing `IamModule` into every feature
 *     module.
 */
import type {
  InjectionToken,
  ModuleMetadata,
  OptionalFactoryDependency,
  Type,
} from '@nestjs/common';

import type { IamOptions } from '../config';

/**
 * Factory contract for `useClass` / `useExisting` bindings.
 */
export interface IamOptionsFactory {
  createIamOptions():
    | Promise<IamOptions>
    | IamOptions;
}

/**
 * Async-registration options accepted by `IamModule.forRootAsync`.
 *
 * Only `useFactory` / `useClass` / `useExisting` are supported; `imports`
 * is forwarded to the dynamic-module metadata so the factory can depend on
 * consumer-defined modules (e.g. a ConfigModule).
 */
export interface IamAsyncOptions
  extends Pick<ModuleMetadata, 'imports'> {
  /**
   * Factory returning the raw options. May be async. The parameter list is
   * intentionally typed as `any[]` to match NestJS's `FactoryProvider` shape
   * — consumers supply tokens via `inject` and their types flow through
   * their factory signature.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useFactory?: (...args: any[]) => Promise<IamOptions> | IamOptions;

  /**
   * DI tokens injected into `useFactory`. Ignored when `useFactory` is not
   * provided.
   */
  inject?: ReadonlyArray<InjectionToken | OptionalFactoryDependency>;

  /**
   * Class implementing `IamOptionsFactory`. Nest instantiates it.
   */
  useClass?: Type<IamOptionsFactory>;

  /**
   * Existing DI token resolving to a `IamOptionsFactory`.
   */
  useExisting?: Type<IamOptionsFactory>;
}
