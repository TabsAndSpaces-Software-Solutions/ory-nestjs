/**
 * Unit tests for the abstract IamError base class.
 */
import {
  IamError,
  IamConfigurationError,
  IamUnauthorizedError,
  IamForbiddenError,
  IamUpstreamUnavailableError,
} from '../../../src/errors';

describe('IamError (base)', () => {
  it('is an abstract-style class — instantiating it directly throws', () => {
    // Using a concrete subclass ensures the base is abstract at the TS level;
    // runtime guard: the base constructor rejects direct `new IamError(...)`.
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new (IamError as any)({ message: 'x', code: 'Y' });
    }).toThrow(/abstract/i);
  });

  it('concrete subclasses extend Error and IamError', () => {
    const e = new IamConfigurationError({ message: 'bad config' });
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(IamError);
    expect(e).toBeInstanceOf(IamConfigurationError);
  });

  it('concrete subclasses expose code, message, optional correlationId & cause', () => {
    const cause = new Error('root');
    const e = new IamUnauthorizedError({
      message: 'nope',
      cause,
      correlationId: 'abc-123',
    });
    expect(e.code).toBe('IAM_UNAUTHORIZED');
    expect(e.message).toBe('nope');
    expect(e.correlationId).toBe('abc-123');
    expect(e.cause).toBe(cause);
    expect(e.name).toBe('IamUnauthorizedError');
  });

  it('codes are stable per subclass', () => {
    expect(new IamConfigurationError({ message: 'a' }).code).toBe(
      'IAM_CONFIGURATION',
    );
    expect(new IamUnauthorizedError({ message: 'a' }).code).toBe(
      'IAM_UNAUTHORIZED',
    );
    expect(new IamForbiddenError({ message: 'a' }).code).toBe('IAM_FORBIDDEN');
    expect(new IamUpstreamUnavailableError({ message: 'a' }).code).toBe(
      'IAM_UPSTREAM_UNAVAILABLE',
    );
  });

  it('toJSON() returns redacted shape with name/code/message and optional correlationId', () => {
    const e = new IamForbiddenError({
      message: 'blocked',
      correlationId: 'cid-1',
    });
    const json = e.toJSON();
    expect(json).toEqual({
      name: 'IamForbiddenError',
      code: 'IAM_FORBIDDEN',
      message: 'blocked',
      correlationId: 'cid-1',
    });
  });

  it('toJSON() omits correlationId when not provided', () => {
    const e = new IamForbiddenError({ message: 'blocked' });
    const json = e.toJSON();
    expect(json).toEqual({
      name: 'IamForbiddenError',
      code: 'IAM_FORBIDDEN',
      message: 'blocked',
    });
    expect(Object.prototype.hasOwnProperty.call(json, 'correlationId')).toBe(
      false,
    );
  });

  it('toJSON() does NOT traverse into cause (no upstream payload leaks)', () => {
    const cause: Record<string, unknown> = {
      response: {
        data: { token: 'eyJhbGciOiJIUzI1NiJ9.AAA.BBB' },
        headers: { authorization: 'Bearer secret' },
      },
    };
    const e = new IamUpstreamUnavailableError({
      message: 'Upstream IAM dependency unavailable',
      cause,
    });
    const json = JSON.stringify(e);
    expect(json).not.toMatch(/eyJ/);
    expect(json).not.toMatch(/secret/i);
    expect(json).not.toMatch(/Bearer/);
    expect(json).not.toMatch(/authorization/i);
    // positive: the generic message IS preserved
    expect(json).toMatch(/Upstream IAM dependency unavailable/);
  });

  it('JSON.stringify uses toJSON (correlationId round-trip)', () => {
    const e = new IamUnauthorizedError({
      message: 'Unauthorized upstream',
      correlationId: 'xyz',
    });
    const parsed = JSON.parse(JSON.stringify(e));
    expect(parsed).toEqual({
      name: 'IamUnauthorizedError',
      code: 'IAM_UNAUTHORIZED',
      message: 'Unauthorized upstream',
      correlationId: 'xyz',
    });
  });
});
