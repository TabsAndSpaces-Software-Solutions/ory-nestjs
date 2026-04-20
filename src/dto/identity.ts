/**
 * Library-owned identity DTOs.
 *
 * `IamIdentity` is the sanitized projection consumers see by default —
 * traits are stripped to prevent PII leakage. Callers who explicitly need
 * traits receive a `IamIdentityWithTraits`.
 *
 * Zero-Ory-leakage contract: this file MUST NOT import from `@ory/*`.
 */
import type { TenantName } from './tenant';

/** Whether the identity has verified email / phone addresses. */
export interface IamVerifiedAddressesFlags {
  readonly email: boolean;
  readonly phone: boolean;
}

/** Sanitized identity (no traits). */
export interface IamIdentity {
  readonly id: string;
  readonly schemaId: string;
  readonly state: 'active' | 'inactive';
  readonly verifiedAddressesFlags: IamVerifiedAddressesFlags;
  readonly metadataPublic?: Record<string, unknown>;
  readonly tenant: TenantName;
}

/** Identity with traits attached — use only when callers explicitly need them. */
export interface IamIdentityWithTraits extends IamIdentity {
  readonly traits: Record<string, unknown>;
}
