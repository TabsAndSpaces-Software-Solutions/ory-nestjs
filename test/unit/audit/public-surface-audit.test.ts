/**
 * Verifies that the library's public entry point (`src/index.ts`) exposes the
 * audit module: AuditSink (interface — checked via DI token + class presence),
 * AUDIT_SINK, AUDIT_EVENT_NAMES, Redactor, and LoggerAuditSink.
 *
 * IamAuditEvent is re-exported via `src/dto/` and is NOT re-exported by the
 * audit barrel (to avoid double exports).
 */
import * as publicSurface from '../../../src';

describe('src/index.ts — audit exports', () => {
  it('exports AUDIT_SINK (DI token)', () => {
    const mod = publicSurface as Record<string, unknown>;
    expect(typeof mod.AUDIT_SINK).toBe('symbol');
  });

  it('exports AUDIT_EVENT_NAMES with all 16 event names', () => {
    const mod = publicSurface as Record<string, unknown>;
    const names = mod.AUDIT_EVENT_NAMES as readonly string[];
    expect(Array.isArray(names)).toBe(true);
    expect(names).toHaveLength(16);
  });

  it('exports Redactor and LoggerAuditSink as constructors', () => {
    const mod = publicSurface as Record<string, unknown>;
    expect(typeof mod.Redactor).toBe('function');
    expect(typeof mod.LoggerAuditSink).toBe('function');
  });

  it('does not re-export IamAuditEvent a second time (single export via dto)', () => {
    // Runtime-level check: the DTO is a TypeScript interface, so the only
    // guarantee we can assert is that the audit barrel did not add a value
    // named `IamAuditEvent`. This is a structural smoke test.
    const mod = publicSurface as Record<string, unknown>;
    // If both exported a runtime value, tsc would error first. This assertion
    // just confirms there's no accidental runtime conflict.
    expect(mod.IamAuditEvent).toBeUndefined();
  });
});
