/**
 * BearerTransport — resolves an identity/session from an
 * `Authorization: Bearer <token>` header.
 *
 * Parses the header, extracts the token, and calls
 * `kratosFrontend.toSession({ xSessionToken })`. Returns `null` if the
 * header is missing or does not use the Bearer scheme.
 */
import type { Session as OrySession } from '@ory/client';
import { createHash } from 'node:crypto';

import type { ValidatedTenantConfig } from '../config';
import type { TenantClients } from '../clients';
import type { TenantName } from '../dto';
import { identityMapper } from '../dto/mappers/identity.mapper';
import { sessionMapper } from '../dto/mappers/session.mapper';
import type {
  RequestLike,
  ResolvedSession,
  SessionTransport,
} from './session-transport.interface';

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

/**
 * Extract the token from an `Authorization: Bearer <token>` header.
 * Returns `undefined` if the scheme is missing, wrong, or the token is empty.
 * The scheme match is case-insensitive.
 */
function parseBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  const spaceIdx = trimmed.indexOf(' ');
  if (spaceIdx === -1) return undefined;
  const scheme = trimmed.slice(0, spaceIdx);
  if (scheme.toLowerCase() !== 'bearer') return undefined;
  const token = trimmed.slice(spaceIdx + 1).trim();
  return token.length > 0 ? token : undefined;
}

export class BearerTransport implements SessionTransport {
  public async resolve(
    req: RequestLike,
    tenant: TenantClients,
    tenantName: TenantName,
    _tenantConfig: ValidatedTenantConfig,
  ): Promise<ResolvedSession | null> {
    const authHeader = firstHeaderValue(req.headers['authorization']);
    const token = parseBearer(authHeader);
    if (!token) return null;

    const start = Date.now();
    const response = await tenant.kratosFrontend.toSession({ xSessionToken: token });
    const latencyMs = Date.now() - start;

    const orySession = (response as { data: OrySession }).data;
    const session = sessionMapper.fromOry(orySession, tenantName);
    const oryIdentity = orySession.identity;
    const identity = oryIdentity
      ? identityMapper.fromOry(oryIdentity, tenantName)
      : session.identity;

    return { identity, session, latencyMs };
  }

  public credentialFingerprint(
    req: RequestLike,
    _tenantConfig: ValidatedTenantConfig,
  ): string | null {
    const token = parseBearer(firstHeaderValue(req.headers['authorization']));
    if (!token) return null;
    return 'b:' + createHash('sha256').update(token).digest('base64url').slice(0, 32);
  }
}
