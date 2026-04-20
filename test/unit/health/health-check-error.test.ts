/**
 * Unit tests for `HealthCheckError` — the duck-typed, terminus-compatible
 * error class emitted by `IamHealthIndicator` when one or more probes fail.
 *
 * Spec unit: `hlt`.
 *
 * The terminus contract we duck-type:
 *   - `new HealthCheckError(message, causes)`
 *   - `error.message` is the provided string
 *   - `error.name` is `'HealthCheckError'` (so `instanceof` works without
 *     depending on `@nestjs/terminus`)
 *   - `error.causes` is the provided `HealthIndicatorResult` payload
 *   - is a subclass of the built-in `Error`
 */
import 'reflect-metadata';

import {
  HealthCheckError,
  type HealthIndicatorResult,
} from '../../../src/health/health-check-error';

describe('HealthCheckError', () => {
  it('is an Error subclass', () => {
    const err = new HealthCheckError('down', {});
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(HealthCheckError);
  });

  it('carries the provided message', () => {
    const err = new HealthCheckError('ory-nestjs probe failed', {});
    expect(err.message).toBe('ory-nestjs probe failed');
  });

  it("sets name to 'HealthCheckError'", () => {
    const err = new HealthCheckError('x', {});
    expect(err.name).toBe('HealthCheckError');
  });

  it('exposes the causes payload unchanged', () => {
    const causes: HealthIndicatorResult = {
      'ory-nestjs': {
        status: 'down',
        tenants: { customer: { kratos_public: 'down' } },
      },
    };
    const err = new HealthCheckError('probe failed', causes);
    expect(err.causes).toBe(causes);
    expect(err.causes['ory-nestjs'].status).toBe('down');
  });
});
