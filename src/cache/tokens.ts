/**
 * DI token for the injectable `SessionCache` instance.
 *
 * `Symbol.for` is used so identity survives module reloads (jest watch,
 * HMR scenarios). This token is exported from the package barrel so
 * consumers can register custom backends via `{ provide: SESSION_CACHE,
 * useClass: MyRedisSessionCache }` in their own module if they prefer
 * NestJS-style provider wiring over passing an instance through
 * `IamModule.forRoot({ sessionCache })`.
 */
export const SESSION_CACHE: unique symbol = Symbol.for('ory-nestjs/session-cache');
