/**
 * Unit tests for `requestIdInterceptor` — the axios request interceptor
 * that propagates `x-request-id` (and optional `traceparent`) from the
 * ambient `correlationStorage`, generating a UUID when no id is present.
 */
import type { InternalAxiosRequestConfig } from 'axios';

import { correlationStorage } from '../../../src/clients/correlation-storage';
import { applyRequestId } from '../../../src/clients/interceptors/request-id.interceptor';

function mkConfig(): InternalAxiosRequestConfig {
  return {
    headers: {},
    method: 'get',
    url: '/test',
  } as unknown as InternalAxiosRequestConfig;
}

describe('requestIdInterceptor.applyRequestId', () => {
  it('generates an x-request-id when none is in the context', () => {
    const cfg = mkConfig();
    const out = applyRequestId(cfg);
    const headers = out.headers as Record<string, unknown>;
    expect(typeof headers['x-request-id']).toBe('string');
    expect((headers['x-request-id'] as string).length).toBeGreaterThanOrEqual(8);
  });

  it('propagates an existing correlationId from AsyncLocalStorage', () => {
    const cfg = mkConfig();
    const observed = correlationStorage.run(
      { correlationId: 'abc-123' },
      () => applyRequestId(cfg),
    );
    const headers = observed.headers as Record<string, unknown>;
    expect(headers['x-request-id']).toBe('abc-123');
  });

  it('propagates traceparent from AsyncLocalStorage when present', () => {
    const cfg = mkConfig();
    const observed = correlationStorage.run(
      { correlationId: 'abc-123', traceparent: '00-xxx-yyy-01' },
      () => applyRequestId(cfg),
    );
    const headers = observed.headers as Record<string, unknown>;
    expect(headers['traceparent']).toBe('00-xxx-yyy-01');
  });

  it('does not overwrite an x-request-id already present on the outbound config', () => {
    const cfg = mkConfig();
    (cfg.headers as Record<string, string>)['x-request-id'] = 'preset-id';
    const out = correlationStorage.run(
      { correlationId: 'ambient-id' },
      () => applyRequestId(cfg),
    );
    const headers = out.headers as Record<string, unknown>;
    expect(headers['x-request-id']).toBe('preset-id');
  });
});
