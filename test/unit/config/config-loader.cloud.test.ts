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
    kratos: { publicUrl: 'https://kratos.example.com' },
  };

  it('accepts cloud mode with projectSlug + apiKey', () => {
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
});
