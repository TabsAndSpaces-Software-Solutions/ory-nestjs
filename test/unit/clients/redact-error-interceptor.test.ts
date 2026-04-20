/**
 * Unit tests for `redactErrorInterceptor` — the axios RESPONSE-error
 * interceptor that walks every user-attached field on an AxiosError and
 * applies the shared `Redactor` so secrets/PII never reach logs.
 */
import { Redactor, REDACTED, REDACTED_TOKEN } from '../../../src/audit';
import { redactErrorHandler } from '../../../src/clients/interceptors/redact-error.interceptor';

function mkError(overrides: Record<string, unknown>): unknown {
  return Object.assign(new Error('axios error'), overrides);
}

describe('redactErrorInterceptor.redactErrorHandler', () => {
  const redactor = new Redactor();
  const handler = redactErrorHandler(redactor);

  it('redacts a JWT-shaped token in error.response.data', async () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhYmMifQ.sig_seg';
    const err = mkError({
      isAxiosError: true,
      response: {
        status: 500,
        data: { token: jwt, note: 'token embedded: ' + jwt },
        headers: {},
      },
      config: { headers: {} },
    });

    await expect(handler(err)).rejects.toBe(err);

    const redacted = (err as { response: { data: Record<string, string> } })
      .response.data;
    // `token` is a redacted KEY; `note` contains a redacted VALUE.
    expect(redacted.token).toBe(REDACTED);
    expect(redacted.note).toContain(REDACTED_TOKEN);
    expect(redacted.note).not.toContain('eyJ');
  });

  it('strips the Authorization header from error.config.headers', async () => {
    const err = mkError({
      isAxiosError: true,
      response: { status: 401, data: {}, headers: {} },
      config: {
        headers: {
          Authorization: 'Bearer secret-token',
          'x-request-id': 'rid',
        },
      },
    });

    await expect(handler(err)).rejects.toBe(err);

    const cfgHeaders = (err as { config: { headers: Record<string, string> } })
      .config.headers;
    expect(cfgHeaders.Authorization).toBe(REDACTED);
    // non-sensitive headers should be preserved
    expect(cfgHeaders['x-request-id']).toBe('rid');
  });

  it('redacts Set-Cookie values in response.headers', async () => {
    const err = mkError({
      isAxiosError: true,
      response: {
        status: 403,
        data: {},
        headers: { 'set-cookie': ['ory_kratos_session=abcd'] },
      },
      config: { headers: {} },
    });

    await expect(handler(err)).rejects.toBe(err);

    const headers = (err as { response: { headers: Record<string, unknown> } })
      .response.headers;
    expect(headers['set-cookie']).toBe(REDACTED);
  });

  it('handles errors with no response/config without throwing', async () => {
    const err = mkError({
      isAxiosError: true,
      code: 'ECONNREFUSED',
      message: 'connection refused',
    });

    await expect(handler(err)).rejects.toBe(err);
  });

  it('handles non-axios errors by rethrowing untouched', async () => {
    const err = new Error('plain error');
    await expect(handler(err)).rejects.toBe(err);
  });
});
