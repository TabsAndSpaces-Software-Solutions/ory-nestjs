/**
 * Unit tests for the internal DI tokens used by the client layer.
 * These MUST NOT be re-exported from src/index.ts.
 */
import * as path from 'path';
import * as fs from 'fs';

import { TENANT_CLIENTS_TOKEN } from '../../../src/clients/internal-tokens';

describe('clients/internal-tokens', () => {
  it('exports a unique symbol-like string token for TENANT_CLIENTS_TOKEN', () => {
    expect(typeof TENANT_CLIENTS_TOKEN).toBe('string');
    expect((TENANT_CLIENTS_TOKEN as string).length).toBeGreaterThan(0);
  });

  it('is NOT re-exported from src/index.ts (textual guard)', () => {
    const idx = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'src', 'index.ts'),
      'utf8',
    );
    expect(idx).not.toMatch(/TENANT_CLIENTS_TOKEN/);
    expect(idx).not.toMatch(/from\s+['"]\.\/clients/);
  });
});
