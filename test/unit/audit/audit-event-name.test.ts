/**
 * Verifies the `AuditEventName` union/enum contains every event named in the
 * SDD's tracking table. Checks both type-level (via satisfies) and runtime
 * presence (all 16 strings in a known array export).
 */
import { AUDIT_EVENT_NAMES, type AuditEventName } from '../../../src/audit';

const EXPECTED: AuditEventName[] = [
  'auth.success',
  'auth.failure.expired',
  'auth.failure.upstream',
  'auth.failure.unsigned_header',
  'auth.failure.missing_credential',
  'auth.failure.malformed',
  'auth.failure.token_inactive',
  'auth.tenant_mismatch',
  'authz.role.deny',
  'authz.permission.deny',
  'authz.permission.grant',
  'authz.permission.revoke',
  'authz.session.revoke',
  'authz.upstream_unavailable',
  'config.boot_failure',
  'health.probe_failure',
];

describe('AuditEventName', () => {
  it('exposes all 16 event names at runtime via AUDIT_EVENT_NAMES', () => {
    expect(AUDIT_EVENT_NAMES).toHaveLength(16);
    for (const name of EXPECTED) {
      expect(AUDIT_EVENT_NAMES).toContain(name);
    }
  });

  it('has no duplicates', () => {
    const set = new Set(AUDIT_EVENT_NAMES);
    expect(set.size).toBe(AUDIT_EVENT_NAMES.length);
  });
});
