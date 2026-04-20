/**
 * Verifies that the library's public entry point (`src/index.ts`) re-exports
 * the error hierarchy and the ErrorMapper. The existing public-surface test
 * already enforces the no-@ory/ rule — this one ensures the err-unit symbols
 * are reachable from the barrel.
 */
import * as publicSurface from '../../../src';

describe('src/index.ts — error hierarchy exports', () => {
  it('exports IamError', () => {
    expect(typeof (publicSurface as Record<string, unknown>).IamError).toBe(
      'function',
    );
  });

  it('exports each concrete subclass', () => {
    const mod = publicSurface as Record<string, unknown>;
    expect(typeof mod.IamConfigurationError).toBe('function');
    expect(typeof mod.IamUnauthorizedError).toBe('function');
    expect(typeof mod.IamForbiddenError).toBe('function');
    expect(typeof mod.IamUpstreamUnavailableError).toBe('function');
  });

  it('exports ErrorMapper', () => {
    expect(typeof (publicSurface as Record<string, unknown>).ErrorMapper).toBe(
      'function',
    );
  });

  it('exported subclasses instantiate and carry the right codes', () => {
    const mod = publicSurface as unknown as Record<
      string,
      new (init: { message: string }) => { code: string }
    >;
    expect(new mod.IamConfigurationError({ message: 'x' }).code).toBe(
      'IAM_CONFIGURATION',
    );
    expect(new mod.IamUnauthorizedError({ message: 'x' }).code).toBe(
      'IAM_UNAUTHORIZED',
    );
    expect(new mod.IamForbiddenError({ message: 'x' }).code).toBe(
      'IAM_FORBIDDEN',
    );
    expect(new mod.IamUpstreamUnavailableError({ message: 'x' }).code).toBe(
      'IAM_UPSTREAM_UNAVAILABLE',
    );
  });
});
