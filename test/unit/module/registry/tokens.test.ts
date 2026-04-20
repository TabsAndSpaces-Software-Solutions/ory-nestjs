/**
 * Unit tests for the `TENANT_REGISTRY` DI token.
 *
 * The token identifies the `TenantRegistry` provider inside the internal
 * NestJS container. Like every adapter-layer identifier it must NEVER be
 * re-exported from `src/index.ts`.
 */
import * as path from 'path';
import * as fs from 'fs';

import { TENANT_REGISTRY } from '../../../../src/module/registry/tokens';

describe('module/registry/tokens', () => {
  it('exports a Symbol for TENANT_REGISTRY', () => {
    expect(typeof TENANT_REGISTRY).toBe('symbol');
  });

  it('uses Symbol.for so the token is stable across module reloads', () => {
    expect(TENANT_REGISTRY).toBe(Symbol.for('ory-nestjs/tenant-registry'));
  });

  it('is distinct from TENANT_CLIENTS_TOKEN', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { TENANT_CLIENTS_TOKEN } = require('../../../../src/clients/internal-tokens');
    expect((TENANT_REGISTRY as unknown) !== (TENANT_CLIENTS_TOKEN as unknown)).toBe(true);
  });

  it('is NOT re-exported from src/index.ts (textual guard)', () => {
    const idx = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', '..', 'src', 'index.ts'),
      'utf8',
    );
    // Neither the token identifier nor the internal registry subpath may
    // appear anywhere on the public-surface barrel. The `./module` barrel
    // is allowed (it exports IamModule + public option types), but the
    // deeper registry path would leak internal DI.
    expect(idx).not.toMatch(/TENANT_REGISTRY/);
    expect(idx).not.toMatch(/from\s+['"]\.\/module\/registry/);
  });

  it('is NOT re-exported from the module barrel (textual guard)', () => {
    const barrel = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', '..', 'src', 'module', 'index.ts'),
      'utf8',
    );
    expect(barrel).not.toMatch(/TENANT_REGISTRY/);
    expect(barrel).not.toMatch(/TenantRegistry/);
    expect(barrel).not.toMatch(/from\s+['"]\.\/registry/);
  });
});
