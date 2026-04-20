/**
 * `defaultTenant` refinement: when the tenants map has more than one entry,
 * an explicit `defaultTenant` is mandatory. When set, it must name an existing
 * tenant.
 */
import { ConfigLoader } from '../../../src/config/config-loader.service';
import { IamConfigurationError } from '../../../src/errors';

describe('ConfigLoader.load — defaultTenant refinement', () => {
  const loader = new ConfigLoader();
  const tenantA = {
    mode: 'self-hosted' as const,
    transport: 'bearer' as const,
    kratos: { publicUrl: 'https://kratos-a.example.com' },
  };
  const tenantB = {
    mode: 'self-hosted' as const,
    transport: 'bearer' as const,
    kratos: { publicUrl: 'https://kratos-b.example.com' },
  };

  it('allows a single-tenant config without defaultTenant', () => {
    expect(() =>
      loader.load({ tenants: { customer: tenantA } }),
    ).not.toThrow();
  });

  it('rejects a multi-tenant config without defaultTenant', () => {
    expect(() =>
      loader.load({ tenants: { customer: tenantA, admin: tenantB } }),
    ).toThrow(IamConfigurationError);
    try {
      loader.load({ tenants: { customer: tenantA, admin: tenantB } });
    } catch (err) {
      expect((err as Error).message).toMatch(
        /multiple tenants require an explicit defaultTenant/,
      );
    }
  });

  it('accepts a multi-tenant config with a valid defaultTenant', () => {
    const cfg = loader.load({
      tenants: { customer: tenantA, admin: tenantB },
      defaultTenant: 'customer',
    });
    expect(cfg.defaultTenant).toBe('customer');
  });

  it('rejects a defaultTenant that is not in the tenants map', () => {
    expect(() =>
      loader.load({
        tenants: { customer: tenantA, admin: tenantB },
        defaultTenant: 'nobody',
      }),
    ).toThrow(IamConfigurationError);
    try {
      loader.load({
        tenants: { customer: tenantA },
        defaultTenant: 'nobody',
      });
    } catch (err) {
      expect((err as Error).message).toMatch(/tenant 'nobody' not in tenants/);
    }
  });

  it('accepts a single-tenant config with a defaultTenant that matches', () => {
    expect(() =>
      loader.load({
        tenants: { customer: tenantA },
        defaultTenant: 'customer',
      }),
    ).not.toThrow();
  });
});
