/**
 * HMAC-SHA256 signature verification for Oathkeeper envelope headers.
 *
 * Given the raw envelope header value, a signature (base64 or hex encoded),
 * and an allowlist of signer keys, try each key in order and return which key
 * index matched (if any). The index is useful for the caller to detect
 * rotation fall-through and log a one-time warning.
 *
 * Comparison is constant-time via `crypto.timingSafeEqual` on the decoded
 * bytes to avoid timing-oracle attacks on per-byte rejection.
 */
import * as crypto from 'crypto';

export interface SignatureVerificationResult {
  readonly ok: boolean;
  /** Zero-based index into the `keys` array that matched. Present iff ok. */
  readonly matchedKeyIndex?: number;
}

function decodeSignature(sig: string): Buffer | null {
  if (!sig) return null;
  // Try base64 first (the default).
  const b64 = Buffer.from(sig, 'base64');
  // Base64 decode is lenient — validate by re-encoding and comparing length
  // class. Accept if at least one standard hex-looking input also works.
  if (b64.length > 0 && b64.toString('base64').replace(/=+$/, '') === sig.replace(/=+$/, '')) {
    return b64;
  }
  // Try hex.
  if (/^[0-9a-fA-F]+$/.test(sig) && sig.length % 2 === 0) {
    return Buffer.from(sig, 'hex');
  }
  // Fall back to lenient base64 (non-roundtrip) only if the input is
  // obviously base64-ish (letters/digits/+/=/). Otherwise reject.
  if (/^[A-Za-z0-9+/=_-]+$/.test(sig)) {
    return b64.length > 0 ? b64 : null;
  }
  return null;
}

function safeEquals(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Verifies `signature` against HMAC-SHA256(`envelope`, key) for each key in
 * `keys`. Returns the first matching key index or `{ ok: false }`.
 */
export function verifyEnvelopeSignature(
  envelope: string,
  signature: string,
  keys: readonly string[],
): SignatureVerificationResult {
  if (!signature || keys.length === 0) return { ok: false };
  const provided = decodeSignature(signature);
  if (!provided) return { ok: false };
  for (let i = 0; i < keys.length; i++) {
    const expected = crypto
      .createHmac('sha256', keys[i])
      .update(envelope)
      .digest();
    if (safeEquals(expected, provided)) {
      return { ok: true, matchedKeyIndex: i };
    }
  }
  return { ok: false };
}
