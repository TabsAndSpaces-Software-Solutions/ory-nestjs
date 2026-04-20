/**
 * `@RequireRole(...roles)` — gate a handler or controller behind one of the
 * listed roles. Semantics are OR: the principal needs to hold at least one
 * of the listed roles for the guard to permit the request.
 *
 * Validation is eager — the decorator throws at decoration time if:
 *   - no roles are supplied (empty call), or
 *   - any role is not a non-empty string.
 *
 * This surfaces the misuse at module-load, not at request time. Pure
 * metadata attacher otherwise: no logging, no I/O, no audit emission.
 */
import { SetMetadata } from '@nestjs/common';

import { REQUIRED_ROLES_KEY } from './metadata-keys';

export const RequireRole = (
  ...roles: string[]
): ReturnType<typeof SetMetadata> => {
  if (roles.length === 0) {
    throw new Error('@RequireRole requires at least one role');
  }
  for (const r of roles) {
    if (typeof r !== 'string' || r.length === 0) {
      throw new Error('@RequireRole roles must be non-empty strings');
    }
  }
  return SetMetadata(REQUIRED_ROLES_KEY, roles);
};
