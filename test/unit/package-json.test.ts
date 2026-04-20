/**
 * Validates that package.json satisfies the public surface contract:
 *   - correct name & privacy
 *   - semver version ≥ 0.1.0 (reserved 0.0.x for pre-dual-build prototypes)
 *   - `exports` map covers both CJS and ESM with correct field order
 *   - `main`/`module`/`types` kept as fallbacks for legacy resolvers
 *   - @ory/client in dependencies (NEVER peerDependencies)
 *   - @nestjs/common, @nestjs/core, reflect-metadata, rxjs in peerDependencies
 */
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require(path.join(__dirname, '..', '..', 'package.json'));

describe('package.json', () => {
  it('is named ory-nestjs', () => {
    expect(pkg.name).toBe('ory-nestjs');
  });

  it('is private', () => {
    expect(pkg.private).toBe(true);
  });

  it('declares legacy main/module/types entry points as dist fallbacks', () => {
    expect(pkg.main).toBe('./dist/index.js');
    expect(pkg.module).toBe('./dist/index.mjs');
    expect(pkg.types).toBe('./dist/index.d.ts');
  });

  describe('exports map', () => {
    it('routes CJS consumers to dist/index.js with matching .d.ts types', () => {
      expect(pkg.exports['.'].require.default).toBe('./dist/index.js');
      expect(pkg.exports['.'].require.types).toBe('./dist/index.d.ts');
    });

    it('routes ESM consumers to dist/index.mjs with matching .d.mts types', () => {
      // Nested `types` inside each condition prevents the "masquerading as
      // CJS" dual-package hazard that @arethetypeswrong/cli flags.
      expect(pkg.exports['.'].import.default).toBe('./dist/index.mjs');
      expect(pkg.exports['.'].import.types).toBe('./dist/index.d.mts');
    });

    it('declares `types` FIRST within each conditional export', () => {
      const importConditions = Object.keys(pkg.exports['.'].import);
      const requireConditions = Object.keys(pkg.exports['.'].require);
      expect(importConditions[0]).toBe('types');
      expect(requireConditions[0]).toBe('types');
    });

    it('exposes package.json so consumer tooling can introspect the manifest', () => {
      expect(pkg.exports['./package.json']).toBe('./package.json');
    });
  });

  it('version is at least 0.1.0 (dual-build ships as 0.1.x)', () => {
    const major = Number((pkg.version as string).split('.')[0]);
    const minor = Number((pkg.version as string).split('.')[1]);
    expect(major > 0 || minor >= 1).toBe(true);
  });

  it('declares @ory/client in dependencies, not peerDependencies', () => {
    expect(pkg.dependencies).toBeDefined();
    expect(pkg.dependencies['@ory/client']).toBeTruthy();

    if (pkg.peerDependencies) {
      expect(pkg.peerDependencies['@ory/client']).toBeUndefined();
    }
  });

  it('declares NestJS + reflect-metadata + rxjs as peerDependencies', () => {
    expect(pkg.peerDependencies).toBeDefined();
    expect(pkg.peerDependencies['@nestjs/common']).toBeTruthy();
    expect(pkg.peerDependencies['@nestjs/core']).toBeTruthy();
    expect(pkg.peerDependencies['reflect-metadata']).toBeTruthy();
    expect(pkg.peerDependencies['rxjs']).toBeTruthy();
  });

  it('does not put NestJS libs in regular dependencies', () => {
    const deps = pkg.dependencies ?? {};
    expect(deps['@nestjs/common']).toBeUndefined();
    expect(deps['@nestjs/core']).toBeUndefined();
    expect(deps['reflect-metadata']).toBeUndefined();
    expect(deps['rxjs']).toBeUndefined();
  });

  it('has build, test, test:integration, lint scripts', () => {
    expect(pkg.scripts).toBeDefined();
    expect(pkg.scripts.build).toBeTruthy();
    expect(pkg.scripts.test).toBeTruthy();
    expect(pkg.scripts['test:integration']).toBeTruthy();
    expect(pkg.scripts.lint).toBeTruthy();
  });
});
