/**
 * `@RequirePermission({ namespace, relation, object })` — gate a handler or
 * controller behind a Keto-style relation check.
 *
 * The `object` field supports two shapes:
 *   - A literal string: the resource id is known statically at decoration
 *     time (e.g. `"config"` for a singleton resource).
 *   - A resolver `(req) => string | undefined`: extract the id from the
 *     incoming request (path params, body, query). The resolver MUST be
 *     pure — guards call it synchronously per request.
 *
 * Validation is eager: any mis-shaped spec throws at decoration time.
 * Decorators never log or emit audit events — only the guard does that
 * when it evaluates the metadata at request time.
 */
import { SetMetadata } from '@nestjs/common';

import { REQUIRED_PERMISSION_KEY } from './metadata-keys';

/** Shape of the resolver form of `object`. */
export type RequirePermissionObjectResolver = (
  req: unknown,
) => string | undefined;

/** Declarative spec consumed by the permission guard. */
export interface RequirePermissionSpec {
  readonly namespace: string;
  readonly relation: string;
  readonly object: string | RequirePermissionObjectResolver;
}

export const RequirePermission = (
  spec: RequirePermissionSpec,
): ReturnType<typeof SetMetadata> => {
  if (spec === null || typeof spec !== 'object') {
    throw new Error('@RequirePermission requires a spec object');
  }
  if (typeof spec.namespace !== 'string' || spec.namespace.length === 0) {
    throw new Error(
      '@RequirePermission spec.namespace must be a non-empty string',
    );
  }
  if (typeof spec.relation !== 'string' || spec.relation.length === 0) {
    throw new Error(
      '@RequirePermission spec.relation must be a non-empty string',
    );
  }
  const isObjectString =
    typeof spec.object === 'string' && spec.object.length > 0;
  const isObjectFn = typeof spec.object === 'function';
  if (!isObjectString && !isObjectFn) {
    throw new Error(
      '@RequirePermission spec.object must be a non-empty string or a (req) => string | undefined resolver',
    );
  }
  return SetMetadata(REQUIRED_PERMISSION_KEY, spec);
};
