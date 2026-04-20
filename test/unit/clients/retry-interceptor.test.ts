/**
 * Unit tests for `installRetryInterceptor` — attaches a response-error
 * interceptor to an axios instance that retries idempotent GETs on 5xx /
 * network errors, with exponential backoff capped at 2 retries.
 */
import axios, { AxiosInstance } from 'axios';

import {
  installRetryInterceptor,
  isRetryable,
} from '../../../src/clients/interceptors/retry.interceptor';

/**
 * Build an axios instance whose adapter is a programmable mock queue.
 * Each call to the returned `enqueue()` installs the next response (or
 * error) to be produced by the adapter.
 */
function mockAxios(): {
  instance: AxiosInstance;
  enqueue: (result: unknown, isError?: boolean) => void;
  callCount: () => number;
} {
  const queue: Array<{ result: unknown; isError: boolean }> = [];
  let calls = 0;
  const instance = axios.create({
    // no real baseURL; adapter intercepts all
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  instance.defaults.adapter = (async (cfg: any): Promise<any> => {
    calls += 1;
    const next = queue.shift();
    if (!next) {
      throw new Error('mock queue exhausted');
    }
    if (next.isError) {
      // Rewire the error's config to the live axios config so the retry
      // interceptor can stash its attempt counter on the same object.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (next.result as any).config = cfg;
      throw next.result;
    }
    return { ...(next.result as Record<string, unknown>), config: cfg };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
  return {
    instance,
    enqueue: (result, isError = false) => queue.push({ result, isError }),
    callCount: () => calls,
  };
}

function axiosResponse(
  status: number,
  data: unknown = {},
): {
  status: number;
  statusText: string;
  data: unknown;
  headers: Record<string, string>;
  config: Record<string, unknown>;
} {
  return {
    status,
    statusText: `${status}`,
    data,
    headers: {},
    config: {},
  };
}

function axiosError(
  status: number | undefined,
  code?: string,
  method: string = 'get',
): Error & Record<string, unknown> {
  const err = new Error(`simulated ${status ?? code}`) as Error &
    Record<string, unknown>;
  err.isAxiosError = true;
  err.code = code;
  err.config = { method, url: '/test', headers: {} };
  if (status !== undefined) {
    err.response = {
      status,
      data: {},
      headers: {},
      statusText: `${status}`,
      config: err.config,
    };
  }
  return err;
}

describe('retry.isRetryable', () => {
  it('returns true for 500, 502, 503, 504', () => {
    for (const s of [500, 502, 503, 504]) {
      expect(isRetryable(axiosError(s, undefined, 'get'))).toBe(true);
    }
  });

  it('returns false for 4xx', () => {
    for (const s of [400, 401, 403, 404, 418]) {
      expect(isRetryable(axiosError(s, undefined, 'get'))).toBe(false);
    }
  });

  it('returns true for network error codes', () => {
    for (const c of ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'ERR_NETWORK']) {
      expect(isRetryable(axiosError(undefined, c, 'get'))).toBe(true);
    }
  });

  it('returns false for unknown codes without a response', () => {
    expect(isRetryable(axiosError(undefined, 'SOMETHING_ELSE', 'get'))).toBe(false);
  });

  it('returns false for non-GET methods regardless of status/code', () => {
    expect(isRetryable(axiosError(500, undefined, 'post'))).toBe(false);
    expect(isRetryable(axiosError(undefined, 'ECONNRESET', 'put'))).toBe(false);
    expect(isRetryable(axiosError(undefined, 'ECONNRESET', 'delete'))).toBe(false);
  });
});

describe('installRetryInterceptor', () => {
  it('retries a GET with 500 up to 2 times, then propagates', async () => {
    const { instance, enqueue, callCount } = mockAxios();
    installRetryInterceptor(instance, { baseDelayMs: 1, maxRetries: 2 });

    enqueue(axiosError(500), true);
    enqueue(axiosError(500), true);
    enqueue(axiosError(500), true);

    await expect(instance.get('/test')).rejects.toMatchObject({
      response: { status: 500 },
    });
    // initial + 2 retries = 3
    expect(callCount()).toBe(3);
  });

  it('succeeds when a retry returns 200', async () => {
    const { instance, enqueue, callCount } = mockAxios();
    installRetryInterceptor(instance, { baseDelayMs: 1, maxRetries: 2 });

    enqueue(axiosError(503), true);
    enqueue(axiosResponse(200, { ok: true }));

    const resp = await instance.get('/test');
    expect(resp.status).toBe(200);
    expect(callCount()).toBe(2);
  });

  it('does not retry on GET 401', async () => {
    const { instance, enqueue, callCount } = mockAxios();
    installRetryInterceptor(instance, { baseDelayMs: 1, maxRetries: 2 });

    enqueue(axiosError(401), true);

    await expect(instance.get('/test')).rejects.toMatchObject({
      response: { status: 401 },
    });
    expect(callCount()).toBe(1);
  });

  it('does not retry on POST 500', async () => {
    const { instance, enqueue, callCount } = mockAxios();
    installRetryInterceptor(instance, { baseDelayMs: 1, maxRetries: 2 });

    enqueue(axiosError(500, undefined, 'post'), true);

    await expect(instance.post('/test')).rejects.toMatchObject({
      response: { status: 500 },
    });
    expect(callCount()).toBe(1);
  });

  it('retries on network error (ECONNREFUSED)', async () => {
    const { instance, enqueue, callCount } = mockAxios();
    installRetryInterceptor(instance, { baseDelayMs: 1, maxRetries: 2 });

    enqueue(axiosError(undefined, 'ECONNREFUSED'), true);
    enqueue(axiosError(undefined, 'ECONNREFUSED'), true);
    enqueue(axiosResponse(200, { ok: true }));

    const resp = await instance.get('/test');
    expect(resp.status).toBe(200);
    expect(callCount()).toBe(3);
  });

  it('uses exponential backoff: attempt N waits baseDelay * 2^N', async () => {
    const { instance, enqueue } = mockAxios();
    const delays: number[] = [];
    installRetryInterceptor(instance, {
      baseDelayMs: 100,
      maxRetries: 2,
      // inject a synchronous "sleep" that records durations but doesn't wait
      sleep: async (ms: number) => {
        delays.push(ms);
      },
    });

    enqueue(axiosError(500), true);
    enqueue(axiosError(500), true);
    enqueue(axiosError(500), true);

    await expect(instance.get('/test')).rejects.toBeTruthy();

    // attempts 1 and 2 each incur a backoff; delays=[100, 200]
    expect(delays).toEqual([100, 200]);
  });
});
