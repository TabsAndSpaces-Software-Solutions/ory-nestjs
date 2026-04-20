/**
 * Barrel for the `ory-nestjs` testing harness.
 *
 * Exposes only the consumer-facing surface:
 *   - `IamTestingModule` — the `DynamicModule` tests import.
 *   - `IamTestingOptions` — the `forRoot` input shape.
 *   - `TESTING_STATE` + `TestingState` — to let tests mutate the in-memory
 *     state after module construction (e.g. `state.permissions.set(...)`).
 *
 * Stub implementations (guards + services) are deliberately NOT re-exported
 * — they are an internal contract of the testing module. Consumers should
 * rely on the real guard / service tokens and let DI swap in the stubs.
 *
 * Zero-Ory-leakage: nothing in `src/testing/**` imports from `@ory/*`.
 */
export { IamTestingModule } from './ory-nestjs-testing.module';
export {
  TESTING_STATE,
  TestingState,
  type IamTestingOptions,
} from './testing-state';
