/**
 * OathkeeperTransport — resolves an identity/session from pre-authenticated
 * headers forwarded by the Ory Oathkeeper proxy.
 *
 * Protocol:
 *   - `tenantConfig.oathkeeper.identityHeader` carries the envelope (plain
 *     JSON or base64-encoded JSON).
 *   - `tenantConfig.oathkeeper.signatureHeader` carries an HMAC-SHA256
 *     signature over the raw (pre-decoding) envelope header value.
 *   - `tenantConfig.oathkeeper.signerKeys` is the allowlist. The verifier
 *     tries each key in order; the first match wins. Fall-through to a
 *     non-primary key emits a one-time WARN per key (rotation telemetry
 *     without per-request noise).
 *
 * The transport never calls any Ory API — the identity is trusted because
 * Oathkeeper already authenticated the caller upstream. The guard is
 * responsible for checking envelope.tenant vs the tenant being evaluated.
 */
import { Logger } from '@nestjs/common';

import type { TenantConfig } from '../config';
import type { TenantClients } from '../clients';
import type {
  TenantName,
  IamIdentity,
  IamSession,
  IamVerifiedAddressesFlags,
} from '../dto';
import { deepFreeze } from '../dto/freeze';
import { IamUnauthorizedError } from '../errors';
import type {
  RequestLike,
  ResolvedSession,
  SessionTransport,
} from './session-transport.interface';
import { verifyEnvelopeSignature } from './signature-verify';

interface OathkeeperEnvelope {
  readonly id: string;
  readonly schemaId?: string;
  readonly state?: 'active' | 'inactive';
  readonly tenant?: string;
  readonly sessionId?: string;
  readonly expiresAt?: string;
  readonly verifiedAddressesFlags?: IamVerifiedAddressesFlags;
  readonly metadataPublic?: Record<string, unknown>;
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
  // Fallback: scan all keys for a case-insensitive match.
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return firstHeaderValue(headers[key]);
  }
  return undefined;
}

function decodeEnvelope(raw: string): OathkeeperEnvelope {
  // Detection: a leading `{` means plain JSON; otherwise treat as base64.
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

export class OathkeeperTransport implements SessionTransport {
  private readonly logger: Logger;
  private readonly warnedKeys = new Set<string>();

  public constructor(logger?: Logger) {
    this.logger = logger ?? new Logger('OryNestjs:OathkeeperTransport');
  }

  public async resolve(
    req: RequestLike,
    _tenant: TenantClients,
    tenantName: TenantName,
    tenantConfig: TenantConfig,
  ): Promise<ResolvedSession | null> {
    const oathkeeperCfg = tenantConfig.oathkeeper;
    if (!oathkeeperCfg) {
      throw new IamUnauthorizedError({ message: 'oathkeeper_misconfigured' });
    }

    const identityHeader = oathkeeperCfg.identityHeader;
    const signatureHeader = oathkeeperCfg.signatureHeader;
    const signerKeys = oathkeeperCfg.signerKeys;

    const envelopeRaw = readHeader(req.headers, identityHeader);
    if (!envelopeRaw) return null;

    const signature = readHeader(req.headers, signatureHeader);
    if (!signature) {
      throw new IamUnauthorizedError({ message: 'unsigned_header' });
    }

    const start = Date.now();
    const verification = verifyEnvelopeSignature(envelopeRaw, signature, signerKeys);
    if (!verification.ok) {
      throw new IamUnauthorizedError({ message: 'invalid_signature' });
    }

    // Rotation telemetry: warn once per non-primary key that verifies.
    if ((verification.matchedKeyIndex ?? 0) > 0) {
      const matchedKey = signerKeys[verification.matchedKeyIndex!];
      if (!this.warnedKeys.has(matchedKey)) {
        this.warnedKeys.add(matchedKey);
        this.logger.warn(
          `Oathkeeper signature verified against non-primary signer key (index=${verification.matchedKeyIndex}); rotation fall-through detected.`,
        );
      }
    }

    const envelope = decodeEnvelope(envelopeRaw);
    // Use the envelope's tenant claim (so the guard can detect cross-tenant
    // mismatch) — fall back to the tenant being evaluated if the envelope
    // does not declare one.
    const stampedTenant = envelope.tenant ?? tenantName;
    const identity = buildIdentity(envelope, stampedTenant);
    const session = buildSession(envelope, identity, stampedTenant);
    const latencyMs = Date.now() - start;

    return { identity, session, latencyMs };
  }

  public credentialFingerprint(
    _req: RequestLike,
    _tenantConfig: TenantConfig,
  ): string | null {
    // Oathkeeper transports opt out of caching: local signature verification
    // is already a microsecond-scale operation, and envelopes are per-request
    // — caching them offers no benefit and would only delay revocation of a
    // compromised signer key.
    return null;
  }
}
