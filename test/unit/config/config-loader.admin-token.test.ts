/**
 * Self-hosted admin refinement: if a tenant declares `kratos.adminUrl` (the
 * admin API surface) in self-hosted mode, it MUST also declare
 * `kratos.adminToken`. Missing the token means admin-requiring operations
 * would fail at runtime with an opaque 401 from upstream — we fail fast at
 * boot instead.
 *
 * In cloud mode the admin API is authenticated via `cloud.apiKey`, so an
 * `adminToken` is not required alongside `adminUrl` (though typically the
 * consumer does not set `adminUrl` at all in cloud mode).
 */
import { ConfigLoader } from '../../../src/config/config-loader.service';
import { IamConfigurationError } from '../../../src/errors';

describe('ConfigLoader.load — self-hosted admin-token refinement', () => {
  const loader = new ConfigLoader();

  it('rejects self-hosted adminUrl without adminToken', () => {
    expect(() =>
      loader.load({
        tenants: {
          customer: {
            mode: 'self-hosted',
            transport: 'bearer',
            kratos: {
              publicUrl: 'https://kratos.example.com',
              adminUrl: 'https://kratos-admin.example.com',
            },
          },
        },
      }),
    ).toThrow(IamConfigurationError);
    try {
      loader.load({
        tenants: {
          customer: {
            mode: 'self-hosted',
            transport: 'bearer',
            kratos: {
              publicUrl: 'https://kratos.example.com',
              adminUrl: 'https://kratos-admin.example.com',
            },
          },
        },
      });
    } catch (err) {
      expect((err as Error).message).toMatch(/adminToken/);
    }
  });

  it('accepts self-hosted adminUrl + adminToken', () => {
    expect(() =>
      loader.load({
        tenants: {
          customer: {
            mode: 'self-hosted',
            transport: 'bearer',
            kratos: {
              publicUrl: 'https://kratos.example.com',
              adminUrl: 'https://kratos-admin.example.com',
              adminToken: 'tok-secret',
            },
          },
        },
      }),
    ).not.toThrow();
  });

  it('accepts self-hosted without adminUrl (no admin ops intended)', () => {
    expect(() =>
      loader.load({
        tenants: {
          customer: {
            mode: 'self-hosted',
            transport: 'bearer',
            kratos: { publicUrl: 'https://kratos.example.com' },
          },
        },
      }),
    ).not.toThrow();
  });
});
