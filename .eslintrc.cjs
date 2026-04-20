/**
 * ESLint config for ory-nestjs.
 *
 * Key rule: bans any import from `@ory/*` across the `src/` tree EXCEPT
 * inside the adapter layer:
 *   - src/clients/**
 *   - src/dto/mappers/**
 *   - src/transport/**
 *
 * This enforces the zero-Ory-leakage public surface contract.
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  env: {
    node: true,
    es2022: true,
    jest: true,
  },
  ignorePatterns: ['dist/', 'coverage/', 'node_modules/', 'test/', '*.cjs', '*.config.ts', 'jest.config.ts'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: ['@ory/*'],
            message:
              'Direct imports from @ory/* are only allowed inside the adapter layer (src/clients/**, src/dto/mappers/**, src/transport/**). Everything else must go through DTOs and services to keep the public surface Ory-free.',
          },
        ],
      },
    ],
  },
  overrides: [
    {
      files: [
        'src/clients/**/*.ts',
        'src/dto/mappers/**/*.ts',
        'src/transport/**/*.ts',
      ],
      rules: {
        'no-restricted-imports': 'off',
      },
    },
  ],
};
