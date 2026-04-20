/**
 * Public barrel for the `ory-nestjs` module-assembly unit.
 *
 * Exported:
 *   - `IamModule` — the DynamicModule consumers register.
 *   - `IamAsyncOptions` / `IamOptionsFactory` — the shapes the
 *     consumer supplies to `forRootAsync`.
 *
 * NOT exported (intentionally internal):
 *   - The internal tenant registry token / service (lives under
 *     ./registry/) — only library-owned guards, services, and the health
 *     indicator resolve them.
 *   - The dev-only public-routes warner bootstrap hook.
 *   - The raw/validated options symbols and the tenant-clients builder
 *     token.
 */
export { IamModule } from './ory-nestjs.module';
export type {
  IamAsyncOptions,
  IamOptionsFactory,
} from './ory-nestjs-options.interface';
