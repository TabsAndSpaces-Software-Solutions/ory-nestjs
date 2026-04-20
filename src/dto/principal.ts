/**
 * Principal DTOs & type guards.
 *
 * A principal is anything that can act on the system: either a user identity
 * or a machine (OAuth2 client). The discriminator is the presence of
 * `kind === 'machine'` on the machine shape; `IamIdentity` has no `kind`
 * field.
 *
 * Zero-Ory-leakage contract: this file MUST NOT import from `@ory/*`.
 */
import type { IamIdentity } from './identity';
import type { TenantName } from './tenant';

export interface IamMachinePrincipal {
  readonly kind: 'machine';
  readonly clientId: string;
  readonly scope: readonly string[];
  readonly tenant: TenantName;
}

/** A principal is either a user identity or a machine OAuth2 client. */
export type IamPrincipal = IamIdentity | IamMachinePrincipal;

/** True iff `x` is a machine principal (`kind === 'machine'`). */
export function isMachinePrincipal(x: unknown): x is IamMachinePrincipal {
  return (
    typeof x === 'object' &&
    x !== null &&
    (x as { kind?: unknown }).kind === 'machine'
  );
}

/**
 * True iff `x` is a user identity principal — an object whose shape is a
 * `IamIdentity`. We discriminate by the absence of `kind === 'machine'`.
 */
export function isUserPrincipal(x: unknown): x is IamIdentity {
  if (typeof x !== 'object' || x === null) {
    return false;
  }
  if ((x as { kind?: unknown }).kind === 'machine') {
    return false;
  }
  // A user identity carries an id — cheap shape check.
  return typeof (x as { id?: unknown }).id === 'string';
}
