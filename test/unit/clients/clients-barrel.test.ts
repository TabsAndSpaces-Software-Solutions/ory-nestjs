/**
 * The `src/clients/index.ts` barrel is INTERNAL — it exists so the
 * adapter layer can import a single file, but it must not be re-exported
 * from `src/index.ts` or the zero-Ory-leakage contract would break.
 */
import * as path from 'path';
import * as fs from 'fs';

const clientsBarrelPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'src',
  'clients',
  'index.ts',
);
const publicIndexPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'src',
  'index.ts',
);

describe('clients internal barrel', () => {
  it('exists', () => {
    expect(fs.existsSync(clientsBarrelPath)).toBe(true);
  });

  it('re-exports the factories and correlation storage', () => {
    const contents = fs.readFileSync(clientsBarrelPath, 'utf8');
    expect(contents).toMatch(/AxiosFactory/);
    expect(contents).toMatch(/OryClientFactory/);
    expect(contents).toMatch(/correlationStorage/);
    expect(contents).toMatch(/TENANT_CLIENTS_TOKEN/);
  });

  it('is NOT re-exported from src/index.ts', () => {
    const contents = fs.readFileSync(publicIndexPath, 'utf8');
    // No import/export from ./clients in the public barrel.
    expect(contents).not.toMatch(/from\s+['"]\.\/clients['"]|\.\/clients\//);
  });

  it('src/index.ts contains no @ory reference (re-assert post-clients)', () => {
    const contents = fs.readFileSync(publicIndexPath, 'utf8');
    const noBlockComments = contents.replace(/\/\*[\s\S]*?\*\//g, '');
    const noLineComments = noBlockComments.replace(/^\s*\/\/.*$/gm, '');
    expect(noLineComments).not.toMatch(/@ory\//);
  });
});
