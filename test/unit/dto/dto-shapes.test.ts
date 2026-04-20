/**
 * Structural (compile + runtime) checks for DTOs.
 *
 * These tests verify:
 *   - every DTO from the spec is exported from `src/dto`
 *   - no DTO public shape contains Ory-specific field names
 *     (snake_case, `verifiable_addresses`, etc.)
 *   - every DTO carries a `tenant` field
 */
import * as fs from 'fs';
import * as path from 'path';

import type {
  TenantName,
  IamIdentity,
  IamIdentityWithTraits,
  IamSession,
  IamPermissionTuple,
  IamPermissionQuery,
  IamToken,
  IamTokenIntrospection,
  IamMachinePrincipal,
  IamFlowUi,
  IamLoginFlow,
  IamRegistrationFlow,
  IamRecoveryFlow,
  IamSettingsFlow,
  IamVerificationFlow,
  IamAuditEvent,
} from '../../../src/dto';

describe('DTO shapes', () => {
  it('TenantName is a string-assignable type', () => {
    const t: TenantName = 'demo';
    expect(typeof t).toBe('string');
  });

  it('IamIdentity has the sanitized shape with tenant', () => {
    const id: IamIdentity = {
      id: 'id-1',
      schemaId: 'default',
      state: 'active',
      verifiedAddressesFlags: { email: true, phone: false },
      tenant: 'demo',
    };
    expect(id.tenant).toBe('demo');
    expect(id.verifiedAddressesFlags.email).toBe(true);
  });

  it('IamIdentity accepts optional metadataPublic', () => {
    const id: IamIdentity = {
      id: 'id-1',
      schemaId: 'default',
      state: 'inactive',
      verifiedAddressesFlags: { email: false, phone: false },
      metadataPublic: { foo: 'bar' },
      tenant: 'demo',
    };
    expect(id.metadataPublic).toEqual({ foo: 'bar' });
  });

  it('IamIdentityWithTraits extends IamIdentity and adds traits', () => {
    const id: IamIdentityWithTraits = {
      id: 'id-1',
      schemaId: 'default',
      state: 'active',
      verifiedAddressesFlags: { email: false, phone: false },
      traits: { email: 'user@example.com' },
      tenant: 'demo',
    };
    const narrowed: IamIdentity = id;
    expect(narrowed.id).toBe('id-1');
    expect(id.traits.email).toBe('user@example.com');
  });

  it('IamSession carries a sanitized identity and tenant', () => {
    const s: IamSession = {
      id: 'sess-1',
      active: true,
      expiresAt: '2030-01-01T00:00:00.000Z',
      authenticatedAt: '2030-01-01T00:00:00.000Z',
      authenticationMethods: ['password'],
      identity: {
        id: 'id-1',
        schemaId: 'default',
        state: 'active',
        verifiedAddressesFlags: { email: true, phone: false },
        tenant: 'demo',
      },
      tenant: 'demo',
    };
    expect(s.authenticationMethods).toContain('password');
  });

  it('IamPermissionTuple has namespace/object/relation/subject and tenant', () => {
    const t: IamPermissionTuple = {
      namespace: 'documents',
      object: 'doc-1',
      relation: 'viewer',
      subject: 'user:alice',
      tenant: 'demo',
    };
    expect(t.namespace).toBe('documents');
  });

  it('IamPermissionQuery allows partial tuple fields plus pagination', () => {
    const q: IamPermissionQuery = {
      tenant: 'demo',
      namespace: 'documents',
      limit: 50,
      pageToken: 'abc',
    };
    expect(q.limit).toBe(50);
  });

  it('IamToken shape', () => {
    const tok: IamToken = {
      accessToken: 'xyz',
      tokenType: 'Bearer',
      expiresIn: 3600,
      scope: ['read', 'write'],
      tenant: 'demo',
    };
    expect(tok.tokenType).toBe('Bearer');
    expect(tok.scope).toContain('read');
  });

  it('IamTokenIntrospection shape', () => {
    const i: IamTokenIntrospection = {
      active: true,
      subject: 'user:alice',
      clientId: 'client-1',
      scope: ['read'],
      exp: 1_700_000_000,
      iat: 1_600_000_000,
      tenant: 'demo',
    };
    expect(i.active).toBe(true);
  });

  it('IamMachinePrincipal has kind: "machine"', () => {
    const m: IamMachinePrincipal = {
      kind: 'machine',
      clientId: 'svc-1',
      scope: ['svc.read'],
      tenant: 'demo',
    };
    expect(m.kind).toBe('machine');
  });

  it('IamFlowUi has loosely-typed nodes + messages', () => {
    const ui: IamFlowUi = {
      nodes: [{ type: 'input' }],
      messages: [{ id: 1 }],
    };
    expect(Array.isArray(ui.nodes)).toBe(true);
    expect(Array.isArray(ui.messages)).toBe(true);
  });

  it('Flow DTOs (login/register/recovery/settings/verification) all share the same shape', () => {
    const base = {
      id: 'flow-1',
      expiresAt: '2030-01-01T00:00:00.000Z',
      ui: { nodes: [], messages: [] },
      csrfToken: 'csrf-abc',
      tenant: 'demo',
    };
    const login: IamLoginFlow = { ...base };
    const reg: IamRegistrationFlow = { ...base };
    const rec: IamRecoveryFlow = { ...base };
    const set: IamSettingsFlow = { ...base };
    const ver: IamVerificationFlow = { ...base };
    for (const f of [login, reg, rec, set, ver]) {
      expect(f.csrfToken).toBe('csrf-abc');
    }
  });

  it('IamAuditEvent shape', () => {
    const e: IamAuditEvent = {
      timestamp: '2030-01-01T00:00:00.000Z',
      event: 'session.whoami',
      tenant: 'demo',
      actorId: 'user-1',
      targetId: 'resource-1',
      result: 'success',
      attributes: { ip: '127.0.0.1' },
      correlationId: 'corr-1',
    };
    expect(e.result).toBe('success');
  });
});

describe('DTO file hygiene (no Ory leakage)', () => {
  const dtoRoot = path.join(__dirname, '..', '..', '..', 'src', 'dto');

  function listDtoFiles(): string[] {
    // Collect *.ts files directly inside src/dto/ (NOT src/dto/mappers/).
    const entries = fs.readdirSync(dtoRoot, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.ts'))
      .map((e) => path.join(dtoRoot, e.name));
  }

  function stripComments(s: string): string {
    return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  }

  it('no DTO file imports from @ory/*', () => {
    for (const f of listDtoFiles()) {
      const raw = fs.readFileSync(f, 'utf8');
      // Strip comments so doc prose can mention Ory.
      expect(stripComments(raw)).not.toMatch(/@ory\//);
    }
  });

  it('no DTO file contains Ory-specific snake_case field names in its public shape', () => {
    // Catch accidental reuse of Ory field names like `schema_id`,
    // `verifiable_addresses`, `metadata_public` which would suggest the
    // DTO is just a type alias for an Ory payload.
    const forbidden = [
      /\bschema_id\b/,
      /\bverifiable_addresses\b/,
      /\bmetadata_public\b/,
      /\bauthentication_methods\b/,
      /\bsubject_id\b/,
      /\bsubject_set\b/,
    ];
    for (const f of listDtoFiles()) {
      const raw = stripComments(fs.readFileSync(f, 'utf8'));
      for (const pat of forbidden) {
        expect(raw).not.toMatch(pat);
      }
    }
  });
});
