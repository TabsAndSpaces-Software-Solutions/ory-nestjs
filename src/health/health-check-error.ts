/**
 * `HealthCheckError` + `HealthIndicatorResult` — a duck-typed, self-contained
 * mimicry of the `@nestjs/terminus` contract.
 *
 * We deliberately do NOT take a runtime dependency on `@nestjs/terminus`:
 *   - The library must remain framework-agnostic beyond `@nestjs/common`.
 *   - Consumers who use terminus wire this indicator into their own
 *     `TerminusModule.forRootAsync({ indicators: [...] })`; terminus
 *     recognises the error structurally by `err.name === 'HealthCheckError'`
 *     and by the presence of `err.causes` alongside a matching
 *     `HealthIndicatorResult`.
 *   - Consumers who do NOT use terminus still get a fully typed
 *     `Error`-subclass with a machine-inspectable `causes` payload.
 *
 * Security note: the payload produced by `IamHealthIndicator` and wrapped by
 * this error must NEVER carry URLs, tokens, or headers. Aggregation only
 * names `tenant` + `product`. See `iam-health.indicator.ts` for the shape.
 */

/**
 * Terminus-compatible result shape: a single-keyed record whose key is the
 * indicator name (we default to `'ory-nestjs'`) and whose value describes the
 * aggregate status plus any library-specific attributes.
 */
export type HealthIndicatorResult = Record<
  string,
  { status: 'up' | 'down'; [key: string]: unknown }
>;

export class HealthCheckError extends Error {
  public readonly causes: HealthIndicatorResult;

  public constructor(message: string, causes: HealthIndicatorResult) {
    super(message);
    this.name = 'HealthCheckError';
    this.causes = causes;
    // Restore prototype chain across transpilation targets so
    // `instanceof HealthCheckError` keeps working through CJS/ESM hops.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
