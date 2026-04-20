/**
 * Oathkeeper-transport refinement: when `tenant.transport === 'oathkeeper'`,
 * the tenant MUST declare `oathkeeper` with a non-empty `signerKeys` array AND
 * both `identityHeader` and `signatureHeader` (the defaults are fine, but the
 * object itself must be present so consumers opt in consciously).
 */
import { ConfigLoader } from '../../../src/config/config-loader.service';
import { IamConfigurationError } from '../../../src/errors';

describe('ConfigLoader.load — oathkeeper-transport refinement', () => {
  const loader = new ConfigLoader();

  const base = {
    mode: 'self-hosted' as const,
    transport: 'oathkeeper' as const,
    kratos: { publicUrl: 'https://kratos.example.com' },
  };

  it('accepts oathkeeper transport with signerKeys (header defaults kick in)', () => {
    const cfg = loader.load({
      tenants: {
        customer: {
          ...base,
          oathkeeper: { signerKeys: ['kid-1'] },
        },
      },
    });
    expect(cfg.tenants.customer.oathkeeper?.signerKeys).toEqual(['kid-1']);
    expect(cfg.tenants.customer.oathkeeper?.identityHeader).toBe('X-User');
    expect(cfg.tenants.customer.oathkeeper?.signatureHeader).toBe(
      'X-User-Signature',
    );
  });

  it('rejects oathkeeper transport when `oathkeeper` is missing', () => {
    expect(() =>
      loader.load({ tenants: { customer: base } }),
    ).toThrow(IamConfigurationError);
    try {
      loader.load({ tenants: { customer: base } });
    } catch (err) {
      expect((err as Error).message).toMatch(/oathkeeper transport requires/);
      expect((err as Error).message).toMatch(/signerKeys/);
    }
  });

  it('rejects oathkeeper transport with empty signerKeys', () => {
    expect(() =>
      loader.load({
        tenants: {
          customer: { ...base, oathkeeper: { signerKeys: [] } },
        },
      }),
    ).toThrow(IamConfigurationError);
  });

  it('rejects oathkeeper transport with a blank signerKeys entry', () => {
    expect(() =>
      loader.load({
        tenants: {
          customer: { ...base, oathkeeper: { signerKeys: [''] } },
        },
      }),
    ).toThrow(IamConfigurationError);
  });

  it('accepts non-oathkeeper transports without oathkeeper config', () => {
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
