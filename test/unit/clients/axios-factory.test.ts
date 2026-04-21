/**
 * Unit tests for `AxiosFactory.create` — builds a per-tenant axios instance
 * with interceptors wired up, keep-alive agents, and a configurable timeout.
 */
import * as http from 'node:http';
import * as https from 'node:https';

import { Redactor } from '../../../src/audit';
import { AxiosFactory } from '../../../src/clients/axios.factory';
import type { ValidatedTenantConfig } from '../../../src/config';

function mkTenant(overrides: Partial<ValidatedTenantConfig> = {}): ValidatedTenantConfig {
  return {
    mode: 'self-hosted',
    transport: 'bearer',
    kratos: {
      publicUrl: 'https://kratos.test',
      sessionCookieName: 'ory_kratos_session',
    },
    ...overrides,
  } as ValidatedTenantConfig;
}

describe('AxiosFactory.create', () => {
  const redactor = new Redactor();

  it('returns an axios-like instance with interceptors and timeout set', () => {
    const instance = AxiosFactory.create(mkTenant(), { redactor });
    expect(typeof instance.get).toBe('function');
    expect(typeof instance.request).toBe('function');
    expect(instance.defaults.timeout).toBe(5000);
  });

  it('applies a custom timeout when tenant.timeoutMs is provided', () => {
    const instance = AxiosFactory.create(
      mkTenant({ timeoutMs: 2500 } as unknown as ValidatedTenantConfig),
      { redactor },
    );
    expect(instance.defaults.timeout).toBe(2500);
  });

  it('uses keep-alive http and https agents', () => {
    const instance = AxiosFactory.create(mkTenant(), { redactor });
    expect(instance.defaults.httpAgent).toBeInstanceOf(http.Agent);
    expect(instance.defaults.httpsAgent).toBeInstanceOf(https.Agent);
    // `keepAlive` is a non-public field on Agent but is readable at runtime.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((instance.defaults.httpAgent as any).keepAlive).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((instance.defaults.httpsAgent as any).keepAlive).toBe(true);
  });

  it('registers request-id and response error interceptors', () => {
    const instance = AxiosFactory.create(mkTenant(), { redactor });
    // Axios stores interceptors in `handlers` arrays. If any are registered,
    // the length is > 0.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reqHandlers = (instance.interceptors.request as any).handlers;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const respHandlers = (instance.interceptors.response as any).handlers;
    expect(reqHandlers.length).toBeGreaterThanOrEqual(1);
    expect(respHandlers.length).toBeGreaterThanOrEqual(2);
  });
});
