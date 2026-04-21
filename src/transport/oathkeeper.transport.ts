/**
 * OathkeeperTransport — resolves an identity/session from pre-authenticated
 * headers forwarded by the Ory Oathkeeper proxy.
 *
 * Supports two verifier modes, selected via `tenantConfig.oathkeeper.verifier`:
 *
 *   1. `'hmac'` (default) — symmetric: the identity header carries a plain
 *      JSON or base64-encoded envelope, and a separate signature header
 *      carries an HMAC-SHA256 digest over the raw envelope. `signerKeys[]`
 *      is the allowlist; first match wins; non-primary matches emit a
 *      one-time WARN for rotation telemetry.
 *
 *   2. `'jwt'` (new, zero-trust with asymmetric keys) — the identity
 *      header carries a signed JWT (Oathkeeper `id_token` mutator output
 *      is the canonical producer). JWKS is sourced inline from
 *      `oathkeeper.jwks.keys` or fetched from `oathkeeper.jwks.url` with
 *      periodic refresh and cooldown-gated refresh-on-failure. `jose`
 *      handles signature verification, algorithm allowlisting, and
 *      baseline claim checks (exp, nbf) with configurable clock skew.
 *
 * Shared protections (both modes):
 *   - Envelope expiry: the library-owned `expiresAt` (ISO8601) or the JWT
 *     `exp` (unix seconds) is enforced against `Date.now() +
 *     clockSkewMs`. Expired → emit `auth.failure.expired` → 401.
 *   - Audience: `oathkeeper.audience` (string or string[]) is matched
 *     against envelope.audience / JWT `aud`. First overlap wins. No
 *     match → emit `auth.failure.audience_mismatch` → 401.
 *   - Anti-replay: when `replayProtection.enabled` is true, the envelope
 *     MUST carry a `jti` string. The transport asks the injected
 *     `ReplayCache` whether this jti has been seen; on hit, emit
 *     `auth.failure.replay` → 401. On miss, the jti is remembered for
 *     `replayProtection.ttlMs`. A cache backend failure fails CLOSED.
 *   - Tenant binding: the envelope's `tenant` claim (when present) flows
 *     into the returned session.tenant so SessionGuard's cross-tenant
 *     check remains authoritative.
 *
 * The transport never calls any Ory API — identity is trusted only after
 * cryptographic verification of the envelope. This keeps the per-request
 * latency microsecond-scale and removes any network dependency on the
 * IDP on the hot path.
 */
import { Logger } from '@nestjs/common';

import type { ValidatedTenantConfig } from '../config';
import type { TenantClients } from '../clients';
import type {
  TenantName,
  IamIdentity,
  IamSession,
  IamVerifiedAddressesFlags,
} from '../dto';
import { deepFreeze } from '../dto/freeze';
import { IamUnauthorizedError } from '../errors';
import type { ReplayCache } from '../cache/replay-cache.interface';
import type {
  RequestLike,
  ResolvedSession,
  SessionTransport,
} from './session-transport.interface';
import { verifyEnvelopeSignature } from './signature-verify';
import {
  createInlineJwtVerifier,
  createRemoteJwtVerifier,
  type JwtVerifier,
} from './jwt-verify';

interface OathkeeperEnvelope {
  readonly id: string;
  readonly schemaId?: string;
  readonly state?: 'active' | 'inactive';
  readonly tenant?: string;
  readonly sessionId?: string;
  readonly expiresAt?: string;
  readonly verifiedAddressesFlags?: IamVerifiedAddressesFlags;
  readonly metadataPublic?: Record<string, unknown>;
  /** Claim for anti-replay protection (required when replayProtection is on). */
  readonly jti?: string;
  /** Claim for audience scoping. String or string[]. */
  readonly audience?: string | readonly string[];
}

function firstHeaderValue(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (Array.isArray(v)) {
    for (const entry of v) {
      if (typeof entry === 'string' && entry.length > 0) return entry;
    }
    return undefined;
  }
  return v;
}

function readHeader(
  headers: RequestLike['headers'],
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  const direct = headers[lower];
  if (direct !== undefined) return firstHeaderValue(direct);
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return firstHeaderValue(headers[key]);
  }
  return undefined;
}

function decodeEnvelope(raw: string): OathkeeperEnvelope {
  const firstChar = raw.trimStart().charAt(0);
  let json: string;
  if (firstChar === '{') {
    json = raw;
  } else {
    try {
      json = Buffer.from(raw, 'base64').toString('utf8');
    } catch {
      throw new IamUnauthorizedError({ message: 'malformed_envelope' });
    }
  }
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('envelope is not an object');
    }
    const asObj = parsed as Record<string, unknown>;
    if (typeof asObj.id !== 'string' || asObj.id.length === 0) {
      throw new Error('envelope.id missing');
    }
    return asObj as unknown as OathkeeperEnvelope;
  } catch (cause) {
    throw new IamUnauthorizedError({ message: 'malformed_envelope', cause });
  }
}

/**
 * Normalize a JWT payload into the shape the transport consumes
 * downstream. Keys are mapped from JWT-standard claims where obvious.
 */
function envelopeFromJwt(payload: Record<string, unknown>): OathkeeperEnvelope {
  const subject = payload.sub;
  const id = typeof subject === 'string' && subject.length > 0
    ? subject
    : typeof payload.id === 'string'
      ? (payload.id as string)
      : '';
  if (id.length === 0) {
    throw new IamUnauthorizedError({ message: 'malformed_envelope' });
  }
  // expiresAt comes from JWT `exp` (seconds since epoch) — convert to ISO.
  let expiresAt: string | undefined;
  if (typeof payload.exp === 'number') {
    expiresAt = new Date(payload.exp * 1000).toISOString();
  } else if (typeof payload.expiresAt === 'string') {
    expiresAt = payload.expiresAt;
  }
  const jti = typeof payload.jti === 'string' ? payload.jti : undefined;
  const audience = payload.aud as OathkeeperEnvelope['audience'];
  const tenant = typeof payload.tenant === 'string' ? payload.tenant : undefined;
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : undefined;
  const schemaId = typeof payload.schemaId === 'string' ? payload.schemaId : undefined;
  const state = payload.state === 'active' || payload.state === 'inactive' ? payload.state : undefined;
  const vaf = payload.verifiedAddressesFlags as OathkeeperEnvelope['verifiedAddressesFlags'];
  const metadataPublic = (payload.metadataPublic && typeof payload.metadataPublic === 'object')
    ? (payload.metadataPublic as Record<string, unknown>)
    : undefined;
  return { id, schemaId, state, tenant, sessionId, expiresAt, verifiedAddressesFlags: vaf, metadataPublic, jti, audience };
}

function isExpired(envelope: OathkeeperEnvelope, clockSkewMs: number): boolean {
  if (!envelope.expiresAt) return false;
  const parsed = Date.parse(envelope.expiresAt);
  if (Number.isNaN(parsed)) return false;
  return parsed + clockSkewMs <= Date.now();
}

function audienceAllowed(
  claim: OathkeeperEnvelope['audience'],
  allowed: string | readonly string[] | undefined,
): boolean {
  if (allowed === undefined) return true;
  if (claim === undefined) return false;
  const claimList = Array.isArray(claim) ? claim : [claim];
  const allowedList = Array.isArray(allowed) ? allowed : [allowed];
  for (const c of claimList) {
    if (typeof c !== 'string') continue;
    for (const a of allowedList) {
      if (c === a) return true;
    }
  }
  return false;
}

function buildIdentity(
  env: OathkeeperEnvelope,
  tenant: TenantName,
): IamIdentity {
  const flags: IamVerifiedAddressesFlags = env.verifiedAddressesFlags ?? {
    email: false,
    phone: false,
  };
  const base: Omit<IamIdentity, 'metadataPublic'> & { metadataPublic?: Record<string, unknown> } = {
    id: env.id,
    schemaId: env.schemaId ?? 'default',
    state: env.state === 'active' ? 'active' : 'inactive',
    verifiedAddressesFlags: { email: flags.email === true, phone: flags.phone === true },
    tenant,
  };
  if (env.metadataPublic && typeof env.metadataPublic === 'object') {
    base.metadataPublic = env.metadataPublic;
  }
  return deepFreeze(base as IamIdentity);
}

function buildSession(
  env: OathkeeperEnvelope,
  identity: IamIdentity,
  tenant: TenantName,
): IamSession {
  const session: IamSession = {
    id: env.sessionId ?? `oathkeeper:${env.id}`,
    active: true,
    expiresAt: env.expiresAt ?? '',
    authenticatedAt: new Date().toISOString(),
    authenticationMethods: ['oathkeeper'],
    identity,
    tenant,
  };
  return deepFreeze(session);
}

/**
 * One verifier instance is built per tenant and cached on the transport.
 * This avoids re-building the JWKS fetcher on every request.
 */
type JwtCfg = NonNullable<ValidatedTenantConfig['oathkeeper']>;

export class OathkeeperTransport implements SessionTransport {
  private readonly logger: Logger;
  private readonly warnedKeys = new Set<string>();
  private readonly jwtVerifierByTenant = new Map<TenantName, JwtVerifier>();

  public constructor(
    private readonly replayCache?: ReplayCache,
    logger?: Logger,
  ) {
    this.logger = logger ?? new Logger('OryNestjs:OathkeeperTransport');
  }

  public async resolve(
    req: RequestLike,
    _tenant: TenantClients,
    tenantName: TenantName,
    tenantConfig: ValidatedTenantConfig,
  ): Promise<ResolvedSession | null> {
    const oathkeeperCfg = tenantConfig.oathkeeper;
    if (!oathkeeperCfg) {
      throw new IamUnauthorizedError({ message: 'oathkeeper_misconfigured' });
    }

    const identityHeader = oathkeeperCfg.identityHeader;
    let envelopeRaw = readHeader(req.headers, identityHeader);
    if (!envelopeRaw) return null;

    // Oathkeeper's `id_token` mutator writes the JWT to the upstream as
    // `Authorization: Bearer <jwt>` — that prefix is not user-configurable.
    // Strip it in JWT mode so the raw token reaches `jose.jwtVerify`. HMAC
    // mode envelopes are opaque JSON/base64 — never prefixed — so we leave
    // them alone.
    if (oathkeeperCfg.verifier === 'jwt') {
      const m = /^Bearer\s+(.+)$/i.exec(envelopeRaw);
      if (m) envelopeRaw = m[1];
    }

    const start = Date.now();
    const envelope: OathkeeperEnvelope =
      oathkeeperCfg.verifier === 'jwt'
        ? await this.verifyJwtAndExtractEnvelope(envelopeRaw, tenantName, oathkeeperCfg)
        : this.verifyHmacAndDecodeEnvelope(envelopeRaw, req, oathkeeperCfg);

    // Expiry — enforced in both modes. For JWT mode, jose already enforced
    // `exp`; we double-check here against our own clock-skew config, and
    // this is also the one source of truth when an envelope carries only
    // an ISO expiresAt (HMAC mode).
    const clockSkewMs = oathkeeperCfg.clockSkewMs;
    if (isExpired(envelope, clockSkewMs)) {
      throw new IamUnauthorizedError({ message: 'expired' });
    }

    // Audience — optional. When configured, missing or unmatched → reject.
    if (!audienceAllowed(envelope.audience, oathkeeperCfg.audience)) {
      throw new IamUnauthorizedError({ message: 'audience_mismatch' });
    }

    // Anti-replay — optional. Requires a jti in the envelope and a
    // ReplayCache provided via DI.
    if (oathkeeperCfg.replayProtection?.enabled === true) {
      await this.enforceReplayProtection(envelope, oathkeeperCfg.replayProtection.ttlMs);
    }

    const stampedTenant = envelope.tenant ?? tenantName;
    const identity = buildIdentity(envelope, stampedTenant);
    const session = buildSession(envelope, identity, stampedTenant);
    const latencyMs = Date.now() - start;

    return { identity, session, latencyMs };
  }

  public credentialFingerprint(
    _req: RequestLike,
    _tenantConfig: ValidatedTenantConfig,
  ): string | null {
    return null;
  }

  /* ─────────────────────────── verifier paths ───────────────────────── */

  private verifyHmacAndDecodeEnvelope(
    envelopeRaw: string,
    req: RequestLike,
    cfg: JwtCfg,
  ): OathkeeperEnvelope {
    const signature = readHeader(req.headers, cfg.signatureHeader);
    if (!signature) {
      throw new IamUnauthorizedError({ message: 'unsigned_header' });
    }
    const signerKeys = cfg.signerKeys;
    if (!signerKeys || signerKeys.length === 0) {
      // Guarded by schema, but fail closed if it somehow leaks through.
      throw new IamUnauthorizedError({ message: 'oathkeeper_misconfigured' });
    }
    const result = verifyEnvelopeSignature(envelopeRaw, signature, signerKeys);
    if (!result.ok) {
      throw new IamUnauthorizedError({ message: 'invalid_signature' });
    }
    if ((result.matchedKeyIndex ?? 0) > 0) {
      const matchedKey = signerKeys[result.matchedKeyIndex!];
      if (!this.warnedKeys.has(matchedKey)) {
        this.warnedKeys.add(matchedKey);
        this.logger.warn(
          `Oathkeeper signature verified against non-primary signer key (index=${result.matchedKeyIndex}); rotation fall-through detected.`,
        );
      }
    }
    return decodeEnvelope(envelopeRaw);
  }

  private async verifyJwtAndExtractEnvelope(
    token: string,
    tenantName: TenantName,
    cfg: JwtCfg,
  ): Promise<OathkeeperEnvelope> {
    const verifier = this.jwtVerifierFor(tenantName, cfg);
    let verified;
    try {
      verified = await verifier.verify(token, cfg.audience);
    } catch (cause) {
      // jose throws typed errors with a stable `code` property. Map them
      // to our coarser audit vocabulary; anything else (including code=
      // 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' / missing-kid / algorithm-
      // not-allowlisted) collapses into `invalid_signature`.
      const code = (cause as { code?: string })?.code;
      const claim = (cause as { claim?: string })?.claim;
      if (code === 'ERR_JWT_EXPIRED') {
        throw new IamUnauthorizedError({ message: 'expired', cause });
      }
      if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' && claim === 'aud') {
        throw new IamUnauthorizedError({ message: 'audience_mismatch', cause });
      }
      throw new IamUnauthorizedError({ message: 'invalid_signature', cause });
    }
    return envelopeFromJwt(verified.payload);
  }

  private jwtVerifierFor(tenantName: TenantName, cfg: JwtCfg): JwtVerifier {
    const existing = this.jwtVerifierByTenant.get(tenantName);
    if (existing) return existing;
    if (!cfg.jwks) {
      throw new IamUnauthorizedError({ message: 'oathkeeper_misconfigured' });
    }
    const options = {
      algorithms: cfg.jwks.algorithms,
      clockSkewSec: Math.ceil(cfg.clockSkewMs / 1000),
    };
    const verifier =
      cfg.jwks.url !== undefined
        ? createRemoteJwtVerifier(cfg.jwks.url, {
            ...options,
            cooldownSec: Math.ceil(cfg.jwks.cooldownMs / 1000),
            refreshIntervalSec: Math.ceil(cfg.jwks.refreshIntervalMs / 1000),
          })
        : createInlineJwtVerifier(cfg.jwks.keys ?? [], options);
    this.jwtVerifierByTenant.set(tenantName, verifier);
    return verifier;
  }

  private async enforceReplayProtection(
    envelope: OathkeeperEnvelope,
    ttlMs: number,
  ): Promise<void> {
    if (!envelope.jti) {
      // Replay protection enabled but envelope lacks jti — refuse.
      throw new IamUnauthorizedError({ message: 'replay_jti_missing' });
    }
    if (!this.replayCache) {
      // Enabled but no cache wired — fail closed.
      throw new IamUnauthorizedError({ message: 'replay_cache_unavailable' });
    }
    let seen: boolean;
    try {
      seen = await this.replayCache.seen(envelope.jti);
    } catch (cause) {
      // Fail closed on backend errors. Surface as 503 by throwing an
      // upstream-unavailable-ish message? The consumer's error mapper
      // maps IamUnauthorizedError → 401, which is the safer default —
      // 503 could be probed by attackers to infer cache state.
      throw new IamUnauthorizedError({ message: 'replay_cache_error', cause });
    }
    if (seen) {
      throw new IamUnauthorizedError({ message: 'replay' });
    }
    try {
      await this.replayCache.remember(envelope.jti, ttlMs);
    } catch (cause) {
      throw new IamUnauthorizedError({ message: 'replay_cache_error', cause });
    }
  }
}
