/**
 * Barrel for library-owned DTOs.
 *
 * Zero-Ory-leakage contract: this file MUST NOT re-export anything from
 * `@ory/*`, directly or transitively. Mappers live under `./mappers/` and
 * are re-exported here explicitly — they are allowed to import `@ory/*`
 * internally, but their public signatures use only library DTOs.
 */
export * from './tenant';
export * from './identity';
export * from './session';
export * from './permission';
export * from './token';
export * from './principal';
export * from './flow';
export * from './audit';
export { deepFreeze } from './freeze';
