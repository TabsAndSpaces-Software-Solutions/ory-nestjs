/**
 * Contract tests for `FrontendApi.toSession` dispatched through a
 * fully-built `TenantClients` bundle.
 *
 * Verified behaviors:
 *   - A cookie-based `toSession({ cookie })` carries the `Cookie` header
 *     on the outbound request.
 *   - A bearer-based `toSession({ xSessionToken })` carries the
 *     `X-Session-Token` header.
 *   - The request-id interceptor stamps an `x-request-id` header.
 *
 * We intercept real network traffic with `nock` — no @ory/client mocking.
 */
import nock from 'nock';

import { Redactor } from '../../../src/audit';
import { AxiosFactory } from '../../../src/clients/axios.factory';
import { OryClientFactory } from '../../../src/clients/ory-client.factory';
import type { ValidatedTenantConfig } from '../../../src/config';

const BASE = 'https://kratos.test';

function mkTenant(): ValidatedTenantConfig {
  return {
    mode: 'self-hosted',
    transport: 'cookie-or-bearer',
    kratos: {
      publicUrl: BASE,
      sessionCookieName: 'ory_kratos_session',
    },
  } as ValidatedTenantConfig;
}

describe('FrontendApi.toSession contract', () => {
  beforeAll(() => {
    if (!nock.isActive()) nock.activate();
    nock.disableNetConnect();
  });

  afterAll(() => {
    nock.cleanAll();
    nock.enableNetConnect();
    nock.restore();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  function buildClients() {
    const redactor = new Redactor();
    const axios = AxiosFactory.create(mkTenant(), { redactor });
    return OryClientFactory.build('default', mkTenant(), { axios });
  }

  it('cookie flow: outbound request carries the Cookie header', async () => {
    let capturedCookie: string | undefined;
    let capturedRequestId: string | undefined;

    const scope = nock(BASE)
      .get('/sessions/whoami')
      .reply(function () {
        capturedCookie = this.req.headers['cookie'] as string;
        capturedRequestId = this.req.headers['x-request-id'] as string;
        return [
          200,
          {
            id: 'sess-1',
            active: true,
            identity: { id: 'id-1' },
          },
        ];
      });

    const { kratosFrontend } = buildClients();
    const response = await kratosFrontend.toSession({
      cookie: 'ory_kratos_session=abcdef',
    });

    expect(response.status).toBe(200);
    expect(response.data).toMatchObject({ id: 'sess-1', active: true });
    expect(capturedCookie).toBe('ory_kratos_session=abcdef');
    expect(typeof capturedRequestId).toBe('string');
    expect((capturedRequestId as string).length).toBeGreaterThanOrEqual(8);
    expect(scope.isDone()).toBe(true);
  });

  it('bearer flow: outbound request carries X-Session-Token header', async () => {
    let capturedToken: string | undefined;

    const scope = nock(BASE)
      .get('/sessions/whoami')
      .reply(function () {
        capturedToken = this.req.headers['x-session-token'] as string;
        return [
          200,
          {
            id: 'sess-2',
            active: true,
            identity: { id: 'id-2' },
          },
        ];
      });

    const { kratosFrontend } = buildClients();
    const response = await kratosFrontend.toSession({
      xSessionToken: 'the-token',
    });

    expect(response.status).toBe(200);
    expect(response.data).toMatchObject({ id: 'sess-2' });
    expect(capturedToken).toBe('the-token');
    expect(scope.isDone()).toBe(true);
  });

  it('redacts authorization header on 401 error bodies', async () => {
    nock(BASE)
      .get('/sessions/whoami')
      .reply(401, {
        error: {
          id: 'session_inactive',
          message: 'no session',
          // A JWT in the error body that MUST be scrubbed.
          token:
            'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhYmMifQ.c2ln',
        },
      });

    const { kratosFrontend } = buildClients();
    try {
      await kratosFrontend.toSession({ xSessionToken: 'bad-token' });
      fail('expected rejection');
    } catch (e) {
      const err = e as {
        response: { data: { error: { token: string } } };
        config: { headers: Record<string, string> };
      };
      // Body token was scrubbed (value-pattern).
      expect(err.response.data.error.token).toBe('[redacted]');
      // Config headers: if Authorization were present, it'd be redacted.
      // X-Session-Token is a redacted key; the interceptor replaces it.
      const headers = err.config.headers as Record<string, unknown>;
      expect(headers['X-Session-Token']).toBe('[redacted]');
    }
  });
});
