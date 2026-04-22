/**
 * Token-bucket rate limiter for outbound Ory calls.
 *
 * Scope: one bucket per axios instance (axios is one-per-tenant, so this is
 * effectively per-tenant). The bucket fills at `rps` tokens/second with a
 * maximum of `burst` tokens. Each outbound request takes one token.
 *
 * Contract:
 *   - Request-level blocking: when the bucket is empty the request WAITS
 *     (not rejects). Maximum wait is `queueTimeoutMs`; exceeding it raises
 *     `IamUpstreamUnavailableError` with `retryAfter` matching the refill
 *     time.
 *   - The library never drops calls silently — a 503 at the HTTP boundary is
 *     honest about the reason.
 *   - Fairness: requests are served FIFO from a small in-memory queue.
 *   - No clock drift handling beyond monotonic `performance.now()`.
 *
 * Why a token bucket, not a sliding window: Ory's rate limits are
 * themselves token buckets on the server side, so matching the shape keeps
 * our limiter's behavior predictable under bursts.
 */
import type { AxiosInstance } from 'axios';

import { IamUpstreamUnavailableError } from '../../errors';

export interface RateLimitOptions {
  /** Sustained rate (tokens per second). */
  readonly rps: number;
  /** Maximum burst size (bucket capacity). */
  readonly burst: number;
  /**
   * Max time a request will wait for a token before failing with 503.
   * Defaults to 5000 ms.
   */
  readonly queueTimeoutMs?: number;
  /**
   * Max queued waiters. Additional requests fail immediately with 503.
   * Defaults to 100.
   */
  readonly maxQueueSize?: number;
}

interface Waiter {
  readonly resolve: () => void;
  readonly reject: (err: Error) => void;
  readonly enqueuedAt: number;
}

class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly refillPerMs: number;
  private readonly queue: Waiter[] = [];
  private draining = false;

  constructor(
    private readonly capacity: number,
    ratePerSecond: number,
  ) {
    this.tokens = capacity;
    this.lastRefill = nowMs();
    this.refillPerMs = ratePerSecond / 1000;
  }

  public async acquire(
    queueTimeoutMs: number,
    maxQueueSize: number,
  ): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    if (this.queue.length >= maxQueueSize) {
      throw new IamUpstreamUnavailableError({
        message: 'rate limit: queue full',
        retryAfter: Math.ceil(1 / Math.max(this.refillPerMs * 1000, 0.001)),
      });
    }

    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        enqueuedAt: nowMs(),
      };
      this.queue.push(waiter);
      this.scheduleDrain(queueTimeoutMs);
    });
  }

  private refill(): void {
    const now = nowMs();
    const elapsed = now - this.lastRefill;
    this.lastRefill = now;
    this.tokens = Math.min(
      this.capacity,
      this.tokens + elapsed * this.refillPerMs,
    );
  }

  private scheduleDrain(queueTimeoutMs: number): void {
    if (this.draining) return;
    this.draining = true;
    const tick = () => {
      this.refill();
      while (this.queue.length > 0 && this.tokens >= 1) {
        const waiter = this.queue.shift()!;
        if (nowMs() - waiter.enqueuedAt >= queueTimeoutMs) {
          waiter.reject(
            new IamUpstreamUnavailableError({
              message: 'rate limit: queue timeout',
              retryAfter: 1,
            }),
          );
          continue;
        }
        this.tokens -= 1;
        waiter.resolve();
      }
      if (this.queue.length === 0) {
        this.draining = false;
        return;
      }
      // Check again after the smaller of one token-refill period or 20ms.
      const waitMs = Math.max(20, Math.ceil(1 / this.refillPerMs));
      setTimeout(tick, waitMs);
    };
    setTimeout(tick, 0);
  }
}

function nowMs(): number {
  // `performance.now()` is monotonic; fall back to Date.now() only if unset.
  const g = globalThis as unknown as {
    performance?: { now(): number };
  };
  return g.performance?.now() ?? Date.now();
}

/**
 * Install the rate-limit interceptor on an axios instance. No-op if `rps` is
 * zero or negative — the library treats that as "disabled".
 */
export function installRateLimitInterceptor(
  axios: AxiosInstance,
  options: RateLimitOptions,
): void {
  if (options.rps <= 0 || options.burst <= 0) return;
  const bucket = new TokenBucket(options.burst, options.rps);
  const queueTimeoutMs = options.queueTimeoutMs ?? 5_000;
  const maxQueueSize = options.maxQueueSize ?? 100;
  axios.interceptors.request.use(async (config) => {
    await bucket.acquire(queueTimeoutMs, maxQueueSize);
    return config;
  });
}
