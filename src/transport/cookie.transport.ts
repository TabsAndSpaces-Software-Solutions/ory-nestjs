/**
 * CookieTransport — resolves an identity/session from the `Cookie` header.
 *
 * Reads `tenant.kratos.sessionCookieName` from the HTTP `Cookie` header,
 * passes the full cookie string to `kratosFrontend.toSession({ cookie })`,
 * and maps the Ory response into library DTOs stamped with the tenant name.
 *
 * If the header is missing or the named cookie is absent, returns `null`.
 * Errors from Kratos bubble to the caller (SessionGuard) which delegates to
 * the central `ErrorMapper`.
 */
import type { Session as OrySession } from '@ory/client';
import { createHash } from 'node:crypto';

import type { TenantConfig } from '../config';
import type { TenantClients } from '../clients';
import type { TenantName } from '../dto';
import { identityMapper } from '../dto/mappers/identity.mapper';
import { sessionMapper } from '../dto/mappers/session.mapper';
import { extractCookie } from './cookie-parse';
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

export class CookieTransport implements SessionTransport {
  public async resolve(
    req: RequestLike,
    tenant: TenantClients,
    tenantName: TenantName,
    tenantConfig: TenantConfig,
  ): Promise<ResolvedSession | null> {
    const cookieHeader = firstHeaderValue(req.headers['cookie']);
    if (!cookieHeader) return null;

    const cookieName = tenantConfig.kratos.sessionCookieName;
    const cookieValue = extractCookie(cookieHeader, cookieName);
    if (!cookieValue) return null;

    const start = Date.now();
    const response = await tenant.kratosFrontend.toSession({ cookie: cookieHeader });
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
    tenantConfig: TenantConfig,
  ): string | null {
    const cookieHeader = firstHeaderValue(req.headers['cookie']);
    if (!cookieHeader) return null;
    const cookieValue = extractCookie(cookieHeader, tenantConfig.kratos.sessionCookieName);
    if (!cookieValue) return null;
    // Prefix with transport kind so cookie and bearer fingerprints can never
    // collide when the same tenant runs the `cookie-or-bearer` transport and
    // a client sends both credentials on the same request.
    return 'c:' + shortHash(cookieValue);
  }
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('base64url').slice(0, 32);
}
