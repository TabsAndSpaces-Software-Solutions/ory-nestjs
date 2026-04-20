/**
 * `@Tenant(name)` — scope a handler or controller to a specific tenant. The
 * guard uses this to validate the resolved principal's tenant matches.
 *
 * Valid on method and class; method-level wins. The decorator validates its
 * argument at decoration time — it throws for empty/non-string names so the
 * error surfaces at module-load rather than request-time.
 */
import 'reflect-metadata';
import { Reflector } from '@nestjs/core';

import { Tenant } from '../../../src/decorators/tenant.decorator';
import { TENANT_KEY } from '../../../src/decorators/metadata-keys';

describe('@Tenant()', () => {
  it('stamps the tenant name on a method', () => {
    class Ctrl {
      @Tenant('customer')
      handler(): void {
        return;
      }
    }

    expect(Reflect.getMetadata(TENANT_KEY, Ctrl.prototype.handler)).toBe(
      'customer',
    );
  });

  it('stamps the tenant name on a class', () => {
    @Tenant('dealer')
    class Ctrl {}

    expect(Reflect.getMetadata(TENANT_KEY, Ctrl)).toBe('dealer');
  });

  it('method-level @Tenant overrides class-level via getAllAndOverride', () => {
    @Tenant('customer')
    class Ctrl {
      @Tenant('dealer')
      handler(): void {
        return;
      }
    }

    const reflector = new Reflector();
    const value = reflector.getAllAndOverride<string>(TENANT_KEY, [
      Ctrl.prototype.handler,
      Ctrl,
    ]);
    expect(value).toBe('dealer');
  });

  it('throws at decoration time if name is empty', () => {
    expect(() => Tenant('')).toThrow(/@Tenant.*non-empty string/);
  });

  it('throws at decoration time if name is not a string', () => {
    // Mis-use from JS: TS would reject this, but we defend at runtime too.
    expect(() => (Tenant as unknown as (n: unknown) => unknown)(undefined)).toThrow(
      /@Tenant.*non-empty string/,
    );
    expect(() => (Tenant as unknown as (n: unknown) => unknown)(123)).toThrow(
      /@Tenant.*non-empty string/,
    );
  });
});
