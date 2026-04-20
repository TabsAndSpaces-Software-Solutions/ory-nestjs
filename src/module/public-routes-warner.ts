/**
 * `PublicRoutesWarner` — dev-only observability hook.
 *
 * Implements `OnApplicationBootstrap` so it runs after every provider
 * instantiation (including the consumer's own controllers). Walks the DI
 * container via `DiscoveryService`, inspects each controller's handlers for
 * the library's internal `IS_PUBLIC_KEY` metadata, and logs a single
 * warning line per discovered `@Public()` handler.
 *
 * The warning is best-effort: if a handler has `@Public()` applied via a
 * decorator that doesn't use NestJS `SetMetadata` under the hood, it won't
 * show up — we never want this to crash boot. Every exception is caught and
 * swallowed with a single diagnostic line.
 *
 * Gate: the warner is only *registered* in non-production; the class itself
 * always executes when instantiated. See `IamModule.coreProviders` for
 * the gating.
 */
import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';

import { IS_PUBLIC_KEY } from '../decorators/metadata-keys';

@Injectable()
export class PublicRoutesWarner implements OnApplicationBootstrap {
  private readonly logger = new Logger('OryNestjs.PublicRoutes');

  public constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
  ) {}

  public onApplicationBootstrap(): void {
    let entries: string[] = [];
    try {
      entries = this.collectPublicRoutes();
    } catch (err) {
      // Never crash boot just to log a dev warning.
      this.logger.debug(
        `PublicRoutesWarner failed to scan routes: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }

    if (entries.length === 0) return;

    this.logger.warn(
      `@Public() routes registered (bypass authentication): ${entries.join(
        ', ',
      )}`,
    );
  }

  private collectPublicRoutes(): string[] {
    const results: string[] = [];
    const controllers = this.discovery.getControllers();

    for (const wrapper of controllers) {
      const instance = wrapper.instance as Record<string, unknown> | undefined;
      if (instance === undefined || instance === null) continue;
      const proto = Object.getPrototypeOf(instance) as object | null;
      if (proto === null) continue;

      const controllerName =
        (wrapper.metatype as { name?: string } | null)?.name ??
        'UnknownController';

      // Check controller-level metadata.
      const ctor = wrapper.metatype as unknown;
      if (ctor !== undefined && ctor !== null) {
        const classFlag = Reflect.getMetadata(IS_PUBLIC_KEY, ctor as object);
        if (classFlag === true) {
          results.push(`${controllerName} (class-level)`);
        }
      }

      // Scan handlers.
      const methodNames = this.scanner.getAllMethodNames(proto);
      for (const method of methodNames) {
        const handler = (instance as Record<string, unknown>)[method];
        if (typeof handler !== 'function') continue;
        const methodFlag = Reflect.getMetadata(
          IS_PUBLIC_KEY,
          handler as object,
        );
        if (methodFlag === true) {
          results.push(`${controllerName}.${method}`);
        }
      }
    }

    return results;
  }
}
