/**
 * `PermissionStubService` — in-memory replacement for `PermissionService`.
 *
 * `check`/`grant`/`revoke` read and mutate the shared
 * `TestingState.permissions` map using the canonical `namespace:relation:object`
 * key. `list` walks the map and returns tuples that match the query.
 */
import { Inject, Injectable } from '@nestjs/common';

import type {
  TenantName,
  IamPermissionQuery,
  IamPermissionTuple,
} from '../../dto';
import {
  TESTING_STATE,
  TestingState,
  permissionKey,
} from '../testing-state';

interface IamPermissionList {
  items: IamPermissionTuple[];
  nextPageToken?: string;
}

class PermissionStubServiceFor {
  constructor(
    private readonly tenant: TenantName,
    private readonly state: TestingState,
  ) {}

  public async check(tuple: IamPermissionTuple): Promise<boolean> {
    const key = permissionKey(tuple.namespace, tuple.relation, tuple.object);
    return this.state.permissions.get(key) === true;
  }

  public async grant(tuple: IamPermissionTuple): Promise<void> {
    const key = permissionKey(tuple.namespace, tuple.relation, tuple.object);
    this.state.permissions.set(key, true);
  }

  public async revoke(tuple: IamPermissionTuple): Promise<void> {
    const key = permissionKey(tuple.namespace, tuple.relation, tuple.object);
    this.state.permissions.set(key, false);
  }

  public async list(
    query: IamPermissionQuery,
  ): Promise<IamPermissionList> {
    const items: IamPermissionTuple[] = [];
    for (const [key, value] of this.state.permissions) {
      if (value !== true) continue;
      const parts = key.split(':');
      if (parts.length < 3) continue;
      const namespace = parts[0];
      const relation = parts[1];
      const object = parts.slice(2).join(':');
      if (query.namespace !== undefined && query.namespace !== namespace) {
        continue;
      }
      if (query.relation !== undefined && query.relation !== relation) {
        continue;
      }
      if (query.object !== undefined && query.object !== object) continue;
      items.push({
        namespace,
        relation,
        object,
        subject: query.subject ?? '',
        tenant: this.tenant,
      });
    }
    return { items };
  }
}

@Injectable()
export class PermissionStubService {
  private readonly byTenant = new Map<TenantName, PermissionStubServiceFor>();

  constructor(
    @Inject(TESTING_STATE) private readonly state: TestingState,
  ) {}

  public forTenant(name: TenantName): PermissionStubServiceFor {
    let existing = this.byTenant.get(name);
    if (existing === undefined) {
      existing = new PermissionStubServiceFor(name, this.state);
      this.byTenant.set(name, existing);
    }
    return existing;
  }
}
