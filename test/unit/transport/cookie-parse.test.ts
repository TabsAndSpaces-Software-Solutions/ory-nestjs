/**
 * Unit tests for the Cookie-header parser used by CookieTransport.
 */
import { extractCookie } from '../../../src/transport/cookie-parse';

describe('extractCookie', () => {
  it('returns undefined when the header is missing', () => {
    expect(extractCookie(undefined, 'ory_kratos_session')).toBeUndefined();
  });

  it('returns undefined when the header is empty', () => {
    expect(extractCookie('', 'ory_kratos_session')).toBeUndefined();
  });

  it('returns undefined when the named cookie is not present', () => {
    expect(
      extractCookie('foo=bar; baz=qux', 'ory_kratos_session'),
    ).toBeUndefined();
  });

  it('extracts the named cookie from a multi-cookie header', () => {
    expect(
      extractCookie(
        'a=1; b=2; ory_kratos_session=abc123; trailing=xyz',
        'ory_kratos_session',
      ),
    ).toBe('abc123');
  });

  it('extracts a cookie at the beginning of the header', () => {
    expect(extractCookie('ory_kratos_session=abc; x=1', 'ory_kratos_session')).toBe(
      'abc',
    );
  });

  it('extracts a cookie at the end of the header', () => {
    expect(extractCookie('x=1; ory_kratos_session=abc', 'ory_kratos_session')).toBe(
      'abc',
    );
  });

  it('decodes URI-encoded cookie values', () => {
    expect(extractCookie('foo=hello%20world', 'foo')).toBe('hello world');
  });

  it('skips malformed pairs without an equals sign', () => {
    expect(extractCookie('bogus; foo=bar', 'foo')).toBe('bar');
  });

  it('only matches exact cookie names (no prefix collisions)', () => {
    expect(
      extractCookie('ory_kratos_session_x=other; ory_kratos_session=correct', 'ory_kratos_session'),
    ).toBe('correct');
  });

  it('handles multiple spaces between cookie pairs gracefully', () => {
    expect(extractCookie('a=1;    b=2;   foo=bar', 'foo')).toBe('bar');
  });
});
