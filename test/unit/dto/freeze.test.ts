/**
 * Tests for the deepFreeze helper used by every mapper to guarantee
 * immutability of returned DTO instances.
 */
import { deepFreeze } from '../../../src/dto/freeze';

describe('deepFreeze', () => {
  it('freezes a flat object', () => {
    const o = deepFreeze({ a: 1, b: 'hi' });
    expect(Object.isFrozen(o)).toBe(true);
  });

  it('freezes nested objects recursively', () => {
    const o = deepFreeze({ a: { b: { c: 1 } } });
    expect(Object.isFrozen(o)).toBe(true);
    expect(Object.isFrozen((o as any).a)).toBe(true);
    expect(Object.isFrozen((o as any).a.b)).toBe(true);
  });

  it('freezes arrays and their elements', () => {
    const o = deepFreeze({ xs: [{ a: 1 }, { a: 2 }] });
    expect(Object.isFrozen((o as any).xs)).toBe(true);
    expect(Object.isFrozen((o as any).xs[0])).toBe(true);
    expect(Object.isFrozen((o as any).xs[1])).toBe(true);
  });

  it('does not throw on already-frozen inputs', () => {
    const inner = Object.freeze({ a: 1 });
    const outer = { inner };
    expect(() => deepFreeze(outer)).not.toThrow();
    expect(Object.isFrozen(outer)).toBe(true);
  });

  it('handles primitives without throwing', () => {
    expect(() => deepFreeze(42 as unknown as object)).not.toThrow();
    expect(() => deepFreeze('hello' as unknown as object)).not.toThrow();
    expect(() => deepFreeze(null as unknown as object)).not.toThrow();
    expect(() => deepFreeze(undefined as unknown as object)).not.toThrow();
  });

  it('returns the same reference', () => {
    const o = { a: 1 };
    const frozen = deepFreeze(o);
    expect(frozen).toBe(o);
  });

  it('prevents property mutation in strict mode', () => {
    'use strict';
    const o = deepFreeze({ a: 1 });
    expect(() => {
      (o as any).a = 2;
    }).toThrow();
  });
});
