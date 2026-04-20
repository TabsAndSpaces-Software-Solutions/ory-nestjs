/**
 * Hygiene tests for the mapper layer.
 *
 * Validates:
 *   - mappers live under src/dto/mappers/ (structural)
 *   - all five required mapper files exist
 *   - a barrel exports each mapper so consumers can import them from
 *     a single path
 */
import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.join(__dirname, '..', '..', '..');
const mappersDir = path.join(repoRoot, 'src', 'dto', 'mappers');

describe('mappers layout', () => {
  it.each([
    'identity.mapper.ts',
    'session.mapper.ts',
    'permission.mapper.ts',
    'flow.mapper.ts',
    'token.mapper.ts',
  ])('has %s', (file) => {
    expect(fs.existsSync(path.join(mappersDir, file))).toBe(true);
  });

  it('exposes a barrel (src/dto/mappers/index.ts) re-exporting each mapper', () => {
    const barrel = path.join(mappersDir, 'index.ts');
    expect(fs.existsSync(barrel)).toBe(true);
    const body = fs.readFileSync(barrel, 'utf8');
    // Strip comments before matching.
    const stripped = body
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const name of [
      './identity.mapper',
      './session.mapper',
      './permission.mapper',
      './flow.mapper',
      './token.mapper',
    ]) {
      expect(stripped).toContain(name);
    }
  });
});

describe('mapper runtime barrel', () => {
  it('loads and exposes each mapper as an object', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../../../src/dto/mappers');
    expect(typeof mod.identityMapper).toBe('object');
    expect(typeof mod.sessionMapper).toBe('object');
    expect(typeof mod.permissionMapper).toBe('object');
    expect(typeof mod.flowMapper).toBe('object');
    expect(typeof mod.tokenMapper).toBe('object');
  });
});
