/**
 * `SessionTransport` — strategy interface that resolves an identity from an
 * inbound HTTP request per the tenant's configured transport.
 *
 * Implementations live alongside this file (`cookie.transport.ts`,
 * `bearer.transport.ts`, `cookie-or-bearer.transport.ts`,
 * `oathkeeper.transport.ts`). The factory (`transport.factory.ts`) picks
 * the right implementation based on `tenant.config.transport`.
 *
 * This is the ONLY place in the library allowed to read raw cookies or
 * headers off the request.
 */
import type { ValidatedTenantConfig } from '../config';
import type { TenantClients } from '../clients';
import type { TenantName, IamIdentity, IamSession } from '../dto';

/**
 * Loose request shape — no dependency on Express types so the library can
 * run under any NestJS adapter. Headers may be a string, a repeated string
 * array, or absent.
 */
export interface RequestLike {
  readonly headers: Record<string, string | string[] | undefined>;
}

export interface ResolvedSession {
  readonly identity: IamIdentity;
  readonly session: IamSession;
  /** Wall-clock latency of the upstream call in ms. */
  readonly latencyMs: number;
  /**
   * `true` when this result was served from the session cache rather than a
   * live upstream call. Present so the guard can surface cache hit-rate via
   * audit attributes. Absent (undefined) on transports that are not cached.
   */
  readonly fromCache?: boolean;
}

export interface SessionTransport {
  resolve(
    req: RequestLike,
    tenant: TenantClients,
    tenantName: TenantName,
    tenantConfig: ValidatedTenantConfig,
  ): Promise<ResolvedSession | null>;

  /**
   * Compute a stable, tenant-agnostic fingerprint of the credential this
   * transport would authenticate against on `req`, WITHOUT making any
   * upstream call. Return `null` when:
   *   - the request carries no usable credential (→ `resolve` will also
   *     return null, so skipping the cache lookup saves a hash),
   *   - the transport opts out of caching entirely (e.g. OathkeeperTransport
   *     is already a local verification and the envelope is ephemeral).
   *
   * The fingerprint is combined with the tenant name by the caching
   * decorator to produce the final cache key. Implementations MUST NOT
   * include any data derived from the identity or session — the transport
   * has not authenticated the request at this point.
   *
   * Optional: implementations without a fingerprint are simply not cached.
   */
  credentialFingerprint?(
    req: RequestLike,
    tenantConfig: ValidatedTenantConfig,
  ): string | null;
}
