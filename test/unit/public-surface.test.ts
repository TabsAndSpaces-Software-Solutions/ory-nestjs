/**
 * Guards the zero-Ory-leakage public surface:
 * src/index.ts must not contain any @ory/* reference (import or export).
 *
 * This is a textual guard; combined with the ESLint ban-rule and the
 * adapter-layer boundary, it makes it very hard to accidentally leak
 * Ory types through the library's public API.
 */
import * as path from 'path';
import * as fs from 'fs';

const repoRoot = path.join(__dirname, '..', '..');
const indexPath = path.join(repoRoot, 'src', 'index.ts');

describe('src/index.ts public surface', () => {
  it('exists as the single public entry point', () => {
    expect(fs.existsSync(indexPath)).toBe(true);
  });

  it('does not mention @ory/ anywhere', () => {
    const contents = fs.readFileSync(indexPath, 'utf8');
    // Strip comments so doc prose can mention Ory.
    const noBlockComments = contents.replace(/\/\*[\s\S]*?\*\//g, '');
    const noLineComments = noBlockComments.replace(/^\s*\/\/.*$/gm, '');
    expect(noLineComments).not.toMatch(/@ory\//);
  });

  it('only uses import/export statements from local paths', () => {
    const contents = fs.readFileSync(indexPath, 'utf8');
    const noBlockComments = contents.replace(/\/\*[\s\S]*?\*\//g, '');
    const noLineComments = noBlockComments.replace(/^\s*\/\/.*$/gm, '');

    // Collect all quoted module specifiers in import/export statements.
    const reImportExport =
      /(?:import|export)\s+(?:type\s+)?[^'";]*from\s+['"]([^'"]+)['"]/g;
    const reBareImport = /import\s+['"]([^'"]+)['"]/g;
    const reDynamicExport = /export\s+\*\s+from\s+['"]([^'"]+)['"]/g;

    const specifiers: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = reImportExport.exec(noLineComments))) specifiers.push(m[1]);
    while ((m = reBareImport.exec(noLineComments))) specifiers.push(m[1]);
    while ((m = reDynamicExport.exec(noLineComments))) specifiers.push(m[1]);

    for (const spec of specifiers) {
      // Allow only relative imports (./foo, ../foo) — no @ory/*, no bare
      // packages that could pull Ory types into the public surface.
      expect(spec.startsWith('.')).toBe(true);
    }
  });
});
