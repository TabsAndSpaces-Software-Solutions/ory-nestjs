/**
 * `TransportFactory` — selects the right `SessionTransport` implementation
 * for a tenant based on `tenantConfig.transport`, optionally wrapping it
 * with a `CachingSessionTransport` when the tenant has
 * `cache.sessionTtlMs > 0` and a `SessionCache` backend is registered.
 *
 * DI lifecycle
 * ------------
 * Registered as a module-scoped singleton on `IamModule`. The injected
 * `SessionCache` is the backend the consumer wired via
 * `IamModule.forRoot({ sessionCache })` or by overriding the
 * `SESSION_CACHE` token in their own module. When no backend is provided
 * the module installs a `NoopSessionCache` default, which still satisfies
 * the `SessionCache` contract — but the factory sees `sessionTtlMs === 0`
 * for every tenant (enforced by the module boot check) and therefore never
 * wraps the inner transport.
 *
 * Why take the cache as a constructor dep rather than a method argument:
 * the three call sites (SessionGuard, OptionalSessionGuard, SessionService)
 * should not each have to know about the cache. Hiding it inside the
 * factory keeps the cache wiring a single-module-assembly concern.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';

import { SESSION_CACHE, type SessionCache } from '../cache';
import type { TenantConfig } from '../config';
import { BearerTransport } from './bearer.transport';
import { CachingSessionTransport } from './caching-session.transport';
import { CookieTransport } from './cookie.transport';
import { CookieOrBearerTransport } from './cookie-or-bearer.transport';
import { OathkeeperTransport } from './oathkeeper.transport';
import type { SessionTransport } from './session-transport.interface';

@Injectable()
export class TransportFactory {
  constructor(
    @Optional() @Inject(SESSION_CACHE) private readonly cache?: SessionCache,
  ) {}

  public forTenant(tenantConfig: TenantConfig): SessionTransport {
    const base = this.buildBase(tenantConfig);
    const ttlMs = tenantConfig.cache?.sessionTtlMs ?? 0;
    if (ttlMs > 0 && this.cache !== undefined) {
      return new CachingSessionTransport(base, this.cache, {
        sessionTtlMs: ttlMs,
      });
    }
    return base;
  }

  private buildBase(tenantConfig: TenantConfig): SessionTransport {
    switch (tenantConfig.transport) {
      case 'cookie':
        return new CookieTransport();
      case 'bearer':
        return new BearerTransport();
      case 'cookie-or-bearer':
        return new CookieOrBearerTransport();
      case 'oathkeeper':
        return new OathkeeperTransport();
      default: {
        const unknownKind: string = String(
          (tenantConfig as { transport?: unknown }).transport,
        );
        throw new Error(
          `TransportFactory: unsupported transport kind '${unknownKind}'`,
        );
      }
    }
  }
}
