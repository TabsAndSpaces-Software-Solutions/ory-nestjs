/**
 * Validates TypeScript configuration:
 *   - strict mode on
 *   - target ES2022
 *   - moduleResolution node
 *   - declaration + sourceMap on
 *   - tsc --noEmit runs cleanly
 */
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';

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

  it('passes tsc --noEmit on a clean checkout', () => {
    // If this throws, the spec is violated.
    expect(() => {
      execSync('npx tsc --noEmit -p tsconfig.json', {
        cwd: repoRoot,
        stdio: 'pipe',
      });
    }).not.toThrow();
  });
});

describe('tsconfig.build.json', () => {
  it('exists and extends tsconfig.json', () => {
    const cfg = readTsconfig('tsconfig.build.json');
    expect(cfg.extends).toBeTruthy();
  });
});
