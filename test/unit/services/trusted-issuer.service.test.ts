import 'reflect-metadata';
import { ServiceUnavailableException } from '@nestjs/common';

import { TrustedIssuerService } from '../../../src/services/trusted-issuer.service';
import { IamConfigurationError } from '../../../src/errors';
import type { TenantClients } from '../../../src/clients';
import { makeAuditSpy, makeClients, makeRegistry, oryError } from './_helpers';

describe('TrustedIssuerService', () => {
  const api = {
    trustOAuth2JwtGrantIssuer: jest.fn(),
    getTrustedOAuth2JwtGrantIssuer: jest.fn(),
    listTrustedOAuth2JwtGrantIssuers: jest.fn(),
    deleteTrustedOAuth2JwtGrantIssuer: jest.fn(),
  };
  const registry = makeRegistry({
    default: makeClients({
      tenant: 'default',
      hydraOauth2: api as unknown as TenantClients['hydraOauth2'],
    }),
    empty: makeClients({ tenant: 'empty' }),
  });
  const audit = makeAuditSpy();
  const svc = new TrustedIssuerService(registry, audit);

  beforeEach(() => {
    Object.values(api).forEach((m) => m.mockReset());
    audit.events.length = 0;
  });

  it('trust() maps the issuer and emits audit', async () => {
    api.trustOAuth2JwtGrantIssuer.mockResolvedValue({
      data: {
        id: 'i1',
        issuer: 'https://x',
        scope: ['read'],
        expires_at: '2030-01-01T00:00:00Z',
        public_key: { kid: 'k', kty: 'RSA' },
      },
    });
    const issuer = await svc.forTenant('default').trust({
      issuer: 'https://x',
      scope: ['read'],
      expiresAt: '2030-01-01T00:00:00Z',
      publicKey: { kid: 'k', kty: 'RSA' },
    });
    expect(issuer.id).toBe('i1');
    expect(audit.events.map((e) => e.event)).toContain(
      'iam.oauth2.trustedIssuer.trust',
    );
  });

  it('delete() emits audit', async () => {
    api.deleteTrustedOAuth2JwtGrantIssuer.mockResolvedValue({ data: null });
    await svc.forTenant('default').delete('i1');
    expect(audit.events.map((e) => e.event)).toContain(
      'iam.oauth2.trustedIssuer.delete',
    );
  });

  it('propagates upstream 503', async () => {
    api.getTrustedOAuth2JwtGrantIssuer.mockRejectedValue(oryError(503));
    await expect(svc.forTenant('default').get('x')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('throws IamConfigurationError when Hydra admin is absent', async () => {
    await expect(svc.forTenant('empty').get('x')).rejects.toBeInstanceOf(
      IamConfigurationError,
    );
  });

  it('get() + list() map responses', async () => {
    const stub = {
      id: 'i1',
      issuer: 'https://x',
      scope: ['read'],
      expires_at: '2030-01-01T00:00:00Z',
      public_key: { kid: 'k', kty: 'RSA' },
    };
    api.getTrustedOAuth2JwtGrantIssuer.mockResolvedValue({ data: stub });
    api.listTrustedOAuth2JwtGrantIssuers.mockResolvedValue({ data: [stub] });
    const got = await svc.forTenant('default').get('i1');
    expect(got.issuer).toBe('https://x');
    const { items } = await svc.forTenant('default').list();
    expect(items).toHaveLength(1);
  });
});
