/**
 * Unit tests for the `TenantClients` struct — purely a type-export smoke
 * test. The struct has no runtime surface, so this test only verifies the
 * file exists and re-exports the expected names.
 */
import * as path from 'path';
import * as fs from 'fs';

describe('clients/tenant-clients', () => {
  const file = path.join(__dirname, '..', '..', '..', 'src', 'clients', 'tenant-clients.ts');

  it('exists', () => {
    expect(fs.existsSync(file)).toBe(true);
  });

  it('declares the TenantClients interface', () => {
    const contents = fs.readFileSync(file, 'utf8');
    expect(contents).toMatch(/interface\s+TenantClients/);
    expect(contents).toMatch(/kratosFrontend/);
    expect(contents).toMatch(/kratosIdentity\?/);
    expect(contents).toMatch(/ketoPermission\?/);
    expect(contents).toMatch(/ketoRelationship\?/);
    expect(contents).toMatch(/hydraOauth2\?/);
  });
});
