/**
 * `@Anonymous()` — method-level opt-out with the same public-access semantics
 * as `@Public()`, kept as a distinct metadata key so guards can tell the two
 * intents apart:
 *
 *   - `@Public()` — valid on method and class. Never authenticate.
 *   - `@Anonymous()` — method-level. Authenticate opportunistically but do
 *     not require a session; guards populate `req.user` if present and fall
 *     through to the handler otherwise.
 *
 * Precedence: when both are stacked (class `@Public`, method `@Anonymous`),
 * `Reflector.getAllAndOverride(IS_ANONYMOUS_KEY, [handler, class])` returns
 * the method's `true` — the method wins, and the guard should treat the
 * handler as anonymous rather than strictly public.
 *
 * Pure metadata attacher: no logging, no I/O, no audit emission at
 * decoration time.
 */
import { SetMetadata } from '@nestjs/common';

import { IS_ANONYMOUS_KEY } from './metadata-keys';

export const Anonymous = (): ReturnType<typeof SetMetadata> =>
  SetMetadata(IS_ANONYMOUS_KEY, true);
