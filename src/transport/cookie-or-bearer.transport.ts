/**
 * CookieOrBearerTransport — tries cookie first, falls back to bearer.
 *
 * Composition rule: if the cookie transport resolves a non-null result (or
 * throws), that outcome is returned. Otherwise the bearer transport is tried.
 * If neither yields a result, returns `null`.
 */
import type { TenantConfig } from '../config';
import type { TenantClients } from '../clients';
import type { TenantName } from '../dto';
import { BearerTransport } from './bearer.transport';
import { CookieTransport } from './cookie.transport';
import type {
  RequestLike,
  ResolvedSession,
  SessionTransport,
} from './session-transport.interface';

export class CookieOrBearerTransport implements SessionTransport {
  private readonly cookie: CookieTransport;
  private readonly bearer: BearerTransport;

  public constructor(
    cookie: CookieTransport = new CookieTransport(),
    bearer: BearerTransport = new BearerTransport(),
  ) {
    this.cookie = cookie;
    this.bearer = bearer;
  }

  public async resolve(
    req: RequestLike,
    tenant: TenantClients,
    tenantName: TenantName,
    tenantConfig: TenantConfig,
  ): Promise<ResolvedSession | null> {
    const cookieResult = await this.cookie.resolve(req, tenant, tenantName, tenantConfig);
    if (cookieResult !== null) return cookieResult;
    return this.bearer.resolve(req, tenant, tenantName, tenantConfig);
  }

  public credentialFingerprint(
    req: RequestLike,
    tenantConfig: TenantConfig,
  ): string | null {
    // Mirror `resolve`'s precedence — cookie first, bearer fallback. The
    // inner transports already prefix their fingerprints with 'c:' / 'b:'
    // so cross-transport cache collisions are impossible.
    const cookieFp = this.cookie.credentialFingerprint(req, tenantConfig);
    if (cookieFp !== null) return cookieFp;
    return this.bearer.credentialFingerprint(req, tenantConfig);
  }
}
