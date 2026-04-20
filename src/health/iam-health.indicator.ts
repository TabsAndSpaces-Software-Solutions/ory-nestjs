/**
 * `IamHealthIndicator` — per-tenant × per-product Ory reachability probe.
 *
 * Spec unit: `hlt`.
 *
 * Contract:
 *   - Duck-types the `@nestjs/terminus` `HealthIndicator` interface so
 *     consumers can drop it into `TerminusModule` without this library
 *     taking a runtime dep on terminus. See `health-check-error.ts` for
 *     the shared `HealthIndicatorResult` shape.
 *   - `isHealthy(name = 'ory-nestjs'): Promise<HealthIndicatorResult>` iterates
 *     the `TenantRegistry` and, for each tenant × configured product
 *     (Kratos public always; Kratos admin / Keto read+write / Hydra admin
 *     only when configured), fires ONE `GET {url}/health/ready` request
 *     with a 500ms timeout using the tenant's own axios instance.
 *   - A probe is `'up'` iff the response status is exactly 200. Any other
 *     status, any thrown error, or the 500ms timeout firing marks the probe
 *     `'down'`. NO retries — a single failure is definitive.
 *   - Aggregate: if any probe is down, overall status flips to `'down'` and
 *     `isHealthy()` throws `HealthCheckError` with the full result as
 *     `causes`. When everything is up, it resolves to the `HealthIndicatorResult`.
 *
 * Security:
 *   - The payload (and any audit event) names ONLY `tenant` + `product`.
 *     It never carries URLs, tokens, response bodies, or request headers —
 *     a leaked health endpoint is still a valuable signal to an attacker.
 *   - The indicator never reads the probe's response body.
 *
 * Audit:
 *   - Each failing probe emits `health.probe_failure` through the injected
 *     `AuditSink` (see `../audit`). When no `AuditSink` is bound (the
 *     `AUDIT_SINK` provider is `@Optional()`), we fall back to the NestJS
 *     `Logger.warn` with a structured payload identical in shape to the
 *     audit event. The fallback log MUST preserve the same no-secrets
 *     invariant as the audit event.
 *
 * Concurrency:
 *   - Probes run in parallel via `Promise.all`. The 500ms timeout is enforced
 *     by axios itself (per `timeout` in the request config), which means
 *     the aggregate latency of `isHealthy()` is bounded by ~500ms + a bit
 *     regardless of how many probes fire.
 *
 * Zero-Ory-leakage:
 *   - This file does not import from `@ory/*`. It only touches
 *     `clients.axios`, which is a plain `AxiosInstance`.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { AUDIT_SINK, type AuditSink } from '../audit';
import type { TenantClients } from '../clients';
import type { TenantName, IamAuditEvent } from '../dto';
import type { TenantRegistry } from '../module/registry/tenant-registry.service';
import { TENANT_REGISTRY } from '../module/registry/tokens';

import {
  HealthCheckError,
  type HealthIndicatorResult,
} from './health-check-error';

/** Fixed per-probe timeout. Keep as a named const so tests can reference it. */
const PROBE_TIMEOUT_MS = 500;

/**
 * Per-tenant × per-product status map. Values are always `'up' | 'down'`.
 */
type TenantProbeMap = Record<string, 'up' | 'down'>;

/**
 * Internal descriptor for a single probe. `url` is used ONLY to issue the
 * request; it MUST NEVER appear in the result payload or audit events.
 */
interface ProbeDescriptor {
  readonly tenant: TenantName;
  readonly product: string;
  readonly url: string;
  readonly clients: TenantClients;
}

@Injectable()
export class IamHealthIndicator {
  private readonly logger = new Logger('IamHealthIndicator');

  public constructor(
    @Inject(TENANT_REGISTRY) private readonly registry: TenantRegistry,
    @Optional()
    @Inject(AUDIT_SINK)
    private readonly audit?: AuditSink,
  ) {}

  /**
   * Terminus-compatible health-indicator method. See the class comment for
   * the full contract.
   */
  public async isHealthy(
    name = 'ory-nestjs',
  ): Promise<HealthIndicatorResult> {
    const descriptors = this.collectDescriptors();

    const probeResults = await Promise.all(
      descriptors.map(async (desc) => {
        const status = await this.probe(desc);
        return { desc, status };
      }),
    );

    const tenants: Record<TenantName, TenantProbeMap> = {};
    let overall: 'up' | 'down' = 'up';
    const failures: ProbeDescriptor[] = [];

    for (const { desc, status } of probeResults) {
      const bucket = tenants[desc.tenant] ?? (tenants[desc.tenant] = {});
      bucket[desc.product] = status;
      if (status === 'down') {
        overall = 'down';
        failures.push(desc);
      }
    }

    const result: HealthIndicatorResult = {
      [name]: {
        status: overall,
        tenants,
      },
    };

    // Emit audit events / log-fallbacks AFTER building the payload but
    // BEFORE throwing — terminus consumers expect the error thrown from
    // `isHealthy` to be the structured one, and emissions must happen even
    // on the error path.
    for (const desc of failures) {
      await this.emitProbeFailure(desc);
    }

    if (overall === 'down') {
      throw new HealthCheckError('ory-nestjs probe failed', result);
    }
    return result;
  }

  /**
   * Walk every declared tenant and emit a `ProbeDescriptor` for each
   * configured product. Kratos public is always included; admin / Keto /
   * Hydra only when the relevant URL is set.
   */
  private collectDescriptors(): ProbeDescriptor[] {
    const out: ProbeDescriptor[] = [];
    for (const tenant of this.registry.list()) {
      const clients = this.registry.get(tenant);
      const cfg = clients.config;

      out.push({
        tenant,
        product: 'kratos_public',
        url: joinHealthReady(cfg.kratos.publicUrl),
        clients,
      });

      if (cfg.kratos.adminUrl !== undefined) {
        out.push({
          tenant,
          product: 'kratos_admin',
          url: joinHealthReady(cfg.kratos.adminUrl),
          clients,
        });
      }

      if (cfg.keto !== undefined) {
        out.push({
          tenant,
          product: 'keto_read',
          url: joinHealthReady(cfg.keto.readUrl),
          clients,
        });
        out.push({
          tenant,
          product: 'keto_write',
          url: joinHealthReady(cfg.keto.writeUrl),
          clients,
        });
      }

      if (cfg.hydra !== undefined) {
        out.push({
          tenant,
          product: 'hydra_admin',
          url: joinHealthReady(cfg.hydra.adminUrl),
          clients,
        });
      }
    }
    return out;
  }

  /**
   * Fire a single probe against `desc.url` using the tenant's axios
   * instance. Returns `'up'` only on an exact 200 response; everything else
   * (non-200, timeout, network error) is `'down'`. NO retries — the axios
   * instance's retry interceptor is bypassed because a health probe must
   * reflect the current steady-state reachability.
   */
  private async probe(desc: ProbeDescriptor): Promise<'up' | 'down'> {
    try {
      const res = await desc.clients.axios.get(desc.url, {
        timeout: PROBE_TIMEOUT_MS,
        // Do not throw on non-2xx so we can classify ourselves.
        validateStatus: () => true,
      });
      return res?.status === 200 ? 'up' : 'down';
    } catch {
      // Any throw (timeout, ECONNREFUSED, DNS, etc.) counts as down.
      // We deliberately do NOT inspect the error — doing so risks leaking
      // URL/header content via logs.
      return 'down';
    }
  }

  /**
   * Emit a `health.probe_failure` audit event for a single failing probe.
   * When no `AuditSink` is bound, log a warning with the same structured
   * payload so the information is not lost. In neither case do we include
   * URLs, tokens, or headers.
   */
  private async emitProbeFailure(desc: ProbeDescriptor): Promise<void> {
    const event: IamAuditEvent = {
      timestamp: new Date().toISOString(),
      event: 'health.probe_failure',
      tenant: desc.tenant,
      result: 'failure',
      attributes: {
        tenant: desc.tenant,
        product: desc.product,
      },
    };

    if (this.audit !== undefined) {
      await this.audit.emit(event);
      return;
    }
    this.logger.warn(event);
  }
}

/**
 * Join a base URL with `/health/ready`, collapsing any trailing slash on
 * the base so we never produce `…//health/ready`.
 */
function joinHealthReady(baseUrl: string): string {
  const trimmed = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${trimmed}/health/ready`;
}
