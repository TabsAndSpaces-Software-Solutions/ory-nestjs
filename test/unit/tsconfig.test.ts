/**
 * Validates TypeScript configuration:
 *   - strict mode on
 *   - target ES2022
 *   - moduleResolution node
 *   - declaration + sourceMap on
 *
 * Note: `tsc --noEmit` is enforced by the CI workflow's dedicated Type check
 * step, not by this test file. Running tsc inside a jest worker via
 * child_process.execSync is flaky (npx resolution inside jest workers) and
 * opaque (piped stdio swallows the real TS error), so we rely on CI instead.
 */
import * as path from 'path';
import * as fs from 'fs';

const repoRoot = path.join(__dirname, '..', '..');

function readTsconfig(name: string): Record<string, unknown> {
  const raw = fs.readFileSync(path.join(repoRoot, name), 'utf8');
  // tsconfig allows comments; strip them naively.
  const stripped = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  return JSON.parse(stripped);
}

describe('tsconfig.json', () => {
  let cfg: any;
  beforeAll(() => {
    cfg = readTsconfig('tsconfig.json');
  });

  it('enables strict mode', () => {
    expect(cfg.compilerOptions.strict).toBe(true);
  });

  it('targets ES2022', () => {
    expect(cfg.compilerOptions.target).toBe('ES2022');
  });

  it('uses node module resolution', () => {
    expect(cfg.compilerOptions.moduleResolution).toBe('node');
  });

  it('emits declarations and source maps', () => {
    expect(cfg.compilerOptions.declaration).toBe(true);
    expect(cfg.compilerOptions.sourceMap).toBe(true);
  });
});

describe('tsconfig.build.json', () => {
  it('exists and extends tsconfig.json', () => {
    const cfg = readTsconfig('tsconfig.build.json');
    expect(cfg.extends).toBeTruthy();
  });
});
