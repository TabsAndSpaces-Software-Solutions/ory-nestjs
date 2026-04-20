/**
 * `@Public()` — opt a handler (or an entire controller) out of the
 * authentication guard.
 *
 * Valid on both methods and classes. When used at the class level, every
 * handler in that controller is public; individual handlers can still be
 * re-secured by a method-level guard if the consuming app so chooses.
 *
 * Precedence: when resolving via `Reflector.getAllAndOverride(IS_PUBLIC_KEY,
 * [handler, class])`, the method-level value wins. `@Anonymous()` is the
 * method-level equivalent that lets a handler explicitly opt INTO public
 * semantics even when the class is not annotated.
 *
 * Pure metadata attacher: no logging, no I/O, no audit emission at
 * decoration time.
 */
import { SetMetadata } from '@nestjs/common';

import { IS_PUBLIC_KEY } from './metadata-keys';

export const Public = (): ReturnType<typeof SetMetadata> =>
  SetMetadata(IS_PUBLIC_KEY, true);
