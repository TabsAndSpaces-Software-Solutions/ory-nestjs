/**
 * Internal barrel for the health unit (spec unit `hlt`).
 *
 * Re-exports:
 *   - `IamHealthIndicator` — the terminus-compatible health indicator.
 *   - `HealthCheckError` — duck-typed mimicry of `@nestjs/terminus`'s
 *     error class. Consumers using terminus will receive this unchanged;
 *     consumers not using terminus still get an `Error` subclass with a
 *     machine-readable `causes` payload.
 *   - `HealthIndicatorResult` — the shared result shape.
 *
 * This is an INTERNAL barrel. The package's single public entry point is
 * `src/index.ts`; the module-assembly unit will consolidate these exports
 * there — this unit must NOT touch `src/index.ts`.
 */
export { IamHealthIndicator } from './iam-health.indicator';
export {
  HealthCheckError,
  type HealthIndicatorResult,
} from './health-check-error';
