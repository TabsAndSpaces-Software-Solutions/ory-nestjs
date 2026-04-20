/**
 * Integration test runner config for ory-nestjs.
 *
 * Separate from `jest.config.js` (which runs unit + contract suites) so
 * `pnpm test` stays fast and Docker-free, while `pnpm test:integration`
 * boots a full Kratos + Postgres stack via testcontainers.
 *
 * Key settings:
 *   - globalSetup / globalTeardown bring up and tear down the stack once
 *     per run.
 *   - `runInBand` is enforced by passing --runInBand at the script level;
 *     we intentionally do NOT set `maxWorkers: 1` here so developers can
 *     override when iterating on a single spec.
 *   - 120s test timeout: container cold-start + multiple HTTP round trips
 *     make the default 5s too tight.
 */
/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/test/integration'],
  testMatch: ['**/test/integration/specs/**/*.int.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.test.json',
      },
    ],
  },
  testTimeout: 120_000,
  globalSetup: '<rootDir>/test/integration/harness/global-setup.ts',
  globalTeardown: '<rootDir>/test/integration/harness/global-teardown.ts',
};
