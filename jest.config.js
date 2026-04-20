/**
 * Jest config for ory-nestjs.
 *
 * Test file naming convention:
 *   - Unit tests: test/unit/**\/*.test.ts or test/unit/**\/*.spec.ts
 *   - Contract tests: test/contract/**\/*.test.ts
 *   - Integration tests: test/integration/specs/**\/*.int.test.ts
 *   - Co-located tests (alongside the code): src/**\/*.spec.ts
 *
 * Integration specs are excluded from the default runner — they require a
 * live Kratos stack (see `pnpm test:integration` + `jest.integration.config.js`).
 */
/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testMatch: [
    '**/test/**/*.test.ts',
    '**/test/**/*.spec.ts',
    '**/src/**/*.test.ts',
    '**/src/**/*.spec.ts',
  ],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    '/test/integration/',
  ],
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/**/index.ts'],
  coverageDirectory: 'coverage',
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.test.json',
      },
    ],
  },
};
