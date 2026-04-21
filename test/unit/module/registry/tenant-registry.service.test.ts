/**
 * Unit tests for `TenantRegistry` — the single source of truth that maps a
 * `TenantName` to its `TenantClients` bundle.
 *
 * The registry is constructed eagerly: at init it invokes a client-builder
 * function for every declared tenant, caches the result, and records the
 * resolved `defaultTenant`. Unknown-name lookups via `get()` throw a loud
 * `IamConfigurationError`; `tryGet()` returns `undefined`.
 *
 * These tests stub the client builder with a Jest spy so no real Ory URL is
 * contacted. `ValidatedIamOptions` is the shape after `ConfigLoader.load`
 * has applied defaults, so fixtures below construct that shape directly.
 */
import type { TenantClients } from '../../../../src/clients';
import type {
  ValidatedTenantConfig,
  ValidatedIamOptions,
} from '../../../../src/config';
import type { TenantName } from '../../../../src/dto';
import { IamConfigurationError } from '../../../../src/errors';
import { TenantRegistry } from '../../../../src/module/registry/tenant-registry.service';

function tenantConfig(publicUrl: string): ValidatedTenantConfig {
  return {
    mode: 'self-hosted',
    transport: 'bearer',
    kratos: {
      publicUrl,
      sessionCookieName: 'ory_kratos_session',
    },
  } as ValidatedTenantConfig;
}

function fakeClients(tenant: TenantName, config: ValidatedTenantConfig): TenantClients {
  return {
    tenant,
    config,
    // The registry never inspects these — the spy just needs to return a
    // recognisable object that is reference-equal across calls.
    axios: {} as TenantClients['axios'],
    kratosFrontend: {} as TenantClients['kratosFrontend'],
  };
}

function optionsWith(
  tenants: Record<string, ValidatedTenantConfig>,
  defaultTenant?: string,
): ValidatedIamOptions {
  return {
    tenants,
    defaultTenant,
    global: true,
  } as unknown as ValidatedIamOptions;
}

describe('TenantRegistry', () => {
  describe('construction', () => {
    it('invokes the builder once per declared tenant and caches results', () => {
      const build = jest.fn<TenantClients, [TenantName, ValidatedTenantConfig]>(
        (name, cfg) => fakeClients(name, cfg),
      );
      const opts = optionsWith(
        {
          customer: tenantConfig('https://customer.test'),
          admin: tenantConfig('https://admin.test'),
        },
        'customer',
      );

      const registry = new TenantRegistry(opts, build);

      expect(build).toHaveBeenCalledTimes(2);
      expect(build).toHaveBeenCalledWith('customer', opts.tenants['customer']);
      expect(build).toHaveBeenCalledWith('admin', opts.tenants['admin']);
      expect(registry.list().sort()).toEqual(['admin', 'customer']);
    });

    it('throws IamConfigurationError if zero tenants are declared', () => {
      // ConfigLoader already rejects this upstream; Registry defends at
      // construction time too.
      const build = jest.fn();
      const opts = optionsWith({});

      expect(() => new TenantRegistry(opts, build)).toThrow(
        IamConfigurationError,
      );
      expect(build).not.toHaveBeenCalled();
    });

    it('wraps builder failures in IamConfigurationError with tenant context', () => {
      const build = jest.fn((name: TenantName): TenantClients => {
        if (name === 'broken') {
          throw new Error('upstream axios boom');
        }
        return fakeClients(name, tenantConfig('https://ok.test'));
      });
      const opts = optionsWith(
        {
          ok: tenantConfig('https://ok.test'),
          broken: tenantConfig('https://broken.test'),
        },
        'ok',
      );

      let caught: unknown;
      try {
        new TenantRegistry(opts, build);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(IamConfigurationError);
      expect((caught as Error).message).toMatch(/broken/);
    });

    it('throws if `defaultTenant` is set to a name not present in tenants', () => {
      // ConfigLoader already rejects this; Registry defends too.
      const build = jest.fn((name: TenantName, cfg: ValidatedTenantConfig) =>
        fakeClients(name, cfg),
      );
      const opts = optionsWith(
        { solo: tenantConfig('https://solo.test') },
        'ghost',
      );

      expect(() => new TenantRegistry(opts, build)).toThrow(
        IamConfigurationError,
      );
    });
  });

  describe('defaultTenant()', () => {
    it('returns the explicitly-configured defaultTenant when set', () => {
      const build = jest.fn((name: TenantName, cfg: ValidatedTenantConfig) =>
        fakeClients(name, cfg),
      );
      const opts = optionsWith(
        {
          customer: tenantConfig('https://customer.test'),
          admin: tenantConfig('https://admin.test'),
        },
        'admin',
      );
      const registry = new TenantRegistry(opts, build);
      expect(registry.defaultTenant()).toBe('admin');
    });

    it('derives the default when exactly one tenant is declared', () => {
      const build = jest.fn((name: TenantName, cfg: ValidatedTenantConfig) =>
        fakeClients(name, cfg),
      );
      const opts = optionsWith({ solo: tenantConfig('https://solo.test') });
      const registry = new TenantRegistry(opts, build);
      expect(registry.defaultTenant()).toBe('solo');
    });

    it('returns undefined when multiple tenants are declared and no defaultTenant is set', () => {
      // This branch is unreachable through `ConfigLoader` (it rejects the
      // input), but Registry must still return undefined defensively if
      // another caller bypasses the loader.
      const build = jest.fn((name: TenantName, cfg: ValidatedTenantConfig) =>
        fakeClients(name, cfg),
      );
      const opts = optionsWith({
        a: tenantConfig('https://a.test'),
        b: tenantConfig('https://b.test'),
      });
      const registry = new TenantRegistry(opts, build);
      expect(registry.defaultTenant()).toBeUndefined();
    });
  });

  describe('get() / tryGet() / list()', () => {
    it('get(name) throws IamConfigurationError for unknown tenants', () => {
      const build = jest.fn((name: TenantName, cfg: ValidatedTenantConfig) =>
        fakeClients(name, cfg),
      );
      const opts = optionsWith({ solo: tenantConfig('https://solo.test') });
      const registry = new TenantRegistry(opts, build);

      expect(() => registry.get('nope')).toThrow(IamConfigurationError);
      try {
        registry.get('nope');
      } catch (err) {
        expect((err as Error).message).toMatch(/unknown tenant: nope/);
      }
    });

    it('tryGet(name) returns undefined for unknown tenants', () => {
      const build = jest.fn((name: TenantName, cfg: ValidatedTenantConfig) =>
        fakeClients(name, cfg),
      );
      const opts = optionsWith({ solo: tenantConfig('https://solo.test') });
      const registry = new TenantRegistry(opts, build);

      expect(registry.tryGet('nope')).toBeUndefined();
    });

    it('tryGet(name) returns the same TenantClients instance as get(name) for known tenants', () => {
      const build = jest.fn((name: TenantName, cfg: ValidatedTenantConfig) =>
        fakeClients(name, cfg),
      );
      const opts = optionsWith({ solo: tenantConfig('https://solo.test') });
      const registry = new TenantRegistry(opts, build);

      expect(registry.tryGet('solo')).toBe(registry.get('solo'));
    });

    it('get(name) returns the same TenantClients instance across repeated calls (idempotent)', () => {
      const build = jest.fn((name: TenantName, cfg: ValidatedTenantConfig) =>
        fakeClients(name, cfg),
      );
      const opts = optionsWith(
        {
          customer: tenantConfig('https://customer.test'),
          admin: tenantConfig('https://admin.test'),
        },
        'customer',
      );
      const registry = new TenantRegistry(opts, build);

      const first = registry.get('customer');
      const second = registry.get('customer');
      const third = registry.get('customer');
      expect(first).toBe(second);
      expect(second).toBe(third);
      // Builder is NOT re-invoked on subsequent lookups.
      expect(build).toHaveBeenCalledTimes(2);
    });

    it('list() returns every declared tenant name', () => {
      const build = jest.fn((name: TenantName, cfg: ValidatedTenantConfig) =>
        fakeClients(name, cfg),
      );
      const opts = optionsWith(
        {
          customer: tenantConfig('https://customer.test'),
          admin: tenantConfig('https://admin.test'),
          beta: tenantConfig('https://beta.test'),
        },
        'customer',
      );
      const registry = new TenantRegistry(opts, build);
      expect(registry.list().sort()).toEqual(['admin', 'beta', 'customer']);
    });
  });
});
