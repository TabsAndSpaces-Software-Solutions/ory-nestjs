/**
 * Unit tests for ErrorMapper.toNest.
 *
 * Covers:
 *   - IamError subclass -> matching NestJS exception + payload shape
 *   - AxiosError shapes (401, 403, 5xx, timeout, ECONNREFUSED, network)
 *     -> library IamError -> NestJS exception
 *   - Unknown errors are rethrown unchanged
 *   - correlationId is propagated into the Nest payload
 *   - No PII / token / cookie / upstream body leaks into the Nest payload
 */
import {
  UnauthorizedException,
  ForbiddenException,
  ServiceUnavailableException,
  InternalServerErrorException,
  HttpException,
} from '@nestjs/common';
import {
  ErrorMapper,
  IamConfigurationError,
  IamUnauthorizedError,
  IamForbiddenError,
  IamUpstreamUnavailableError,
} from '../../../src/errors';

function fakeAxiosError(opts: {
  status?: number;
  data?: unknown;
  headers?: Record<string, unknown>;
  code?: string;
  message?: string;
}): unknown {
  const err = new Error(opts.message ?? 'fake axios error') as Error & {
    isAxiosError?: boolean;
    response?: { status?: number; data?: unknown; headers?: unknown };
    code?: string;
    config?: unknown;
  };
  err.isAxiosError = true;
  if (opts.status !== undefined || opts.data !== undefined || opts.headers) {
    err.response = {
      status: opts.status,
      data: opts.data,
      headers: opts.headers,
    };
  }
  if (opts.code) err.code = opts.code;
  err.config = {
    headers: { authorization: 'Bearer SECRET-REQUEST-TOKEN' },
    data: { password: 'hunter2' },
  };
  return err;
}

/** Extracts the response body from a NestJS HttpException. */
function response(ex: HttpException): Record<string, unknown> {
  const r = ex.getResponse();
  return typeof r === 'object' && r !== null ? (r as Record<string, unknown>) : { message: String(r) };
}

describe('ErrorMapper.toNest — library errors', () => {
  it('IamConfigurationError -> InternalServerErrorException (generic body, no leak)', () => {
    const cfgErr = new IamConfigurationError({
      message: 'ORY_SDK_URL missing from env — deploy is broken',
    });
    const ex = ErrorMapper.toNest(cfgErr);
    expect(ex).toBeInstanceOf(InternalServerErrorException);
    const body = response(ex);
    expect(body.statusCode).toBe(500);
    expect(body.message).toBe('Server Error');
    // Must NOT leak the detailed config message.
    expect(JSON.stringify(body)).not.toMatch(/ORY_SDK_URL/);
    expect(JSON.stringify(body)).not.toMatch(/deploy is broken/);
  });

  it('IamUnauthorizedError -> UnauthorizedException with wwwAuthenticate hint', () => {
    const err = new IamUnauthorizedError({ message: 'Upstream authentication failure' });
    const ex = ErrorMapper.toNest(err);
    expect(ex).toBeInstanceOf(UnauthorizedException);
    const body = response(ex);
    expect(body.statusCode).toBe(401);
    expect(body.message).toBe('Unauthorized');
    expect(body.wwwAuthenticate).toBe('Bearer realm="ory-nestjs"');
  });

  it('IamForbiddenError -> ForbiddenException', () => {
    const err = new IamForbiddenError({ message: 'Permission denied upstream' });
    const ex = ErrorMapper.toNest(err);
    expect(ex).toBeInstanceOf(ForbiddenException);
    const body = response(ex);
    expect(body.statusCode).toBe(403);
    expect(body.message).toBe('Forbidden');
  });

  it('IamUpstreamUnavailableError -> ServiceUnavailableException with retryAfter=5', () => {
    const err = new IamUpstreamUnavailableError({
      message: 'Upstream IAM dependency unavailable',
    });
    const ex = ErrorMapper.toNest(err);
    expect(ex).toBeInstanceOf(ServiceUnavailableException);
    const body = response(ex);
    expect(body.statusCode).toBe(503);
    expect(body.message).toBe('Service Unavailable');
    expect(body.retryAfter).toBe(5);
  });

  it('propagates correlationId from IamError into the Nest payload', () => {
    const err = new IamUnauthorizedError({
      message: 'Upstream authentication failure',
      correlationId: 'req-abc',
    });
    const body = response(ErrorMapper.toNest(err));
    expect(body.correlationId).toBe('req-abc');
  });

  it('propagates correlationId from explicit context when IamError has none', () => {
    const err = new IamForbiddenError({ message: 'Permission denied upstream' });
    const body = response(ErrorMapper.toNest(err, { correlationId: 'ctx-1' }));
    expect(body.correlationId).toBe('ctx-1');
  });

  it('omits correlationId from the payload when none is available', () => {
    const err = new IamForbiddenError({ message: 'Permission denied upstream' });
    const body = response(ErrorMapper.toNest(err));
    expect(Object.prototype.hasOwnProperty.call(body, 'correlationId')).toBe(false);
  });

  it('IamError.correlationId takes precedence over context.correlationId', () => {
    const err = new IamUpstreamUnavailableError({
      message: 'Upstream IAM dependency unavailable',
      correlationId: 'from-error',
    });
    const body = response(
      ErrorMapper.toNest(err, { correlationId: 'from-context' }),
    );
    expect(body.correlationId).toBe('from-error');
  });
});

describe('ErrorMapper.toNest — AxiosError translation', () => {
  it('401 -> UnauthorizedException (via IamUnauthorizedError)', () => {
    const ex = ErrorMapper.toNest(
      fakeAxiosError({ status: 401, data: { error: 'session_inactive' } }),
    );
    expect(ex).toBeInstanceOf(UnauthorizedException);
    const body = response(ex);
    expect(body.statusCode).toBe(401);
    expect(body.message).toBe('Unauthorized');
    expect(body.wwwAuthenticate).toBe('Bearer realm="ory-nestjs"');
  });

  it('403 -> ForbiddenException (via IamForbiddenError)', () => {
    const ex = ErrorMapper.toNest(
      fakeAxiosError({ status: 403, data: { error: 'forbidden' } }),
    );
    expect(ex).toBeInstanceOf(ForbiddenException);
    const body = response(ex);
    expect(body.statusCode).toBe(403);
  });

  it('500 -> ServiceUnavailableException (via IamUpstreamUnavailableError)', () => {
    const ex = ErrorMapper.toNest(fakeAxiosError({ status: 500 }));
    expect(ex).toBeInstanceOf(ServiceUnavailableException);
    const body = response(ex);
    expect(body.statusCode).toBe(503);
    expect(body.retryAfter).toBe(5);
  });

  it('502 / 503 / 504 -> ServiceUnavailableException', () => {
    for (const status of [502, 503, 504]) {
      const ex = ErrorMapper.toNest(fakeAxiosError({ status }));
      expect(ex).toBeInstanceOf(ServiceUnavailableException);
    }
  });

  it('timeout (ETIMEDOUT) with no response -> ServiceUnavailableException', () => {
    const ex = ErrorMapper.toNest(fakeAxiosError({ code: 'ETIMEDOUT' }));
    expect(ex).toBeInstanceOf(ServiceUnavailableException);
  });

  it('ECONNREFUSED with no response -> ServiceUnavailableException', () => {
    const ex = ErrorMapper.toNest(fakeAxiosError({ code: 'ECONNREFUSED' }));
    expect(ex).toBeInstanceOf(ServiceUnavailableException);
  });

  it('ECONNRESET -> ServiceUnavailableException', () => {
    const ex = ErrorMapper.toNest(fakeAxiosError({ code: 'ECONNRESET' }));
    expect(ex).toBeInstanceOf(ServiceUnavailableException);
  });

  it('ENOTFOUND -> ServiceUnavailableException', () => {
    const ex = ErrorMapper.toNest(fakeAxiosError({ code: 'ENOTFOUND' }));
    expect(ex).toBeInstanceOf(ServiceUnavailableException);
  });

  it('ERR_NETWORK -> ServiceUnavailableException', () => {
    const ex = ErrorMapper.toNest(fakeAxiosError({ code: 'ERR_NETWORK' }));
    expect(ex).toBeInstanceOf(ServiceUnavailableException);
  });

  it('AxiosError without response and without known code -> UpstreamUnavailable', () => {
    // Has isAxiosError === true but no response — still a network-level failure.
    const ex = ErrorMapper.toNest(fakeAxiosError({}));
    expect(ex).toBeInstanceOf(ServiceUnavailableException);
  });

  it('AxiosError with 4xx that is not 401/403 rethrows (not wrapped)', () => {
    const err = fakeAxiosError({ status: 418 });
    expect(() => ErrorMapper.toNest(err)).toThrow();
    try {
      ErrorMapper.toNest(err);
    } catch (caught) {
      expect(caught).toBe(err);
    }
  });

  it('propagates context.correlationId when mapping a raw AxiosError', () => {
    const body = response(
      ErrorMapper.toNest(fakeAxiosError({ status: 401 }), {
        correlationId: 'req-42',
      }),
    );
    expect(body.correlationId).toBe('req-42');
  });
});

describe('ErrorMapper.toNest — unknown error handling', () => {
  it('rethrows raw Error objects (not an IamError, not an AxiosError)', () => {
    const raw = new Error('something exploded');
    expect(() => ErrorMapper.toNest(raw)).toThrow(raw);
  });

  it('rethrows non-Error values (strings, numbers, null)', () => {
    expect(() => ErrorMapper.toNest('boom')).toThrow();
    expect(() => ErrorMapper.toNest(123)).toThrow();
    expect(() => ErrorMapper.toNest(null)).toThrow();
  });
});

describe('ErrorMapper.toNest — purity', () => {
  it('does not mutate the input error', () => {
    const err = new IamUnauthorizedError({ message: 'Upstream authentication failure' });
    const before = { ...err, code: err.code, message: err.message };
    ErrorMapper.toNest(err);
    expect(err.code).toBe(before.code);
    expect(err.message).toBe(before.message);
  });

  it('ErrorMapper is not newable / has no state', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => new (ErrorMapper as any)()).toThrow();
  });
});

describe('ErrorMapper.toNest — redaction fuzz (tokens & PII)', () => {
  const jwt =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMiLCJuYW1lIjoiSm9obiJ9.signature-part';
  const sessionCookie = 'ory_kratos_session=abcdef1234567890';
  const pii = {
    email: 'victim@example.com',
    ssn: '123-45-6789',
    phone: '+15551234567',
  };

  it('does not leak JWT-like tokens from AxiosError 401 response body', () => {
    const ex = ErrorMapper.toNest(
      fakeAxiosError({
        status: 401,
        data: { token: jwt, session_token: jwt, user: pii },
        headers: { 'set-cookie': sessionCookie },
      }),
    );
    const serialized = JSON.stringify(response(ex));
    expect(serialized).not.toMatch(/eyJ/);
    expect(serialized).not.toMatch(/signature-part/);
    expect(serialized).not.toMatch(/ory_kratos_session/);
    expect(serialized).not.toMatch(/victim@example\.com/);
    expect(serialized).not.toMatch(/123-45-6789/);
    expect(serialized).not.toMatch(/\+15551234567/);
    expect(serialized).not.toMatch(/authorization/i);
    expect(serialized).not.toMatch(/SECRET-REQUEST-TOKEN/);
  });

  it('does not leak tokens/PII for 403 AxiosError', () => {
    const ex = ErrorMapper.toNest(
      fakeAxiosError({
        status: 403,
        data: { identity: pii, session: jwt },
      }),
    );
    const serialized = JSON.stringify(response(ex));
    expect(serialized).not.toMatch(/eyJ/);
    expect(serialized).not.toMatch(/victim@example\.com/);
  });

  it('does not leak tokens/PII for 500 AxiosError', () => {
    const ex = ErrorMapper.toNest(
      fakeAxiosError({
        status: 500,
        data: { stack: `at handler token=${jwt}`, user: pii },
      }),
    );
    const serialized = JSON.stringify(response(ex));
    expect(serialized).not.toMatch(/eyJ/);
    expect(serialized).not.toMatch(/victim@example\.com/);
    expect(serialized).not.toMatch(/signature-part/);
  });

  it('produces only generic message strings', () => {
    const unauthorized = response(ErrorMapper.toNest(fakeAxiosError({ status: 401 })));
    const forbidden = response(ErrorMapper.toNest(fakeAxiosError({ status: 403 })));
    const unavailable = response(ErrorMapper.toNest(fakeAxiosError({ status: 503 })));
    expect(unauthorized.message).toBe('Unauthorized');
    expect(forbidden.message).toBe('Forbidden');
    expect(unavailable.message).toBe('Service Unavailable');
  });

  it('the IamError constructed internally keeps message generic (no upstream body)', () => {
    // We cannot inspect the intermediate directly, but we can cross-check
    // via the cause chain of the Nest exception to prove the IamError
    // has a generic message. Nest exceptions do not traverse cause, so
    // we rebuild the scenario and inspect the Nest body only.
    const ex = ErrorMapper.toNest(
      fakeAxiosError({
        status: 401,
        data: { message: 'password=hunter2 token=' + jwt },
      }),
    );
    const serialized = JSON.stringify(response(ex));
    expect(serialized).not.toMatch(/hunter2/);
    expect(serialized).not.toMatch(/eyJ/);
  });
});

describe('ErrorMapper.toNest — Ory product contract fixtures', () => {
  // Minimal, realistic Ory error payload shapes — one per status code.
  // Source: Ory Kratos / Keto / Hydra "genericError" envelope.
  const kratos401: unknown = {
    isAxiosError: true,
    response: {
      status: 401,
      data: {
        error: {
          code: 401,
          status: 'Unauthorized',
          reason: 'No valid session cookie / token was provided.',
          message: 'The request could not be authorized',
        },
      },
      headers: {
        'content-type': 'application/json',
        'set-cookie': 'ory_kratos_session=leakme; Path=/; HttpOnly',
      },
    },
    message: 'Request failed with status code 401',
  };

  const keto403: unknown = {
    isAxiosError: true,
    response: {
      status: 403,
      data: {
        error: {
          code: 403,
          status: 'Forbidden',
          reason: 'relation_tuple not allowed',
          message: 'access denied',
          details: { subject: 'user:victim@example.com', relation: 'editor' },
        },
      },
    },
    message: 'Request failed with status code 403',
  };

  const hydra500: unknown = {
    isAxiosError: true,
    response: {
      status: 500,
      data: {
        error: 'internal_server_error',
        error_description: 'upstream token introspection crashed: token=eyJABCDEF',
      },
    },
    message: 'Request failed with status code 500',
  };

  const kratosTimeout: unknown = {
    isAxiosError: true,
    code: 'ETIMEDOUT',
    message: 'timeout of 5000ms exceeded',
    config: { url: 'https://kratos.example.com/sessions/whoami' },
  };

  it('Ory Kratos 401 payload -> UnauthorizedException, no session cookie leak', () => {
    const ex = ErrorMapper.toNest(kratos401);
    expect(ex).toBeInstanceOf(UnauthorizedException);
    const serialized = JSON.stringify(response(ex));
    expect(serialized).not.toMatch(/ory_kratos_session/);
    expect(serialized).not.toMatch(/leakme/);
  });

  it('Ory Keto 403 payload -> ForbiddenException, no subject PII leak', () => {
    const ex = ErrorMapper.toNest(keto403);
    expect(ex).toBeInstanceOf(ForbiddenException);
    const serialized = JSON.stringify(response(ex));
    expect(serialized).not.toMatch(/victim@example\.com/);
    expect(serialized).not.toMatch(/relation_tuple/);
  });

  it('Ory Hydra 500 payload -> ServiceUnavailableException, no token leak', () => {
    const ex = ErrorMapper.toNest(hydra500);
    expect(ex).toBeInstanceOf(ServiceUnavailableException);
    const serialized = JSON.stringify(response(ex));
    expect(serialized).not.toMatch(/eyJ/);
    expect(serialized).not.toMatch(/error_description/);
  });

  it('Ory Kratos network timeout -> ServiceUnavailableException', () => {
    const ex = ErrorMapper.toNest(kratosTimeout);
    expect(ex).toBeInstanceOf(ServiceUnavailableException);
    const body = response(ex);
    expect(body.retryAfter).toBe(5);
  });
});
