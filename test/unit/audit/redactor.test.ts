/**
 * Unit tests for the `Redactor` utility.
 *
 * Covers:
 *   - default key-patterns (authorization, cookie, tokens, traits, etc.)
 *   - value-patterns (JWT and Ory session-token substrings)
 *   - circular refs
 *   - immutability of input
 *   - addPattern extension
 *   - nested structures and arrays
 */
import { Redactor } from '../../../src/audit';

const REDACTED = '[redacted]';
const REDACTED_TOKEN = '[REDACTED_TOKEN]';

const SAMPLE_JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.abcDEFghiJKLmnoPQRstuVWXyz-_09';
const SAMPLE_ORY_SESSION =
  'ory_st_abcdefghijklmnop_qrstuvwxyz0123456789ABCDEF';
const SAMPLE_HYDRA_ACCESS =
  'eyJhbGciOiJSUzI1NiIsImtpZCI6ImFiYyJ9.eyJleHAiOjE3MDB9.ZZZ-_09AAA';

describe('Redactor — default key patterns', () => {
  let redactor: Redactor;

  beforeEach(() => {
    redactor = new Redactor();
  });

  it('redacts top-level authorization key', () => {
    const out = redactor.redact({ authorization: 'Bearer abc' }) as Record<
      string,
      unknown
    >;
    expect(out.authorization).toBe(REDACTED);
  });

  it('redacts cookie / set-cookie / x-session-token headers (case-insensitive)', () => {
    const out = redactor.redact({
      Cookie: 'a=b',
      'Set-Cookie': 'x=y',
      'X-Session-Token': 'st-1',
    }) as Record<string, unknown>;
    expect(out.Cookie).toBe(REDACTED);
    expect(out['Set-Cookie']).toBe(REDACTED);
    expect(out['X-Session-Token']).toBe(REDACTED);
  });

  it('redacts session_token, token, access_token, refresh_token', () => {
    const out = redactor.redact({
      session_token: 'a',
      token: 'b',
      access_token: 'c',
      accessToken: 'c2',
      refresh_token: 'd',
      refreshToken: 'd2',
    }) as Record<string, unknown>;
    expect(out.session_token).toBe(REDACTED);
    expect(out.token).toBe(REDACTED);
    expect(out.access_token).toBe(REDACTED);
    expect(out.accessToken).toBe(REDACTED);
    expect(out.refresh_token).toBe(REDACTED);
    expect(out.refreshToken).toBe(REDACTED);
  });

  it('redacts api_key / apiKey / adminToken / password', () => {
    const out = redactor.redact({
      api_key: '1',
      apiKey: '2',
      adminToken: '3',
      password: 'hunter2',
    }) as Record<string, unknown>;
    expect(out.api_key).toBe(REDACTED);
    expect(out.apiKey).toBe(REDACTED);
    expect(out.adminToken).toBe(REDACTED);
    expect(out.password).toBe(REDACTED);
  });

  it('redacts ory_*_session* keys (e.g., ory_kratos_session_token)', () => {
    const out = redactor.redact({
      ory_kratos_session_token: 'x',
      ory_hydra_session: 'y',
    }) as Record<string, unknown>;
    expect(out.ory_kratos_session_token).toBe(REDACTED);
    expect(out.ory_hydra_session).toBe(REDACTED);
  });

  it('redacts the entire traits field (whole-field redaction)', () => {
    const out = redactor.redact({
      traits: { email: 'a@b.com', phone: '+1' },
    }) as Record<string, unknown>;
    expect(out.traits).toBe(REDACTED);
  });

  it('redacts nested occurrences of sensitive keys', () => {
    const out = redactor.redact({
      event: 'auth.success',
      attributes: {
        headers: { authorization: 'Bearer abc', cookie: 'ory_session=z' },
        nested: { token: 'deep' },
      },
    }) as {
      event: string;
      attributes: {
        headers: { authorization: string; cookie: string };
        nested: { token: string };
      };
    };
    expect(out.attributes.headers.authorization).toBe(REDACTED);
    expect(out.attributes.headers.cookie).toBe(REDACTED);
    expect(out.attributes.nested.token).toBe(REDACTED);
    expect(out.event).toBe('auth.success');
  });

  it('walks arrays and redacts inside each element', () => {
    const out = redactor.redact([
      { authorization: 'Bearer a' },
      { token: 'b' },
      'literal',
    ]) as Array<Record<string, unknown> | string>;
    expect((out[0] as Record<string, unknown>).authorization).toBe(REDACTED);
    expect((out[1] as Record<string, unknown>).token).toBe(REDACTED);
    expect(out[2]).toBe('literal');
  });

  it('leaves non-sensitive keys and primitives untouched', () => {
    const out = redactor.redact({
      event: 'auth.success',
      count: 3,
      ok: true,
    });
    expect(out).toEqual({ event: 'auth.success', count: 3, ok: true });
  });
});

describe('Redactor — value patterns (token-shaped substrings)', () => {
  let redactor: Redactor;

  beforeEach(() => {
    redactor = new Redactor();
  });

  it('strips JWT-shaped substrings from strings', () => {
    const out = redactor.redact(`prefix ${SAMPLE_JWT} suffix`) as string;
    expect(out).toContain(REDACTED_TOKEN);
    expect(out).not.toContain(SAMPLE_JWT);
    expect(out.startsWith('prefix ')).toBe(true);
    expect(out.endsWith(' suffix')).toBe(true);
  });

  it('strips Ory session-token-shaped substrings from strings', () => {
    const out = redactor.redact(
      `hello ${SAMPLE_ORY_SESSION} world`,
    ) as string;
    expect(out).toContain(REDACTED_TOKEN);
    expect(out).not.toContain(SAMPLE_ORY_SESSION);
  });

  it('strips Hydra-style JWT access-token substrings', () => {
    const out = redactor.redact(SAMPLE_HYDRA_ACCESS) as string;
    expect(out).toBe(REDACTED_TOKEN);
  });

  it('strips token-shaped substrings even inside nested string values', () => {
    const out = redactor.redact({
      message: `request failed with ${SAMPLE_JWT}`,
      other: SAMPLE_ORY_SESSION,
    }) as { message: string; other: string };
    expect(out.message).not.toContain(SAMPLE_JWT);
    expect(out.message).toContain(REDACTED_TOKEN);
    expect(out.other).toBe(REDACTED_TOKEN);
  });

  it('leaves ordinary strings unchanged', () => {
    const out = redactor.redact('nothing to redact here') as string;
    expect(out).toBe('nothing to redact here');
  });
});

describe('Redactor — robustness', () => {
  it('handles circular refs without throwing', () => {
    const redactor = new Redactor();
    const a: Record<string, unknown> = { foo: 'bar' };
    a.self = a;
    expect(() => redactor.redact(a)).not.toThrow();
    const out = redactor.redact(a) as Record<string, unknown>;
    expect(out.foo).toBe('bar');
    // The circular reference should resolve to a safe placeholder or to the
    // cloned parent — either way, no throw and no infinite recursion.
    expect(out).toHaveProperty('self');
  });

  it('does not mutate the input', () => {
    const redactor = new Redactor();
    const input = {
      authorization: 'Bearer abc',
      nested: { token: 'x', keep: 1 },
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    redactor.redact(input);
    expect(input).toEqual(snapshot);
  });

  it('returns a new object (not the same reference)', () => {
    const redactor = new Redactor();
    const input = { a: 1 };
    const out = redactor.redact(input);
    expect(out).not.toBe(input);
  });

  it('handles null and undefined', () => {
    const redactor = new Redactor();
    expect(redactor.redact(null)).toBeNull();
    expect(redactor.redact(undefined)).toBeUndefined();
  });
});

describe('Redactor — addPattern extension', () => {
  it('addPattern extends the default key-pattern list', () => {
    const redactor = new Redactor();
    redactor.addPattern(/^customSecret$/i);
    const out = redactor.redact({ customSecret: 'oops', keep: 'ok' }) as Record<
      string,
      unknown
    >;
    expect(out.customSecret).toBe(REDACTED);
    expect(out.keep).toBe('ok');
  });

  it('addPattern is per-instance (does not leak to siblings)', () => {
    const a = new Redactor();
    const b = new Redactor();
    a.addPattern(/^weird$/i);
    const outA = a.redact({ weird: 'x' }) as Record<string, unknown>;
    const outB = b.redact({ weird: 'x' }) as Record<string, unknown>;
    expect(outA.weird).toBe(REDACTED);
    expect(outB.weird).toBe('x');
  });
});
