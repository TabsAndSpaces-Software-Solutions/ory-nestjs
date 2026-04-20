/**
 * The transport barrel is an INTERNAL entry point — it must expose the
 * transport classes and the factory, and must NOT be re-exported from the
 * public `src/index.ts` (that file must stay Ory-free).
 */
import * as transport from '../../../src/transport';
import * as fs from 'fs';
import * as path from 'path';

describe('src/transport barrel', () => {
  it('exposes all four transport implementations, the interface symbols, and the factory', () => {
    expect(typeof transport.CookieTransport).toBe('function');
    expect(typeof transport.BearerTransport).toBe('function');
    expect(typeof transport.CookieOrBearerTransport).toBe('function');
    expect(typeof transport.OathkeeperTransport).toBe('function');
    expect(typeof transport.TransportFactory).toBe('function');
    expect(typeof transport.extractCookie).toBe('function');
    expect(typeof transport.verifyEnvelopeSignature).toBe('function');
  });

  it('is NOT re-exported from src/index.ts (transports are internal)', () => {
    const repoRoot = path.join(__dirname, '..', '..', '..');
    const contents = fs.readFileSync(path.join(repoRoot, 'src', 'index.ts'), 'utf8');
    // Strip comments so prose does not match.
    const stripped = contents
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(stripped).not.toMatch(/from\s+['"]\.\/transport['"]/);
  });
});
