/**
 * Circuit breaker interceptor for outbound Ory calls.
 *
 * Model: one breaker per hostname of the target URL (one axios instance may
 * speak to Kratos, Keto, and Hydra — each gets its own state). Closed on
 * boot; N consecutive 5xx or network errors inside `windowMs` flip the
 * breaker OPEN for `openMs`, then HALF_OPEN for a single probe request.
 *   - OPEN: every subsequent request fails immediately with
 *     `IamUpstreamUnavailableError { retryAfter }` without touching the
 *     network.
 *   - HALF_OPEN: a single request is allowed through. Success → CLOSED and
 *     failure counters reset. Failure → OPEN again with the same `openMs`.
 *
 * The breaker trips only on 5xx or axios network errors. 4xx responses
 * (including 401/403/429) do NOT count toward the failure threshold — those
 * reflect the caller's request, not upstream health.
 */
import type { AxiosError, AxiosInstance, AxiosResponse } from 'axios';

import { IamUpstreamUnavailableError } from '../../errors';

export interface CircuitBreakerOptions {
  /** Consecutive failures in `windowMs` required to trip open. */
  readonly failureThreshold: number;
  /** Sliding window for counting failures (ms). */
  readonly windowMs: number;
  /** How long to stay OPEN before entering HALF_OPEN. */
  readonly openMs: number;
}

type BreakerState = 'closed' | 'open' | 'half_open';

interface BreakerEntry {
  state: BreakerState;
  failures: { at: number }[];
  openedAt: number;
}

class BreakerRegistry {
  private readonly byHost = new Map<string, BreakerEntry>();

  constructor(private readonly options: CircuitBreakerOptions) {}

  /** Called before dispatching a request. Throws if host is OPEN. */
  public precheck(host: string): void {
    const entry = this.entryFor(host);
    if (entry.state === 'open') {
      const openFor = nowMs() - entry.openedAt;
      if (openFor < this.options.openMs) {
        const retryAfter = Math.max(
          1,
          Math.ceil((this.options.openMs - openFor) / 1000),
        );
        throw new IamUpstreamUnavailableError({
          message: `circuit breaker open for host ${host}`,
          retryAfter,
        });
      }
      entry.state = 'half_open';
    }
  }

  public recordSuccess(host: string): void {
    const entry = this.entryFor(host);
    entry.failures = [];
    entry.state = 'closed';
  }

  public recordFailure(host: string): void {
    const entry = this.entryFor(host);
    const now = nowMs();
    entry.failures.push({ at: now });
    // Drop failures outside the window.
    entry.failures = entry.failures.filter(
      (f) => now - f.at <= this.options.windowMs,
    );
    if (entry.state === 'half_open') {
      // The probe failed — reopen.
      entry.state = 'open';
      entry.openedAt = now;
      return;
    }
    if (entry.failures.length >= this.options.failureThreshold) {
      entry.state = 'open';
      entry.openedAt = now;
    }
  }

  private entryFor(host: string): BreakerEntry {
    let entry = this.byHost.get(host);
    if (!entry) {
      entry = { state: 'closed', failures: [], openedAt: 0 };
      this.byHost.set(host, entry);
    }
    return entry;
  }
}

function nowMs(): number {
  const g = globalThis as unknown as {
    performance?: { now(): number };
  };
  return g.performance?.now() ?? Date.now();
}

function hostOf(url: string | undefined): string {
  if (!url) return 'unknown';
  try {
    return new URL(url).host;
  } catch {
    return 'unknown';
  }
}

/**
 * Install the circuit-breaker interceptor on an axios instance. No-op when
 * `failureThreshold <= 0`.
 */
export function installCircuitBreakerInterceptor(
  axios: AxiosInstance,
  options: CircuitBreakerOptions,
): void {
  if (options.failureThreshold <= 0 || options.windowMs <= 0 || options.openMs <= 0) {
    return;
  }
  const registry = new BreakerRegistry(options);
  axios.interceptors.request.use((config) => {
    const url = (config.baseURL ?? '') + (config.url ?? '');
    const host = hostOf(url);
    registry.precheck(host);
    // Stash the host on the config so the response handler can record the
    // outcome without re-parsing.
    (config as unknown as { _iamBreakerHost: string })._iamBreakerHost = host;
    return config;
  });
  axios.interceptors.response.use(
    (res: AxiosResponse) => {
      const host = (res.config as unknown as { _iamBreakerHost?: string })
        ._iamBreakerHost;
      if (host && res.status < 500) registry.recordSuccess(host);
      return res;
    },
    (err: AxiosError) => {
      const host = (err.config as unknown as { _iamBreakerHost?: string } | undefined)
        ?._iamBreakerHost;
      if (host) {
        const status = err.response?.status ?? 0;
        if (status === 0 || status >= 500) {
          registry.recordFailure(host);
        } else {
          registry.recordSuccess(host);
        }
      }
      return Promise.reject(err);
    },
  );
}
