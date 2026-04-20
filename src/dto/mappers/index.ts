/**
 * Barrel for Ory -> library-DTO mappers.
 *
 * Each mapper is a small object with `fromOry...` methods; all functions
 * are pure and return deeply-frozen DTOs. The adapter layer (clients,
 * services) uses these mappers to stop @ory/client types at the boundary.
 */
export * from './identity.mapper';
export * from './session.mapper';
export * from './permission.mapper';
export * from './flow.mapper';
export * from './token.mapper';
