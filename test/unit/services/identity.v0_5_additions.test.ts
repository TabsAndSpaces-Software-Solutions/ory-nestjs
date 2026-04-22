/**
 * Focused coverage for v0.5.0 additions to IdentityService:
 *   - patch() (JSON-Patch)
 *   - extendSession()
 *   - audit emissions on mutating methods
 */
import 'reflect-metadata';
import { ServiceUnavailableException } from '@nestjs/common';

import { IdentityService } from '../../../src/services/identity.service';
import { IamConfigurationError } from '../../../src/errors';
import type { TenantClients } from '../../../src/clients';
import { makeAuditSpy, makeClients, makeRegistry, oryError } from './_helpers';

describe('IdentityService (v0.5.0)', () => {
  const api = {
    getIdentity: jest.fn(),
    listIdentities: jest.fn(),
    createIdentity: jest.fn(),
    updateIdentity: jest.fn(),
    patchIdentity: jest.fn(),
    deleteIdentity: jest.fn(),
    extendSession: jest.fn(),
    listIdentitySessions: jest.fn(),
    disableSession: jest.fn(),
  };
  const registry = makeRegistry({
    default: makeClients({
      tenant: 'default',
      kratosIdentity: api as unknown as TenantClients['kratosIdentity'],
    }),
    empty: makeClients({ tenant: 'empty' }),
  });
  const audit = makeAuditSpy();
  const svc = new IdentityService(registry, audit);

  beforeEach(() => {
    Object.values(api).forEach((m) => m.mockReset());
    audit.events.length = 0;
  });

  it('patch() forwards ops + emits iam.identity.patch', async () => {
    api.patchIdentity.mockResolvedValue({
      data: {
        id: 'u1',
        schema_id: 'default',
        state: 'active',
        traits: {},
        metadata_public: { roles: ['admin'] },
      },
    });
    const out = await svc
      .forTenant('default')
      .patch('u1', [{ op: 'replace', path: '/metadata_public', value: { roles: ['admin'] } }]);
    expect(out.id).toBe('u1');
    expect(audit.events.map((e) => e.event)).toContain('iam.identity.patch');
  });

  it('patch() propagates 503 through ErrorMapper', async () => {
    api.patchIdentity.mockRejectedValue(oryError(503));
    await expect(
      svc.forTenant('default').patch('u1', []),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('extendSession() returns mapped session + emits iam.session.extend', async () => {
    api.extendSession.mockResolvedValue({
      data: {
        id: 'sess-1',
        active: true,
        expires_at: '2030-01-01T00:00:00Z',
        authenticated_at: '2024-01-01T00:00:00Z',
        authentication_methods: [{ method: 'password' }],
        identity: {
          id: 'u1',
          schema_id: 'default',
          state: 'active',
        },
      },
    });
    const sess = await svc.forTenant('default').extendSession('sess-1');
    expect(sess.id).toBe('sess-1');
    expect(audit.events.map((e) => e.event)).toContain('iam.session.extend');
  });

  it('extendSession() throws IamConfigurationError when admin absent', async () => {
    await expect(
      svc.forTenant('empty').extendSession('s'),
    ).rejects.toBeInstanceOf(IamConfigurationError);
  });
});
