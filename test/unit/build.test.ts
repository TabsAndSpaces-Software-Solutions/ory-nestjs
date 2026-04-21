/**
 * Validates that `pnpm build` (tsup) produces the dual-format dist layout
 * documented in package.json's `exports` field:
 *
 *   - dist/index.js      — CommonJS runtime
 *   - dist/index.mjs     — ESM runtime
 *   - dist/index.d.ts    — Declarations for CJS consumers
 *   - dist/index.d.mts   — Declarations for ESM consumers (TS requires both
 *                          when the package uses `.mjs` extensions)
 *
 * This test actually runs the build, so it is slightly slow.
 */
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';

const repoRoot = path.join(__dirname, '..', '..');
const distDir = path.join(repoRoot, 'dist');

const REQUIRED_OUTPUTS = [
  'index.js',
  'index.mjs',
  'index.d.ts',
  'index.d.mts',
];

describe('build output', () => {
  beforeAll(() => {
    if (fs.existsSync(distDir)) {
      fs.rmSync(distDir, { recursive: true, force: true });
    }
    execSync('npx tsup', { cwd: repoRoot, stdio: 'pipe' });
  }, 120_000);

  it.each(REQUIRED_OUTPUTS)('produces dist/%s', (name) => {
    expect(fs.existsSync(path.join(distDir, name))).toBe(true);
  });

  it('the CJS bundle is loadable via require()', () => {
    // Loads through the install path consumers hit (Node resolves the
    // package's `main` field for CJS). Smoke-tests the runtime's ability to
    // parse and execute the bundle.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(path.join(distDir, 'index.js')) as Record<string, unknown>;
    expect(mod).toBeTruthy();
    // Spot-check a known symbol — IamModule is the primary public export.
    expect(mod.IamModule).toBeDefined();
  });

  it('the CJS declarations export IamModule as a type-bearing symbol', () => {
    const dts = fs.readFileSync(path.join(distDir, 'index.d.ts'), 'utf8');
    expect(dts).toMatch(/IamModule/);
  });

  // Regression guard for the 0.1.1 publish incident: esbuild/tsup silently
  // stripped `design:paramtypes` metadata, which NestJS needs to resolve
  // constructor params that lack an explicit `@Inject(...)` — every guard
  // failed to boot in consumer apps as a result. The build config now
  // emits metadata; this assertion ensures a future toolchain change
  // cannot regress without a loud CI failure.
  it.each(['index.js', 'index.mjs'])(
    '%s carries design:paramtypes metadata (NestJS DI needs it)',
    (name) => {
      const content = fs.readFileSync(path.join(distDir, name), 'utf8');
      expect(content).toMatch(/"design:paramtypes"/);
    },
  );

  // Additional floor: the library ships ≥10 injectable classes with
  // constructor deps (guards + services + factory); any sane metadata
  // emitter produces at least one `design:paramtypes` entry per class.
  // A degenerate "one metadata call total" or similar toolchain regression
  // would slip past the existence check above.
  it.each(['index.js', 'index.mjs'])(
    '%s emits decorator metadata for every guard + service class',
    (name) => {
      const content = fs.readFileSync(path.join(distDir, name), 'utf8');
      const metadataCount = (content.match(/"design:paramtypes"/g) ?? []).length;
      expect(metadataCount).toBeGreaterThanOrEqual(10);
    },
  );

  // Also assert that the primary consumer-facing guard emits metadata
  // whose first paramtype is Reflector. This is the exact class + slot
  // that broke in 0.1.1: SessionGuard's `Reflector` param (index 0) has
  // no `@Inject(...)` decorator, so it relies entirely on emit-decorator-
  // metadata. We scan for the emitted fragment. Matches either tsup's
  // esbuild output (`__metadata`) or tsc's helper (`_ts_metadata`).
  it('SessionGuard metadata includes Reflector as the first constructor paramtype', () => {
    const content = fs.readFileSync(path.join(distDir, 'index.js'), 'utf8');
    // Metadata-block signatures used across esbuild/tsc/swc helpers.
    const hasMetadataBlock = /(?:__metadata|_ts_metadata\d*)\(["']design:paramtypes["'],\s*\[[^\]]*Reflector/.test(
      content,
    );
    expect(hasMetadataBlock).toBe(true);
  });
});
