/**
 * Validates the ESLint ban rule:
 *   - Importing from @ory/* is REJECTED in src/services/** (and elsewhere).
 *   - Importing from @ory/* is ALLOWED in src/clients/**, src/dto/mappers/**,
 *     and src/transport/**.
 */
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';

const repoRoot = path.join(__dirname, '..', '..');

function runEslint(file: string): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execSync(`npx eslint "${file}"`, {
      cwd: repoRoot,
      stdio: 'pipe',
    }).toString();
    return { code: 0, stdout, stderr: '' };
  } catch (err: any) {
    return {
      code: err.status ?? 1,
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
    };
  }
}

function withTempFile(rel: string, body: string, run: (abs: string) => void): void {
  const abs = path.join(repoRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf8');
  try {
    run(abs);
  } finally {
    fs.rmSync(abs, { force: true });
  }
}

describe('ESLint @ory/* ban rule', () => {
  const offendingImport = `import type {} from '@ory/client';\nexport {};\n`;

  it('rejects @ory/client import from src/services/**', () => {
    withTempFile('src/services/_ban-test.ts', offendingImport, (abs) => {
      const result = runEslint(abs);
      expect(result.code).not.toBe(0);
      const combined = result.stdout + result.stderr;
      expect(combined).toMatch(/@ory\/client|no-restricted-imports/);
    });
  });

  it('rejects @ory/client import from src/index.ts area (e.g. src/guards)', () => {
    withTempFile('src/guards/_ban-test.ts', offendingImport, (abs) => {
      const result = runEslint(abs);
      expect(result.code).not.toBe(0);
    });
  });

  it('allows @ory/client import inside src/clients/**', () => {
    withTempFile('src/clients/_ban-test.ts', offendingImport, (abs) => {
      const result = runEslint(abs);
      expect(result.code).toBe(0);
    });
  });

  it('allows @ory/client import inside src/dto/mappers/**', () => {
    withTempFile('src/dto/mappers/_ban-test.ts', offendingImport, (abs) => {
      const result = runEslint(abs);
      expect(result.code).toBe(0);
    });
  });

  it('allows @ory/client import inside src/transport/**', () => {
    withTempFile('src/transport/_ban-test.ts', offendingImport, (abs) => {
      const result = runEslint(abs);
      expect(result.code).toBe(0);
    });
  });
});
