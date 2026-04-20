/**
 * Library-owned permission DTOs.
 *
 * Zero-Ory-leakage contract: this file MUST NOT import from `@ory/*`.
 */
import type { TenantName } from './tenant';

export interface IamPermissionTuple {
  readonly namespace: string;
  readonly object: string;
  readonly relation: string;
  readonly subject: string;
  readonly tenant: TenantName;
}

/**
 * A permission query is a partial tuple plus pagination controls. `tenant`
 * remains required so queries cannot accidentally span tenants.
 */
export interface IamPermissionQuery {
  readonly tenant: TenantName;
  readonly namespace?: string;
  readonly object?: string;
  readonly relation?: string;
  readonly subject?: string;
  readonly limit?: number;
  readonly pageToken?: string;
}
