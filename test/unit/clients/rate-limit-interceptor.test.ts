/**
 * Unit tests for the token-bucket rate limiter interceptor.
 */
import 'reflect-metadata';
import axios, { AxiosInstance } from 'axios';

import { installRateLimitInterceptor } from '../../../src/clients/interceptors/rate-limit.interceptor';
import { IamUpstreamUnavailableError } from '../../../src/errors';

function makeAxiosNoNetwork(): AxiosInstance {
  const instance = axios.create();
  // Short-circuit the network — reply immediately so we only exercise the
  // request interceptor.
  instance.interceptors.request.use((config) => {
    (config.adapter as unknown) = async () => ({
      data: 'ok',
      status: 200,
      statusText: 'ok',
      headers: {},
      config,
    });
    return config;
  });
  return instance;
}

describe('rate-limit interceptor', () => {
  it('allows up to burst without waiting', async () => {
    const instance = makeAxiosNoNetwork();
    installRateLimitInterceptor(instance, { rps: 1, burst: 3, queueTimeoutMs: 100, maxQueueSize: 5 });
    const start = Date.now();
    await Promise.all([
      instance.get('http://x/1'),
      instance.get('http://x/2'),
      instance.get('http://x/3'),
    ]);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('rejects with IamUpstreamUnavailableError when queue fills', async () => {
    const instance = makeAxiosNoNetwork();
    installRateLimitInterceptor(instance, {
      rps: 1,
      burst: 1,
      queueTimeoutMs: 2_000,
      maxQueueSize: 1,
    });
    // Burn the one token, queue one, overflow with the third.
    const p1 = instance.get('http://x/1');
    const p2 = instance.get('http://x/2');
    const p3 = instance.get('http://x/3').catch((e) => e);
    const err = await p3;
    expect(err).toBeInstanceOf(IamUpstreamUnavailableError);
    // Drain the queued one so jest doesn't hang.
    await p1;
    await p2.catch(() => undefined);
  }, 6_000);

  it('is a no-op when rps <= 0', async () => {
    const instance = makeAxiosNoNetwork();
    installRateLimitInterceptor(instance, { rps: 0, burst: 0 });
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => instance.get(`http://x/${i}`)),
    );
    expect(results).toHaveLength(5);
  });
});
