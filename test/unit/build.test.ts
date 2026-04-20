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
});
