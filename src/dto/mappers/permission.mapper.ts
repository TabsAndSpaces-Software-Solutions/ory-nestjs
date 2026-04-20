/**
 * Maps Keto relationship tuples / check results between @ory/client shapes
 * and library DTOs. Also provides a reverse mapper for query-string params.
 */
import type {
  CheckPermissionResult as OryCheckPermissionResult,
  Relationship as OryRelationship,
} from '@ory/client';

import { deepFreeze } from '../freeze';
import type { IamPermissionQuery, IamPermissionTuple } from '../permission';
import type { TenantName } from '../tenant';

/**
 * Query shape accepted by the Keto client for listing / filtering
 * relationships. Only the fields we actually emit.
 */
export interface OryRelationshipQueryParams {
  namespace?: string;
  object?: string;
  relation?: string;
  subject_id?: string;
  page_size?: number;
  page_token?: string;
}

function renderSubject(r: OryRelationship): string {
  if (r.subject_id !== undefined && r.subject_id !== null) {
    return r.subject_id;
  }
  if (r.subject_set) {
    return `${r.subject_set.namespace}:${r.subject_set.object}#${r.subject_set.relation}`;
  }
  return '';
}

export const permissionMapper = {
  fromOryRelationTuple(r: OryRelationship, tenant: TenantName): IamPermissionTuple {
    const dto: IamPermissionTuple = {
      namespace: r.namespace,
      object: r.object,
      relation: r.relation,
      subject: renderSubject(r),
      tenant,
    };
    return deepFreeze(dto);
  },

  fromOryCheckResult(
    result: OryCheckPermissionResult | { allowed?: boolean },
  ): boolean {
    return (result as { allowed?: boolean }).allowed === true;
  },

  toOryQuery(q: IamPermissionQuery): OryRelationshipQueryParams {
    const out: OryRelationshipQueryParams = {};
    if (q.namespace !== undefined) out.namespace = q.namespace;
    if (q.object !== undefined) out.object = q.object;
    if (q.relation !== undefined) out.relation = q.relation;
    if (q.subject !== undefined) out.subject_id = q.subject;
    if (q.limit !== undefined) out.page_size = q.limit;
    if (q.pageToken !== undefined) out.page_token = q.pageToken;
    return out;
  },
};
