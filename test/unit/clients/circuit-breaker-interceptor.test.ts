/**
 * Unit tests for the circuit-breaker interceptor.
 *
 * The breaker trips after N consecutive 5xx/network failures within windowMs
 * and stays OPEN for openMs before entering HALF_OPEN (single-probe).
 */
import 'reflect-metadata';
import axios, { AxiosInstance } from 'axios';

import { installCircuitBreakerInterceptor } from '../../../src/clients/interceptors/circuit-breaker.interceptor';
import { IamUpstreamUnavailableError } from '../../../src/errors';

/**
 * Build an axios instance whose adapter can be swapped on-the-fly to emit
 * either success responses or synthetic axios errors (with `response.status`).
 */
function makeAxios(): {
  instance: AxiosInstance;
  setFail: (status: number | null) => void;
} {
  const instance = axios.create();
  let failStatus: number | null = null;
  instance.interceptors.request.use((config) => {
    const captured = failStatus;
    (config.adapter as unknown) = async () => {
      if (captured === null) {
        return {
          data: 'ok',
          status: 200,
          statusText: 'ok',
          headers: {},
          config,
        };
      }
      const err = new Error(`upstream ${captured}`) as Error & {
        isAxiosError?: boolean;
        response?: { status: number; data: unknown };
        config?: unknown;
      };
      err.isAxiosError = true;
      err.response = { status: captured, data: null };
      err.config = config;
      throw err;
    };
    return config;
  });
  return {
    instance,
    setFail(status) {
      failStatus = status;
    },
  };
}

describe('circuit-breaker interceptor', () => {
  it('trips OPEN after failureThreshold consecutive 5xx', async () => {
    const { instance, setFail } = makeAxios();
    installCircuitBreakerInterceptor(instance, {
      failureThreshold: 2,
      windowMs: 60_000,
      openMs: 10_000,
    });
    setFail(503);
    await expect(instance.get('http://x/a')).rejects.toHaveProperty(
      'response.status',
      503,
    );
    await expect(instance.get('http://x/b')).rejects.toHaveProperty(
      'response.status',
      503,
    );
    // Third call trips the breaker and short-circuits with the library error.
    await expect(instance.get('http://x/c')).rejects.toBeInstanceOf(
      IamUpstreamUnavailableError,
    );
  });

  it('4xx does not count toward tripping', async () => {
    const { instance, setFail } = makeAxios();
    installCircuitBreakerInterceptor(instance, {
      failureThreshold: 2,
      windowMs: 60_000,
      openMs: 10_000,
    });
    setFail(404);
    for (let i = 0; i < 5; i++) {
      await expect(instance.get('http://x/a')).rejects.toHaveProperty(
        'response.status',
        404,
      );
    }
    setFail(null);
    // Breaker still CLOSED — success flows through.
    const res = await instance.get('http://x/ok');
    expect(res.status).toBe(200);
  });

  it('is a no-op when failureThreshold <= 0', async () => {
    const { instance, setFail } = makeAxios();
    installCircuitBreakerInterceptor(instance, {
      failureThreshold: 0,
      windowMs: 60_000,
      openMs: 10_000,
    });
    setFail(503);
    for (let i = 0; i < 5; i++) {
      await expect(instance.get('http://x/a')).rejects.toHaveProperty(
        'response.status',
        503,
      );
    }
    // Never short-circuits.
  });
});
