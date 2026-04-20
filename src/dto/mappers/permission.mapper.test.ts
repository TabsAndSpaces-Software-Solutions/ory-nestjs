/**
 * Unit tests for permissionMapper.
 *
 * Keto's REST surface is simple enough that we only need:
 *   - map an Ory-style tuple `{namespace, object, relation, subject_id | subject_set}`
 *     → `IamPermissionTuple`
 *   - map a `{allowed: boolean}` response → boolean
 *   - reverse-map a `IamPermissionQuery` into the query-string-shaped record
 *     Keto expects.
 */
import { permissionMapper } from './permission.mapper';
import type { IamPermissionQuery } from '../permission';

describe('permissionMapper.fromOryRelationTuple', () => {
  it('maps a subject-id tuple', () => {
    const dto = permissionMapper.fromOryRelationTuple(
      {
        namespace: 'documents',
        object: 'doc-1',
        relation: 'viewer',
        subject_id: 'user:alice',
      },
      'tenant-a',
    );
    expect(dto).toEqual({
      namespace: 'documents',
      object: 'doc-1',
      relation: 'viewer',
      subject: 'user:alice',
      tenant: 'tenant-a',
    });
  });

  it('maps a subject-set tuple into "namespace:object#relation" form', () => {
    const dto = permissionMapper.fromOryRelationTuple(
      {
        namespace: 'documents',
        object: 'doc-1',
        relation: 'viewer',
        subject_set: {
          namespace: 'groups',
          object: 'admins',
          relation: 'member',
        },
      },
      'tenant-a',
    );
    expect(dto.subject).toBe('groups:admins#member');
  });

  it('returns a frozen DTO', () => {
    const dto = permissionMapper.fromOryRelationTuple(
      {
        namespace: 'documents',
        object: 'doc-1',
        relation: 'viewer',
        subject_id: 'user:alice',
      },
      'tenant-a',
    );
    expect(Object.isFrozen(dto)).toBe(true);
  });
});

describe('permissionMapper.fromOryCheckResult', () => {
  it('extracts the allowed flag', () => {
    expect(permissionMapper.fromOryCheckResult({ allowed: true })).toBe(true);
    expect(permissionMapper.fromOryCheckResult({ allowed: false })).toBe(false);
  });

  it('treats a missing allowed as false', () => {
    expect(
      permissionMapper.fromOryCheckResult(
        {} as unknown as { allowed: boolean },
      ),
    ).toBe(false);
  });
});

describe('permissionMapper.toOryQuery (reverse)', () => {
  it('maps library query fields to snake_case Keto query params', () => {
    const q: IamPermissionQuery = {
      tenant: 'tenant-a',
      namespace: 'documents',
      object: 'doc-1',
      relation: 'viewer',
      subject: 'user:alice',
      limit: 25,
      pageToken: 'token-abc',
    };
    const out = permissionMapper.toOryQuery(q);
    expect(out).toEqual({
      namespace: 'documents',
      object: 'doc-1',
      relation: 'viewer',
      subject_id: 'user:alice',
      page_size: 25,
      page_token: 'token-abc',
    });
  });

  it('omits any undefined fields', () => {
    const q: IamPermissionQuery = {
      tenant: 'tenant-a',
      namespace: 'documents',
    };
    const out = permissionMapper.toOryQuery(q);
    expect(out).toEqual({ namespace: 'documents' });
  });

  it('never leaks the tenant into the Ory query', () => {
    const q: IamPermissionQuery = {
      tenant: 'tenant-a',
      namespace: 'documents',
    };
    const out = permissionMapper.toOryQuery(q);
    expect(out).not.toHaveProperty('tenant');
  });
});
