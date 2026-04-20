/**
 * Barrel for the `ory-nestjs` decorator surface — consumer-facing only.
 *
 * Metadata keys (`IS_PUBLIC_KEY`, `TENANT_KEY`, ...) are intentionally NOT
 * exported here. They are internal to the library's guards; consumers
 * should never read them directly. Guards import them from
 * `./metadata-keys` inside the package.
 *
 * Zero-Ory-leakage contract: nothing in this folder imports from `@ory/*`.
 */
export { Public } from './public.decorator';
export { Anonymous } from './anonymous.decorator';
export { Tenant } from './tenant.decorator';
export { RequireRole } from './require-role.decorator';
export {
  RequirePermission,
  type RequirePermissionSpec,
  type RequirePermissionObjectResolver,
} from './require-permission.decorator';
export { CurrentUser, type CurrentUserValue } from './current-user.decorator';
