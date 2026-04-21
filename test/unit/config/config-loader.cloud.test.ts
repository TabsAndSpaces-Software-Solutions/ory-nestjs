/**
 * Cloud-mode refinement: when `tenant.mode === 'cloud'`, the tenant MUST
 * declare `cloud.projectSlug` and `cloud.apiKey`. Missing either is a boot
 * error — we never silently fall back to self-hosted defaults.
 */
import { ConfigLoader } from '../../../src/config/config-loader.service';
import { IamConfigurationError } from '../../../src/errors';

describe('ConfigLoader.load — cloud-mode refinement', () => {
  const loader = new ConfigLoader();

  const base = {
    mode: 'cloud' as const,
    transport: 'bearer' as const,
  };

  it('accepts cloud mode with projectSlug + apiKey (no kratos block required)', () => {
    const cfg = loader.load({
      tenants: {
        customer: {
          ...base,
          cloud: { projectSlug: 'slug-xyz', apiKey: 'secret' },
        },
      },
    });
    expect(cfg.tenants.customer.cloud?.projectSlug).toBe('slug-xyz');
    expect(cfg.tenants.customer.cloud?.apiKey).toBe('secret');
  });

  it('synthesizes kratos.publicUrl + adminUrl + adminToken from projectSlug/apiKey when no kratos block is supplied', () => {
    const cfg = loader.load({
      tenants: {
        customer: {
          ...base,
          cloud: { projectSlug: 'slug-xyz', apiKey: 'secret' },
        },
      },
    });
    const t = cfg.tenants.customer;
    expect(t.kratos).toBeDefined();
    expect(t.kratos.publicUrl).toBe('https://slug-xyz.projects.oryapis.com');
    expect(t.kratos.adminUrl).toBe('https://slug-xyz.projects.oryapis.com');
    expect(t.kratos.adminToken).toBe('secret');
    expect(t.kratos.sessionCookieName).toBe('ory_kratos_session');
  });

  it('preserves consumer-supplied kratos overrides in cloud mode (sessionCookieName + publicUrl)', () => {
    const cfg = loader.load({
      tenants: {
        customer: {
          mode: 'cloud',
          transport: 'cookie-or-bearer',
          trustProxy: true,
          cloud: { projectSlug: 'slug-xyz', apiKey: 'secret' },
          kratos: {
            publicUrl: 'https://custom.example.com',
            sessionCookieName: 'ory_session_customproj',
          },
        },
      },
    });
    const t = cfg.tenants.customer;
    expect(t.kratos.publicUrl).toBe('https://custom.example.com');
    expect(t.kratos.sessionCookieName).toBe('ory_session_customproj');
    // adminToken still derived from cloud.apiKey when not supplied.
    expect(t.kratos.adminToken).toBe('secret');
  });

  it('rejects cloud mode when `cloud` is missing entirely', () => {
    expect(() =>
      loader.load({ tenants: { customer: base } }),
    ).toThrow(IamConfigurationError);
    try {
      loader.load({ tenants: { customer: base } });
    } catch (err) {
      expect((err as Error).message).toMatch(/cloud mode requires/);
      expect((err as Error).message).toMatch(/projectSlug/);
      expect((err as Error).message).toMatch(/apiKey/);
    }
  });

  it('rejects cloud mode with empty projectSlug', () => {
    expect(() =>
      loader.load({
        tenants: {
          customer: {
            ...base,
            cloud: { projectSlug: '', apiKey: 'secret' },
          },
        },
      }),
    ).toThrow(IamConfigurationError);
  });

  it('rejects cloud mode with empty apiKey', () => {
    expect(() =>
      loader.load({
        tenants: {
          customer: {
            ...base,
            cloud: { projectSlug: 'slug', apiKey: '' },
          },
        },
      }),
    ).toThrow(IamConfigurationError);
  });

  it('allows self-hosted mode without cloud config', () => {
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

  it('rejects self-hosted mode when kratos block is missing (no projectSlug to derive URL from)', () => {
    expect(() =>
      loader.load({
        tenants: {
          customer: {
            mode: 'self-hosted',
            transport: 'bearer',
            // No kratos block — self-hosted cannot synthesize a URL.
          },
        },
      }),
    ).toThrow(IamConfigurationError);
  });
});
