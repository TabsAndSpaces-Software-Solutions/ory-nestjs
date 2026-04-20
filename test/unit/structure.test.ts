/**
 * Validates that the source tree contains all the placeholder folders
 * later units expect. Each placeholder folder has a .gitkeep so it
 * survives git commits.
 */
import * as path from 'path';
import * as fs from 'fs';

const repoRoot = path.join(__dirname, '..', '..');

const REQUIRED_SRC_DIRS = [
  'module',
  'config',
  'clients',
  'transport',
  'guards',
  'decorators',
  'services',
  'dto',
  'dto/mappers',
  'errors',
  'audit',
  'health',
  'testing',
  'cache',
];

const REQUIRED_TEST_DIRS = ['unit', 'contract', 'integration'];

describe('placeholder folder structure', () => {
  it.each(REQUIRED_SRC_DIRS)('src/%s exists and is a directory', (sub) => {
    const p = path.join(repoRoot, 'src', sub);
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.statSync(p).isDirectory()).toBe(true);
  });

  it.each(REQUIRED_TEST_DIRS)('test/%s exists and is a directory', (sub) => {
    const p = path.join(repoRoot, 'test', sub);
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.statSync(p).isDirectory()).toBe(true);
  });
});
