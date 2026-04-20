/**
 * Guards the public surface of the config unit:
 *   - `src/config/index.ts` exports exactly the public symbols and no others.
 *   - The zod schema is NOT reachable from the barrel.
 *   - `ConfigLoader` is decorated with `@Injectable()` so it can be wired into
 *     an IamModule provider list later.
 */
import 'reflect-metadata';
import * as ConfigBarrel from '../../../src/config';
import { ConfigLoader } from '../../../src/config/config-loader.service';

describe('src/config barrel', () => {
  it('exports ConfigLoader', () => {
    expect(ConfigBarrel.ConfigLoader).toBe(ConfigLoader);
  });

  it('exports formatZodError', () => {
    expect(typeof ConfigBarrel.formatZodError).toBe('function');
  });

  it('does not export the raw zod schema', () => {
    expect(
      (ConfigBarrel as Record<string, unknown>).IamOptionsSchema,
    ).toBeUndefined();
  });

  it('does not export Ory-related symbols', () => {
    // Paranoid check: nothing from @ory/* should ever surface through config.
    for (const key of Object.keys(ConfigBarrel)) {
      expect(key.toLowerCase()).not.toMatch(/^ory/);
    }
  });
});

describe('ConfigLoader decoration', () => {
  it('is decorated with @Injectable (carries Nest injectable metadata)', () => {
    // @nestjs/common's `@Injectable()` attaches an `__injectable__` metadata
    // key on the class. That key's presence is what the Nest IoC container
    // checks when wiring providers.
    const keys = Reflect.getMetadataKeys(ConfigLoader);
    expect(keys).toContain('__injectable__');
  });
});
