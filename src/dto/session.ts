/**
 * Library-owned session DTO.
 *
 * Zero-Ory-leakage contract: this file MUST NOT import from `@ory/*`.
 */
import type { IamIdentity } from './identity';
import type { TenantName } from './tenant';

export interface IamSession {
  readonly id: string;
  readonly active: boolean;
  /** ISO 8601 timestamp. */
  readonly expiresAt: string;
  /** ISO 8601 timestamp. */
  readonly authenticatedAt: string;
  readonly authenticationMethods: readonly string[];
  readonly identity: IamIdentity;
  readonly tenant: TenantName;
}
