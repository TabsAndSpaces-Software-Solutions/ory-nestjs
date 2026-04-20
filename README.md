# ory-nestjs - IAM (Identity & Access Management)

ory-nestjs is a library for NestJS. It is a wrapper for the Ory Stack — a shared
library that multiple NestJS projects can consume for authentication and
authorization. It contains the guards, decorators, and service classes that
integrate with Ory.

When using this library, the consuming application has **no direct dependency
on Ory**; this library abstracts all Ory-related functionality behind a stable,
library-owned API surface.

This library works with both self-hosted Ory and Ory Network (Cloud).

## Module format

v1 ships **CommonJS only** (`main` / `types` point to `dist/`). NestJS runs on
CJS natively, so an ESM entry point is not required at this stage and would
complicate interop with the existing Nest ecosystem. ESM may be added later
without a breaking change.

## Zero-Ory-leakage contract

The package's public entry point (`src/index.ts`) re-exports only
library-defined DTOs, errors, guards, decorators, services, the module, the
testing module, and types. Nothing from `@ory/*` is re-exported — directly or
transitively.

Direct imports from `@ory/*` are only allowed inside the adapter layer:

- `src/clients/**`
- `src/dto/mappers/**`
- `src/transport/**`

This boundary is enforced by an ESLint `no-restricted-imports` rule that fails
CI when violated.

## Commands

From the package root (`packages/ory-nestjs`):

```bash
pnpm install            # install deps
pnpm build              # tsc → dist/
pnpm test               # jest
pnpm lint               # eslint src/**/*.ts
```

`pnpm --filter ory-nestjs <script>` works from the repo root as well, because
pnpm auto-discovers the package.

## Test file naming convention

- `test/unit/**/*.test.ts` — pure unit tests
- `test/contract/**/*.test.ts` — contract tests against stubbed Ory
- `test/integration/**/*.test.ts` — tests against a real Ory instance
- `src/**/*.spec.ts` — co-located unit tests alongside the code they cover

## Runtime dependencies

- `@ory/client` is a **regular dependency** (bundled with the library; never
  a peer).
- `@nestjs/common`, `@nestjs/core`, `reflect-metadata`, and `rxjs` are
  **peer dependencies** supplied by the host NestJS app.
