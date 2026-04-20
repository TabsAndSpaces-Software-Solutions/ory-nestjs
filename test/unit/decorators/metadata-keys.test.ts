/**
 * Metadata keys for the decorator surface.
 *
 * These are internal constants — only the guards (and these decorators)
 * consume them. They MUST NOT be re-exported from `src/index.ts`.
 *
 * They are Symbols (via `Symbol.for` so they survive module duplication in
 * tooling) to avoid string-key collisions with third-party libraries that
 * also use `SetMetadata`.
 */
import {
  IS_PUBLIC_KEY,
  IS_ANONYMOUS_KEY,
  TENANT_KEY,
  REQUIRED_ROLES_KEY,
  REQUIRED_PERMISSION_KEY,
} from '../../../src/decorators/metadata-keys';

describe('decorator metadata keys', () => {
  it('are symbols registered in the global Symbol registry', () => {
    expect(typeof IS_PUBLIC_KEY).toBe('symbol');
    expect(typeof IS_ANONYMOUS_KEY).toBe('symbol');
    expect(typeof TENANT_KEY).toBe('symbol');
    expect(typeof REQUIRED_ROLES_KEY).toBe('symbol');
    expect(typeof REQUIRED_PERMISSION_KEY).toBe('symbol');
  });

  it('use the ory-nestjs namespace so they do not collide with other libs', () => {
    expect(Symbol.keyFor(IS_PUBLIC_KEY)).toBe('ory-nestjs/is-public');
    expect(Symbol.keyFor(IS_ANONYMOUS_KEY)).toBe('ory-nestjs/is-anonymous');
    expect(Symbol.keyFor(TENANT_KEY)).toBe('ory-nestjs/tenant');
    expect(Symbol.keyFor(REQUIRED_ROLES_KEY)).toBe('ory-nestjs/required-roles');
    expect(Symbol.keyFor(REQUIRED_PERMISSION_KEY)).toBe(
      'ory-nestjs/required-permission',
    );
  });

  it('are all distinct from each other', () => {
    const keys = new Set([
      IS_PUBLIC_KEY,
      IS_ANONYMOUS_KEY,
      TENANT_KEY,
      REQUIRED_ROLES_KEY,
      REQUIRED_PERMISSION_KEY,
    ]);
    expect(keys.size).toBe(5);
  });
});
