/**
 * JWT / JWKS verification for `OathkeeperTransport` in `verifier: 'jwt'`
 * mode.
 *
 * Why this is a separate module from `signature-verify.ts`:
 *   - `signature-verify.ts` handles the symmetric HMAC mode (shared
 *     secret). This file handles the asymmetric JWT mode (Oathkeeper's
 *     `id_token` mutator or any upstream that signs a JWS token).
 *   - Both are selected at config time via `oathkeeper.verifier`. The
 *     transport stays a single entry point; the verifier is the only
 *     thing that changes.
 *
 * Keys come from one of two sources:
 *   - Inline `oathkeeper.jwks.keys: JWK[]` — good for dev / tests / tiny
 *     deployments that don't want a network dependency.
 *   - Remote `oathkeeper.jwks.url` — fetched once and periodically
 *     refreshed. Refresh-on-verification-failure (cooldown-gated) covers
 *     key rotations that happen between periodic refreshes. A failed
 *     refresh does NOT fall back to "allow"; we fail closed.
 *
 * Claims we validate here:
 *   - Signature (mandatory)
 *   - `exp` — rejected if past `now + clockSkewMs`
 *   - `nbf` — rejected if `now + clockSkewMs` hasn't reached it yet
 *   - Algorithm — allowlisted via `oathkeeper.jwks.algorithms` (default
 *     `['RS256', 'ES256']`). `none` and HS* are always rejected here even
 *     if the allowlist is widened by mistake — HS* belongs in HMAC mode.
 *
 * Claims the transport validates (NOT here):
 *   - `aud` — matched against `oathkeeper.audience`
 *   - `jti` — checked against the replay cache
 *   - `iat` / `exp` beyond the baseline (tenant, expiresAt mapping)
 */
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
  type JWK,
  type JWTPayload,
} from 'jose';

export interface JwtVerifierOptions {
  readonly algorithms: readonly string[];
  readonly clockSkewSec: number;
}

/** Shape returned to the transport. Claims are passed through as-is. */
export interface VerifiedJwt {
  readonly payload: JWTPayload;
  readonly protectedHeader: { readonly alg?: string; readonly kid?: string };
}

/** Algorithms that should never be accepted in this mode. */
const FORBIDDEN_ALGS = new Set(['none', 'HS256', 'HS384', 'HS512']);

function sanitizeAlgorithms(algorithms: readonly string[]): string[] {
  const out: string[] = [];
  for (const alg of algorithms) {
    if (!FORBIDDEN_ALGS.has(alg)) out.push(alg);
  }
  if (out.length === 0) {
    throw new Error(
      'oathkeeper.jwks.algorithms must contain at least one asymmetric algorithm (RS*/ES*/EdDSA). ' +
        'HMAC algorithms (HS256/HS384/HS512) and "none" are not allowed in verifier=jwt mode.',
    );
  }
  return out;
}

/**
 * Abstract verifier shape so the transport can treat local and remote
 * JWKS identically.
 */
export interface JwtVerifier {
  verify(token: string, audience?: string | readonly string[]): Promise<VerifiedJwt>;
}

export function createInlineJwtVerifier(
  keys: readonly Record<string, unknown>[],
  options: JwtVerifierOptions,
): JwtVerifier {
  const jwks = createLocalJWKSet({ keys: keys as unknown as JWK[] });
  const algorithms = sanitizeAlgorithms(options.algorithms);
  return {
    async verify(token, audience) {
      const { payload, protectedHeader } = await jwtVerify(token, jwks, {
        algorithms,
        clockTolerance: options.clockSkewSec,
        audience: audience as string | string[] | undefined,
      });
      return { payload, protectedHeader };
    },
  };
}

export function createRemoteJwtVerifier(
  url: string,
  options: JwtVerifierOptions & { cooldownSec: number; refreshIntervalSec: number },
): JwtVerifier {
  const jwks = createRemoteJWKSet(new URL(url), {
    cooldownDuration: options.cooldownSec * 1000,
    cacheMaxAge: options.refreshIntervalSec * 1000,
  });
  const algorithms = sanitizeAlgorithms(options.algorithms);
  return {
    async verify(token, audience) {
      const { payload, protectedHeader } = await jwtVerify(token, jwks, {
        algorithms,
        clockTolerance: options.clockSkewSec,
        audience: audience as string | string[] | undefined,
      });
      return { payload, protectedHeader };
    },
  };
}
