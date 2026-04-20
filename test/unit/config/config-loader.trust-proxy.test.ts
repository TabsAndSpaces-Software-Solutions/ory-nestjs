/**
 * Production `trustProxy` refinement: when `NODE_ENV === 'production'` and
 * the tenant uses a cookie-bearing transport (`cookie` or `cookie-or-bearer`),
 * the tenant MUST explicitly set `trustProxy: true`. This is a correctness
 * check for proxy-chained deployments — forgetting it silently breaks
 * secure-cookie and session-domain handling.
 *
 * `process.env.NODE_ENV` is mutated per-test and restored in an afterEach so
 * the environment never leaks between tests.
 */
import { ConfigLoader } from '../../../src/config/config-loader.service';
import { IamConfigurationError } from '../../../src/errors';

describe('ConfigLoader.load — production trustProxy refinement', () => {
  const loader = new ConfigLoader();
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  const kratos = { publicUrl: 'https://kratos.example.com' };

  describe('in production', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
    });

    it('rejects cookie transport without trustProxy: true', () => {
      expect(() =>
        loader.load({
          tenants: {
            customer: { mode: 'self-hosted', transport: 'cookie', kratos },
          },
        }),
      ).toThrow(IamConfigurationError);
    });

    it('rejects cookie-or-bearer transport without trustProxy: true', () => {
      expect(() =>
        loader.load({
          tenants: {
            customer: {
              mode: 'self-hosted',
              transport: 'cookie-or-bearer',
              kratos,
            },
          },
        }),
      ).toThrow(IamConfigurationError);
    });

    it('rejects cookie transport with trustProxy: false (explicit opt-out)', () => {
      expect(() =>
        loader.load({
          tenants: {
            customer: {
              mode: 'self-hosted',
              transport: 'cookie',
              kratos,
              trustProxy: false,
            },
          },
        }),
      ).toThrow(IamConfigurationError);
    });

    it('accepts cookie transport with trustProxy: true', () => {
      const cfg = loader.load({
        tenants: {
          customer: {
            mode: 'self-hosted',
            transport: 'cookie',
            kratos,
            trustProxy: true,
          },
        },
      });
      expect(cfg.tenants.customer.trustProxy).toBe(true);
    });

    it('accepts cookie-or-bearer transport with trustProxy: true', () => {
      expect(() =>
        loader.load({
          tenants: {
            customer: {
              mode: 'self-hosted',
              transport: 'cookie-or-bearer',
              kratos,
              trustProxy: true,
            },
          },
        }),
      ).not.toThrow();
    });

    it('does not require trustProxy for bearer-only transport', () => {
      expect(() =>
        loader.load({
          tenants: {
            customer: { mode: 'self-hosted', transport: 'bearer', kratos },
          },
        }),
      ).not.toThrow();
    });
  });

  describe('outside production', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'development';
    });

    it('allows cookie transport without trustProxy in development', () => {
      expect(() =>
        loader.load({
          tenants: {
            customer: { mode: 'self-hosted', transport: 'cookie', kratos },
          },
        }),
      ).not.toThrow();
    });

    it('allows cookie transport without trustProxy when NODE_ENV is "test"', () => {
      process.env.NODE_ENV = 'test';
      expect(() =>
        loader.load({
          tenants: {
            customer: {
              mode: 'self-hosted',
              transport: 'cookie-or-bearer',
              kratos,
            },
          },
        }),
      ).not.toThrow();
    });
  });
});
