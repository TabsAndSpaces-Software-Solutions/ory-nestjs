/**
 * `@Tenant(name)` — scope a handler or controller to a named tenant. The
 * guard (later unit) uses this to assert the resolved principal's tenant
 * matches; requests arriving at a mismatched tenant are rejected with a
 * typed library error.
 *
 * Valid on methods and classes. When stacked, method-level wins:
 * `Reflector.getAllAndOverride(TENANT_KEY, [handler, class])` returns the
 * method's value when present.
 *
 * The decorator validates its argument at decoration time — mis-use throws
 * synchronously so the error surfaces at module-load rather than at request
 * time. This is the only I/O-like action a decorator performs.
 */
import { SetMetadata } from '@nestjs/common';

import { TENANT_KEY } from './metadata-keys';

export const Tenant = (name: string): ReturnType<typeof SetMetadata> => {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('@Tenant(name) requires a non-empty string');
  }
  return SetMetadata(TENANT_KEY, name);
};
