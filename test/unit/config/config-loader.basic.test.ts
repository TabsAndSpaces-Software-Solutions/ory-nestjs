/**
 * Unit tests for `ConfigLoader.load()` — basic validation and happy paths.
 *
 * Covers:
 *   - required `tenants` map, non-empty
 *   - nested `kratos.publicUrl` URL validation
 *   - `kratos.sessionCookieName` default
 *   - `global` default (true)
 *   - strict mode rejects unknown keys
 */
import { ConfigLoader } from '../../../src/config/config-loader.service';
import { IamConfigurationError } from '../../../src/errors';

describe('ConfigLoader.load (basic)', () => {
  const loader = new ConfigLoader();

  const minimalTenant = {
    mode: 'self-hosted' as const,
    transport: 'bearer' as const,
    kratos: { publicUrl: 'https://kratos.example.com' },
  };

  it('accepts a minimal valid single-tenant config and returns it', () => {
    const cfg = loader.load({
      tenants: { customer: minimalTenant },
    });
    expect(cfg.tenants.customer.mode).toBe('self-hosted');
    expect(cfg.tenants.customer.transport).toBe('bearer');
    expect(cfg.tenants.customer.kratos.publicUrl).toBe(
      'https://kratos.example.com',
    );
  });

  it('applies `sessionCookieName` default of "ory_kratos_session"', () => {
    const cfg = loader.load({
      tenants: { customer: minimalTenant },
    });
    expect(cfg.tenants.customer.kratos.sessionCookieName).toBe(
      'ory_kratos_session',
    );
  });

  it('applies `global` default of true', () => {
    const cfg = loader.load({
      tenants: { customer: minimalTenant },
    });
    expect(cfg.global).toBe(true);
  });

  it('respects an explicit `global: false`', () => {
    const cfg = loader.load({
      tenants: { customer: minimalTenant },
      global: false,
    });
    expect(cfg.global).toBe(false);
  });

  it('rejects an empty tenants map', () => {
    expect(() => loader.load({ tenants: {} })).toThrow(IamConfigurationError);
  });

  it('rejects a missing tenants map', () => {
    expect(() => loader.load({})).toThrow(IamConfigurationError);
  });

  it('rejects a non-URL kratos.publicUrl', () => {
    expect(() =>
      loader.load({
        tenants: {
          customer: {
            mode: 'self-hosted',
            transport: 'bearer',
            kratos: { publicUrl: 'not-a-url' },
          },
        },
      }),
    ).toThrow(IamConfigurationError);
  });

  it('rejects an unknown top-level key (strict)', () => {
    expect(() =>
      loader.load({
        tenants: { customer: minimalTenant },
        bogusKey: 'nope',
      }),
    ).toThrow(IamConfigurationError);
  });

  it('rejects an unknown key inside a tenant (strict)', () => {
    expect(() =>
      loader.load({
        tenants: {
          customer: { ...minimalTenant, bogusTenantKey: 1 },
        },
      }),
    ).toThrow(IamConfigurationError);
  });

  it('rejects an unknown key inside kratos (strict)', () => {
    expect(() =>
      loader.load({
        tenants: {
          customer: {
            ...minimalTenant,
            kratos: {
              publicUrl: 'https://kratos.example.com',
              bogusKratosKey: 1,
            },
          },
        },
      }),
    ).toThrow(IamConfigurationError);
  });

  it('rejects an invalid `mode` enum value', () => {
    expect(() =>
      loader.load({
        tenants: {
          customer: { ...minimalTenant, mode: 'weird' },
        },
      }),
    ).toThrow(IamConfigurationError);
  });

  it('rejects an invalid `transport` enum value', () => {
    expect(() =>
      loader.load({
        tenants: {
          customer: { ...minimalTenant, transport: 'weird' },
        },
      }),
    ).toThrow(IamConfigurationError);
  });

  it('embeds the aggregated zod issue list in the error message', () => {
    try {
      loader.load({ tenants: { customer: { mode: 'self-hosted' } } });
      fail('expected IamConfigurationError');
    } catch (err) {
      expect(err).toBeInstanceOf(IamConfigurationError);
      expect((err as Error).message).toContain('Invalid ory-nestjs config');
      // The missing `transport` and missing `kratos` should appear in the
      // aggregated summary.
      expect((err as Error).message).toMatch(/tenants\.customer\./);
    }
  });
});
