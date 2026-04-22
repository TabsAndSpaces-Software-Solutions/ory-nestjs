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

/**
 * Subject-expansion tree node returned by Keto `expandPermissions`.
 */
export interface IamPermissionTreeNode {
  readonly type:
    | 'union'
    | 'exclusion'
    | 'intersection'
    | 'leaf'
    | 'tuple_to_subject_set'
    | 'computed_subject_set'
    | 'not'
    | 'unspecified';
  readonly tuple?: {
    readonly namespace: string;
    readonly object: string;
    readonly relation: string;
    readonly subject?: string;
  };
  readonly children?: readonly IamPermissionTreeNode[];
}

export interface IamPermissionTree {
  readonly root: IamPermissionTreeNode;
  readonly tenant: TenantName;
}

/** Per-tuple result from `PermissionService.checkBatch`. */
export interface IamPermissionCheckResult {
  readonly tuple: IamPermissionTuple;
  readonly allowed: boolean;
  readonly error?: string;
}
