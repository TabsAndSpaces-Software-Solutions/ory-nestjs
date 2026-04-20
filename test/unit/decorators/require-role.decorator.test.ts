/**
 * `@RequireRole(...roles)` — stamps a non-empty list of roles with OR
 * semantics (principal needs at least one of the listed roles).
 *
 * Validation is eager: `@RequireRole()` with no args throws, and
 * `@RequireRole('')` with a non-string / empty string throws — the error
 * surfaces at module-load rather than at request time.
 */
import 'reflect-metadata';

import { RequireRole } from '../../../src/decorators/require-role.decorator';
import { REQUIRED_ROLES_KEY } from '../../../src/decorators/metadata-keys';

describe('@RequireRole()', () => {
  it('stamps a single role as an array', () => {
    class Ctrl {
      @RequireRole('admin')
      handler(): void {
        return;
      }
    }
    expect(
      Reflect.getMetadata(REQUIRED_ROLES_KEY, Ctrl.prototype.handler),
    ).toEqual(['admin']);
  });

  it('stamps multiple roles preserving order (OR semantics)', () => {
    class Ctrl {
      @RequireRole('admin', 'operator')
      handler(): void {
        return;
      }
    }
    expect(
      Reflect.getMetadata(REQUIRED_ROLES_KEY, Ctrl.prototype.handler),
    ).toEqual(['admin', 'operator']);
  });

  it('is valid on a class', () => {
    @RequireRole('admin')
    class Ctrl {}
    expect(Reflect.getMetadata(REQUIRED_ROLES_KEY, Ctrl)).toEqual(['admin']);
  });

  it('throws if called with no roles', () => {
    expect(() => RequireRole()).toThrow(/at least one role/);
  });

  it('throws if any role is an empty string', () => {
    expect(() => RequireRole('')).toThrow(/non-empty string/);
    expect(() => RequireRole('admin', '')).toThrow(/non-empty string/);
  });

  it('throws if any role is not a string', () => {
    expect(() =>
      (RequireRole as unknown as (...r: unknown[]) => unknown)('admin', 123),
    ).toThrow(/non-empty string/);
  });
});
