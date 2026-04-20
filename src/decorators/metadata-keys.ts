/**
 * Internal metadata keys for the `ory-nestjs` decorator surface.
 *
 * Consumers must NOT import these — they are consumed by this library's own
 * guards (later units) and by the decorators defined alongside. The barrel
 * at `src/decorators/index.ts` re-exports them for intra-package use, but
 * `src/index.ts` (the library's public entry) does NOT.
 *
 * Implementation notes:
 *   - Symbols avoid string-key collisions with third-party libraries that
 *     also use NestJS `SetMetadata` / `Reflector`.
 *   - `Symbol.for(...)` registers in the global Symbol registry, making the
 *     keys identity-stable across duplicate module loads (jest, bundlers
 *     that split chunks, etc.) which otherwise produce fresh `Symbol(...)`
 *     instances that do not compare equal.
 *   - `Reflector.getAllAndOverride` accepts symbols, strings, or custom
 *     tokens — see https://docs.nestjs.com/guards#putting-it-all-together
 */
export const IS_PUBLIC_KEY: unique symbol = Symbol.for('ory-nestjs/is-public');
export const IS_ANONYMOUS_KEY: unique symbol = Symbol.for(
  'ory-nestjs/is-anonymous',
);
export const TENANT_KEY: unique symbol = Symbol.for('ory-nestjs/tenant');
export const REQUIRED_ROLES_KEY: unique symbol = Symbol.for(
  'ory-nestjs/required-roles',
);
export const REQUIRED_PERMISSION_KEY: unique symbol = Symbol.for(
  'ory-nestjs/required-permission',
);
