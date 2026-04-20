/**
 * Unit tests for `correlationStorage`, the per-request AsyncLocalStorage
 * instance threaded through the axios request-id interceptor.
 */
import { correlationStorage } from '../../../src/clients/correlation-storage';

describe('correlationStorage', () => {
  it('is an AsyncLocalStorage-like object with run() and getStore()', () => {
    expect(typeof correlationStorage.run).toBe('function');
    expect(typeof correlationStorage.getStore).toBe('function');
  });

  it('exposes the store inside a run() callback', () => {
    const store = { correlationId: 'abc-123' };
    const observed = correlationStorage.run(store, () => {
      return correlationStorage.getStore();
    });
    expect(observed).toBe(store);
  });

  it('returns undefined outside a run() callback', () => {
    expect(correlationStorage.getStore()).toBeUndefined();
  });

  it('supports optional traceparent in the store shape', () => {
    const store = { correlationId: 'abc', traceparent: '00-abc-def-01' };
    const observed = correlationStorage.run(store, () =>
      correlationStorage.getStore(),
    );
    expect(observed?.traceparent).toBe('00-abc-def-01');
  });
});
