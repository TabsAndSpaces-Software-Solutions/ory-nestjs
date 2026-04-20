/**
 * Hygiene tests for the `src/testing/**` tree:
 *   - NO `@ory/*` imports (stubs must be hermetic — see spec unit `tst`).
 *   - `src/testing/index.ts` exports `IamTestingModule` and
 *     `IamTestingOptions` (and the `TESTING_STATE` token + `TestingState`
 *     for tests that want to mutate state after construction).
 *   - Stub-only files (guards/, services/) are NOT re-exported from the
 *     testing barrel — they are library-internals.
 *   - `src/index.ts` re-exports `./testing`.
 */
import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.join(__dirname, '..', '..', '..');
const testingDir = path.join(repoRoot, 'src', 'testing');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('src/testing hygiene', () => {
  it('contains no @ory/* imports', () => {
    const files = walk(testingDir);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const contents = fs.readFileSync(file, 'utf8');
      // Strip comments so doc prose can mention Ory.
      const noBlockComments = contents.replace(/\/\*[\s\S]*?\*\//g, '');
      const noLineComments = noBlockComments.replace(/^\s*\/\/.*$/gm, '');
      expect({ file, source: noLineComments }).toEqual({
        file,
        source: expect.not.stringMatching(/@ory\//),
      });
    }
  });

  it('contains no network-I/O primitives (axios / fetch / http.request / node:http)', () => {
    const files = walk(testingDir);
    // These are substrings that must NEVER appear in the stub tree.
    const forbidden = [
      /from ['"]axios['"]/,
      /from ['"]node:http['"]/,
      /from ['"]http['"]/,
      /from ['"]https['"]/,
      /\bfetch\(/,
    ];
    for (const file of files) {
      const contents = fs.readFileSync(file, 'utf8');
      const noBlockComments = contents.replace(/\/\*[\s\S]*?\*\//g, '');
      const noLineComments = noBlockComments.replace(/^\s*\/\/.*$/gm, '');
      for (const pat of forbidden) {
        expect({ file, pat: pat.source, src: noLineComments }).toEqual({
          file,
          pat: pat.source,
          src: expect.not.stringMatching(pat),
        });
      }
    }
  });

  it('testing barrel exports public symbols only', () => {
    const barrel = path.join(testingDir, 'index.ts');
    expect(fs.existsSync(barrel)).toBe(true);
    const src = fs.readFileSync(barrel, 'utf8');

    // Must export these.
    expect(src).toMatch(/IamTestingModule/);
    expect(src).toMatch(/IamTestingOptions/);
    expect(src).toMatch(/TESTING_STATE/);
    expect(src).toMatch(/TestingState/);

    // Must NOT re-export stubs (library-internal).
    expect(src).not.toMatch(/Fake(Session|Permission|OAuth2)Guard/);
    expect(src).not.toMatch(/Stub[A-Za-z]+Service/);
  });

  it('root src/index.ts re-exports ./testing', () => {
    const root = path.join(repoRoot, 'src', 'index.ts');
    const src = fs.readFileSync(root, 'utf8');
    expect(src).toMatch(/\.\/testing/);
  });
});
