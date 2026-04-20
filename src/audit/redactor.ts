/**
 * `Redactor` — recursively strips tokens, cookies, and PII from any payload
 * before it reaches a log or sink.
 *
 * Behavior:
 *   - Key-patterns match CASE-INSENSITIVELY on the full key name; matching
 *     keys have their value replaced with the literal string `[redacted]`
 *     and the redactor does NOT descend into them.
 *   - Value-patterns scan every string (and the final redacted replacement
 *     string) for JWT-shaped tokens and Ory session-token-shaped strings,
 *     replacing the substring with `[REDACTED_TOKEN]`.
 *   - Deep clones the input; circular refs are resolved via a `WeakSet`
 *     seen-set plus a `Map<original, clone>` so self-references round-trip
 *     without infinite recursion.
 *   - `addPattern(regex)` appends a key-pattern to this instance.
 *
 * This utility is deliberately framework-agnostic so it can be reused by
 * the error mapper, request-id middleware, and any other logging surface
 * later units introduce.
 */

export const REDACTED = '[redacted]';
export const REDACTED_TOKEN = '[REDACTED_TOKEN]';

/**
 * Default list of key-name regexes. All anchored with `^...$` and flagged
 * `/i` so the match is case-insensitive but never partial.
 */
export const DEFAULT_KEY_PATTERNS: readonly RegExp[] = Object.freeze([
  /^authorization$/i,
  /^cookie$/i,
  /^set-cookie$/i,
  /^ory_.*session.*$/i,
  /^session_token$/i,
  /^x-session-token$/i,
  /^api[_-]?key$/i,
  /^admin.*token$/i,
  /^access_?token$/i,
  /^refresh_?token$/i,
  /^token$/i,
  /^password$/i,
  /^traits$/i,
]);

/**
 * Value-patterns applied to every string. The JWT shape matches the classic
 * three-segment base64url pattern; the Ory session-token shape matches the
 * `ory_st_<long-base64url>` prefix Ory Kratos uses for session tokens.
 */
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const ORY_SESSION_TOKEN_RE = /\bory_st_[A-Za-z0-9_-]{16,}\b/g;

export class Redactor {
  private readonly keyPatterns: RegExp[];

  public constructor() {
    this.keyPatterns = [...DEFAULT_KEY_PATTERNS];
  }

  /**
   * Extend this redactor's key-pattern list. Per-instance; does not affect
   * other `Redactor` instances.
   */
  public addPattern(pattern: RegExp): void {
    this.keyPatterns.push(pattern);
  }

  /**
   * Deep-redact `value`, returning a new structure. The input is never
   * mutated. Circular references are resolved to the corresponding clone
   * node, so `a.self = a` round-trips to `out.self === out`.
   */
  public redact(value: unknown): unknown {
    const seen = new Map<object, unknown>();
    return this.redactValue(value, seen);
  }

  private redactValue(value: unknown, seen: Map<object, unknown>): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return this.redactString(value);
    if (typeof value !== 'object') return value;

    // object or array
    const obj = value as object;
    const cached = seen.get(obj);
    if (cached !== undefined) return cached;

    if (Array.isArray(value)) {
      const arr: unknown[] = [];
      seen.set(obj, arr);
      for (const item of value) {
        arr.push(this.redactValue(item, seen));
      }
      return arr;
    }

    const out: Record<string, unknown> = {};
    seen.set(obj, out);
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (this.matchesKey(k)) {
        out[k] = REDACTED;
      } else {
        out[k] = this.redactValue(v, seen);
      }
    }
    return out;
  }

  private matchesKey(key: string): boolean {
    for (const re of this.keyPatterns) {
      if (re.test(key)) return true;
    }
    return false;
  }

  private redactString(s: string): string {
    return s.replace(JWT_RE, REDACTED_TOKEN).replace(
      ORY_SESSION_TOKEN_RE,
      REDACTED_TOKEN,
    );
  }
}
