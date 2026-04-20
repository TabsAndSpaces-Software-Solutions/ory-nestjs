/**
 * Post-validation behaviour of `ConfigLoader.load()`:
 *   - result is deep-frozen (mutation throws in strict mode)
 *   - sub-object defaults are populated
 *   - the loader never mutates the caller's input object
 */
import { ConfigLoader } from '../../../src/config/config-loader.service';

describe('ConfigLoader.load — freeze + defaults', () => {
  const loader = new ConfigLoader();

  const baseInput = () => ({
    tenants: {
      customer: {
        mode: 'self-hosted' as const,
        transport: 'bearer' as const,
        kratos: { publicUrl: 'https://kratos.example.com' },
        logging: {},
        cache: {},
      },
    },
  });

  it('returns a deep-frozen config (top level)', () => {
    const cfg = loader.load(baseInput());
    expect(Object.isFrozen(cfg)).toBe(true);
  });

  it('returns a deep-frozen config (nested tenant)', () => {
    const cfg = loader.load(baseInput());
    expect(Object.isFrozen(cfg.tenants)).toBe(true);
    expect(Object.isFrozen(cfg.tenants.customer)).toBe(true);
    expect(Object.isFrozen(cfg.tenants.customer.kratos)).toBe(true);
  });

  it('throws (strict mode) when mutating a nested property', () => {
    const cfg = loader.load(baseInput());
    expect(() => {
      (cfg.tenants.customer.kratos as { publicUrl: string }).publicUrl =
        'https://evil.example.com';
    }).toThrow(TypeError);
  });

  it('throws (strict mode) when adding a new tenant post-load', () => {
    const cfg = loader.load(baseInput());
    expect(() => {
      (cfg.tenants as Record<string, unknown>).intruder = {};
    }).toThrow(TypeError);
  });

  it('populates logging.level default of "info"', () => {
    const cfg = loader.load(baseInput());
    expect(cfg.tenants.customer.logging?.level).toBe('info');
  });

  it('populates cache TTL defaults of 0', () => {
    const cfg = loader.load(baseInput());
    expect(cfg.tenants.customer.cache?.sessionTtlMs).toBe(0);
    expect(cfg.tenants.customer.cache?.permissionTtlMs).toBe(0);
    expect(cfg.tenants.customer.cache?.jwksTtlMs).toBe(0);
  });

  it('does not freeze the caller input object', () => {
    const input = baseInput();
    loader.load(input);
    // The caller's object must still be mutable; we freeze the *parsed*
    // result, which zod returns as a fresh object.
    expect(Object.isFrozen(input)).toBe(false);
  });
});
