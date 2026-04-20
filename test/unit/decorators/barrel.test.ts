/**
 * Barrel + public-surface guards for the decorator module.
 *
 *   - `src/decorators/index.ts` re-exports the consumer-facing decorators.
 *   - It does NOT re-export metadata keys — those are internal to guards.
 *   - `src/index.ts` re-exports `./decorators`, so consumers pull them from
 *     `ory-nestjs`.
 *   - No decorator file imports from `@ory/*` — the zero-Ory-leakage
 *     contract on the public surface demands it.
 */
import * as path from 'path';
import * as fs from 'fs';

const repoRoot = path.join(__dirname, '..', '..', '..');
const decoratorsDir = path.join(repoRoot, 'src', 'decorators');

describe('src/decorators barrel', () => {
  it('exports the consumer decorators', async () => {
    const mod = await import(path.join(decoratorsDir, 'index'));
    expect(typeof mod.Public).toBe('function');
    expect(typeof mod.Anonymous).toBe('function');
    expect(typeof mod.Tenant).toBe('function');
    expect(typeof mod.RequireRole).toBe('function');
    expect(typeof mod.RequirePermission).toBe('function');
    expect(typeof mod.CurrentUser).toBe('function');
  });

  it('does NOT export metadata keys from the barrel', async () => {
    const mod = (await import(path.join(decoratorsDir, 'index'))) as Record<
      string,
      unknown
    >;
    for (const banned of [
      'IS_PUBLIC_KEY',
      'IS_ANONYMOUS_KEY',
      'TENANT_KEY',
      'REQUIRED_ROLES_KEY',
      'REQUIRED_PERMISSION_KEY',
    ]) {
      expect(mod[banned]).toBeUndefined();
    }
  });

  it('src/index.ts re-exports ./decorators', () => {
    const indexSrc = fs.readFileSync(
      path.join(repoRoot, 'src', 'index.ts'),
      'utf8',
    );
    expect(indexSrc).toMatch(/export \* from '\.\/decorators'/);
  });

  it('src/index.ts does NOT re-export metadata keys transitively', async () => {
    const mod = (await import(path.join(repoRoot, 'src', 'index'))) as Record<
      string,
      unknown
    >;
    for (const banned of [
      'IS_PUBLIC_KEY',
      'IS_ANONYMOUS_KEY',
      'TENANT_KEY',
      'REQUIRED_ROLES_KEY',
      'REQUIRED_PERMISSION_KEY',
    ]) {
      expect(mod[banned]).toBeUndefined();
    }
  });

  it('no decorator file imports from @ory/*', () => {
    const files = fs
      .readdirSync(decoratorsDir)
      .filter((f) => f.endsWith('.ts'));
    for (const f of files) {
      const src = fs.readFileSync(path.join(decoratorsDir, f), 'utf8');
      expect(src).not.toMatch(/from\s+['"]@ory\//);
    }
  });
});
