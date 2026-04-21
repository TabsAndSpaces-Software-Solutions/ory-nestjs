/**
 * tsup — emits dual CJS + ESM + a single `.d.ts` from `src/index.ts`.
 *
 * Why tsup
 * --------
 * Dual-format output from a single source tree requires extension-rewriting
 * (ESM's `import './foo'` needs to become `'./foo.js'` at runtime under
 * Node's native resolver). `tsc` alone can't do this without either
 * source-code changes or NodeNext — both of which leak through to the
 * public surface. tsup + esbuild handle the rewrite automatically while
 * keeping the source canonical.
 *
 * Decorator metadata
 * ------------------
 * NestJS relies on `emitDecoratorMetadata` for DI. esbuild supports this
 * via `tsconfig.compilerOptions.emitDecoratorMetadata` which we already
 * have set in `tsconfig.json`. tsup picks it up automatically.
 *
 * External deps
 * -------------
 * We do NOT bundle. Every runtime dep (including `@ory/client`, `axios`,
 * and the NestJS peerDeps) must stay external so consumer apps get a
 * single copy via their own node_modules. tsup's default for libraries is
 * to externalize `dependencies` and `peerDependencies`.
 *
 * Types
 * -----
 * `dts: true` runs tsc under the hood using `tsconfig.build.json`, so the
 * zero-Ory-leakage contract enforced by `src/index.ts` + ESLint carries
 * through to declaration emit unchanged.
 */
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  // `dts: true` emits `.d.ts` for the entry without bundling external
  // declarations. We intentionally don't set `resolve: true` because the
  // rollup-based declaration bundler chokes on `node:*` builtins (e.g.
  // `node:async_hooks`) — and we don't need to inline third-party types
  // into our declaration anyway.
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node18',
  tsconfig: './tsconfig.build.json',
  // `splitting: false` keeps the output as a single file per format — the
  // NestJS decorator graph is order-sensitive and has historically been
  // fragile under code splitting.
  splitting: false,
  // Keep class names so Nest's error messages reference the right class.
  keepNames: true,
});

/*
 * Why `@swc/core` is a devDependency of this package
 * --------------------------------------------------
 * esbuild alone does NOT emit `design:paramtypes` metadata, which NestJS
 * DI requires to resolve any constructor parameter that lacks an explicit
 * `@Inject(...)`. tsup wires up `@swc/core` as a plugin when it's present
 * and delegates decorator-metadata emission to it; when `@swc/core` is
 * absent tsup prints:
 *
 *   "You have emitDecoratorMetadata enabled but @swc/core was not
 *    installed, skipping swc plugin"
 *
 * ...and the bundle silently ships without metadata — consumer guards
 * then fail to boot with `Nest can't resolve dependencies`. This was the
 * root cause of the 0.1.1 incident. `@swc/core` MUST stay listed in
 * `devDependencies` so `npm ci` installs it; the build-time assertions
 * in `test/unit/build.test.ts` verify metadata is actually emitted.
 */

