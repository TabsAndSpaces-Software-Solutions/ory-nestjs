/**
 * Unit tests for `IamHealthIndicator` (spec unit `hlt`).
 *
 * Covers the full terminus-compatible contract:
 *   - `isHealthy(name)` returns a `HealthIndicatorResult` keyed by `name`.
 *   - Overall status is `'up'` iff every per-product probe is `'up'`.
 *   - Every configured tenant × product is probed via the tenant axios
 *     instance against `{url}/health/ready` with a 500ms timeout.
 *   - Missing admin URLs are NOT probed (Kratos admin, Keto, Hydra are
 *     optional per tenant).
 *   - Any non-200 response OR axios throw marks the probe as `'down'`.
 *   - On overall `'down'`, a `HealthCheckError` is thrown whose `causes`
 *     payload equals the result.
 *   - One `health.probe_failure` audit event is emitted per failing probe,
 *     carrying `{ tenant, product }` attributes — NO url/header/token data.
 *   - Without an `AuditSink`, failures fall back to `Logger.warn`.
 *   - No retries: a single timeout / failure = down.
 *
 * Test strategy:
 *   - Stub `TenantRegistry` with an in-memory map.
 *   - Stub each tenant's axios instance with a `get: jest.fn()` whose
 *     resolution/rejection we control per test.
 *   - Use bare `TenantConfig` shapes; the indicator only reads
 *     `kratos.{publicUrl,adminUrl}`, `keto.{readUrl,writeUrl}`,
 *     `hydra.adminUrl`.
 */
import 'reflect-metadata';
import { Logger } from '@nestjs/common';

import type { TenantClients } from '../../../src/clients';
import type { TenantConfig } from '../../../src/config';
import type { TenantName, IamAuditEvent } from '../../../src/dto';
import type { AuditSink } from '../../../src/audit';
import type { TenantRegistry } from '../../../src/module/registry/tenant-registry.service';
import {
  HealthCheckError,
  type HealthIndicatorResult,
} from '../../../src/health/health-check-error';
import { IamHealthIndicator } from '../../../src/health/iam-health.indicator';

// ---------- test helpers ----------

interface StubAxios {
  get: jest.Mock;
}

function makeAxios(): StubAxios {
  return { get: jest.fn() };
}

function okResponse(): { status: number } {
  return { status: 200 };
}

function badResponse(status = 500): { status: number } {
  return { status };
}

function makeSink(): { sink: AuditSink; emitted: IamAuditEvent[] } {
  const emitted: IamAuditEvent[] = [];
  const sink: AuditSink = {
    emit: (event: IamAuditEvent): void => {
      emitted.push(event);
    },
  };
  return { sink, emitted };
}

type TenantSpec = {
  kratosPublic: string;
  kratosAdmin?: string;
  ketoRead?: string;
  ketoWrite?: string;
  hydraAdmin?: string;
};

function makeTenantConfig(spec: TenantSpec): TenantConfig {
  const config: Record<string, unknown> = {
    mode: 'self-hosted',
    transport: 'cookie',
    kratos: {
      publicUrl: spec.kratosPublic,
      sessionCookieName: 'ory_kratos_session',
      ...(spec.kratosAdmin !== undefined ? { adminUrl: spec.kratosAdmin } : {}),
    },
  };
  if (spec.ketoRead !== undefined && spec.ketoWrite !== undefined) {
    config.keto = { readUrl: spec.ketoRead, writeUrl: spec.ketoWrite };
  }
  if (spec.hydraAdmin !== undefined) {
    config.hydra = { publicUrl: 'http://hydra.test', adminUrl: spec.hydraAdmin };
  }
  return config as unknown as TenantConfig;
}

function makeClients(
  name: TenantName,
  spec: TenantSpec,
  axios: StubAxios,
): TenantClients {
  return {
    tenant: name,
    config: makeTenantConfig(spec),
    axios: axios as unknown as TenantClients['axios'],
    kratosFrontend: {} as never,
  } as unknown as TenantClients;
}

function makeRegistry(
  tenants: Record<TenantName, TenantClients>,
): TenantRegistry {
  return {
    get: (name: TenantName): TenantClients => {
      const c = tenants[name];
      if (c === undefined) throw new Error(`unknown tenant: ${name}`);
      return c;
    },
    tryGet: (name: TenantName): TenantClients | undefined => tenants[name],
    defaultTenant: (): TenantName | undefined => undefined,
    list: (): TenantName[] => Object.keys(tenants),
  } as unknown as TenantRegistry;
}

// ---------- tests ----------

describe('IamHealthIndicator', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  describe('isHealthy() — all probes up', () => {
    it('single tenant, public-only: returns overall up with a single kratos_public probe', async () => {
      const axios = makeAxios();
      axios.get.mockResolvedValue(okResponse());
      const clients = makeClients(
        'customer',
        { kratosPublic: 'http://kratos.test' },
        axios,
      );
      const registry = makeRegistry({ customer: clients });
      const { sink, emitted } = makeSink();

      const indicator = new IamHealthIndicator(registry, sink);
      const result = await indicator.isHealthy();

      expect(result).toEqual<HealthIndicatorResult>({
        'ory-nestjs': {
          status: 'up',
          tenants: {
            customer: { kratos_public: 'up' },
          },
        },
      });
      expect(axios.get).toHaveBeenCalledTimes(1);
      expect(axios.get).toHaveBeenCalledWith(
        'http://kratos.test/health/ready',
        expect.objectContaining({ timeout: 500 }),
      );
      expect(emitted).toHaveLength(0);
    });

    it('multi-product tenant: probes public + admin + keto_read + keto_write + hydra_admin', async () => {
      const axios = makeAxios();
      axios.get.mockResolvedValue(okResponse());
      const clients = makeClients(
        'customer',
        {
          kratosPublic: 'http://kratos.test',
          kratosAdmin: 'http://kratos-admin.test',
          ketoRead: 'http://keto-read.test',
          ketoWrite: 'http://keto-write.test',
          hydraAdmin: 'http://hydra-admin.test',
        },
        axios,
      );
      const registry = makeRegistry({ customer: clients });
      const { sink } = makeSink();

      const indicator = new IamHealthIndicator(registry, sink);
      const result = await indicator.isHealthy();

      expect(result['ory-nestjs'].status).toBe('up');
      expect(result['ory-nestjs'].tenants).toEqual({
        customer: {
          kratos_public: 'up',
          kratos_admin: 'up',
          keto_read: 'up',
          keto_write: 'up',
          hydra_admin: 'up',
        },
      });
      expect(axios.get).toHaveBeenCalledTimes(5);
      const urls = axios.get.mock.calls.map((c) => c[0]).sort();
      expect(urls).toEqual(
        [
          'http://hydra-admin.test/health/ready',
          'http://keto-read.test/health/ready',
          'http://keto-write.test/health/ready',
          'http://kratos-admin.test/health/ready',
          'http://kratos.test/health/ready',
        ].sort(),
      );
    });

    it('accepts a custom indicator name', async () => {
      const axios = makeAxios();
      axios.get.mockResolvedValue(okResponse());
      const clients = makeClients(
        'customer',
        { kratosPublic: 'http://kratos.test' },
        axios,
      );
      const registry = makeRegistry({ customer: clients });
      const { sink } = makeSink();

      const indicator = new IamHealthIndicator(registry, sink);
      const result = await indicator.isHealthy('iam-readiness');
      expect(result['iam-readiness'].status).toBe('up');
    });

    it('tenant without admin config: admin probe is NOT attempted and NOT reported', async () => {
      const axios = makeAxios();
      axios.get.mockResolvedValue(okResponse());
      const clients = makeClients(
        'admin',
        { kratosPublic: 'http://kratos.test' }, // no adminUrl, no keto, no hydra
        axios,
      );
      const registry = makeRegistry({ admin: clients });
      const { sink } = makeSink();

      const indicator = new IamHealthIndicator(registry, sink);
      const result = await indicator.isHealthy();

      expect(result['ory-nestjs'].tenants).toEqual({
        admin: { kratos_public: 'up' },
      });
      // Only one probe fired — no kratos_admin / keto_* / hydra_* keys.
      expect(axios.get).toHaveBeenCalledTimes(1);
    });

    it('multi-tenant: each tenant contributes its own probe map', async () => {
      const axiosA = makeAxios();
      axiosA.get.mockResolvedValue(okResponse());
      const axiosB = makeAxios();
      axiosB.get.mockResolvedValue(okResponse());

      const customer = makeClients(
        'customer',
        {
          kratosPublic: 'http://k-c.test',
          kratosAdmin: 'http://k-c-admin.test',
          ketoRead: 'http://kr-c.test',
          ketoWrite: 'http://kw-c.test',
        },
        axiosA,
      );
      const adminTen = makeClients(
        'admin',
        { kratosPublic: 'http://k-a.test' },
        axiosB,
      );
      const registry = makeRegistry({ customer, admin: adminTen });
      const { sink } = makeSink();

      const indicator = new IamHealthIndicator(registry, sink);
      const result = await indicator.isHealthy();

      expect(result['ory-nestjs'].status).toBe('up');
      expect(result['ory-nestjs'].tenants).toEqual({
        customer: {
          kratos_public: 'up',
          kratos_admin: 'up',
          keto_read: 'up',
          keto_write: 'up',
        },
        admin: { kratos_public: 'up' },
      });
    });
  });

  describe('isHealthy() — one probe down', () => {
    it('marks the failing product down; overall status flips to down', async () => {
      const axios = makeAxios();
      axios.get.mockImplementation((url: string) => {
        if (url === 'http://keto-read.test/health/ready') {
          return Promise.resolve(badResponse(503));
        }
        return Promise.resolve(okResponse());
      });
      const clients = makeClients(
        'customer',
        {
          kratosPublic: 'http://kratos.test',
          kratosAdmin: 'http://kratos-admin.test',
          ketoRead: 'http://keto-read.test',
          ketoWrite: 'http://keto-write.test',
        },
        axios,
      );
      const registry = makeRegistry({ customer: clients });
      const { sink } = makeSink();

      const indicator = new IamHealthIndicator(registry, sink);
      await expect(indicator.isHealthy()).rejects.toBeInstanceOf(
        HealthCheckError,
      );
    });

    it('HealthCheckError.causes mirrors the result with per-tenant × per-product statuses', async () => {
      const axios = makeAxios();
      axios.get.mockImplementation((url: string) => {
        if (url === 'http://keto-read.test/health/ready') {
          return Promise.resolve(badResponse(500));
        }
        return Promise.resolve(okResponse());
      });
      const clients = makeClients(
        'customer',
        {
          kratosPublic: 'http://kratos.test',
          ketoRead: 'http://keto-read.test',
          ketoWrite: 'http://keto-write.test',
        },
        axios,
      );
      const registry = makeRegistry({ customer: clients });
      const { sink } = makeSink();

      const indicator = new IamHealthIndicator(registry, sink);
      let caught: unknown;
      try {
        await indicator.isHealthy();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(HealthCheckError);
      const err = caught as HealthCheckError;
      expect(err.causes['ory-nestjs'].status).toBe('down');
      expect(err.causes['ory-nestjs'].tenants).toEqual({
        customer: {
          kratos_public: 'up',
          keto_read: 'down',
          keto_write: 'up',
        },
      });
    });

    it('emits one health.probe_failure audit event per failing probe', async () => {
      const axios = makeAxios();
      axios.get.mockImplementation((url: string) => {
        if (url === 'http://keto-read.test/health/ready') {
          return Promise.resolve(badResponse(500));
        }
        if (url === 'http://keto-write.test/health/ready') {
          return Promise.reject(new Error('econnrefused'));
        }
        return Promise.resolve(okResponse());
      });
      const clients = makeClients(
        'customer',
        {
          kratosPublic: 'http://kratos.test',
          ketoRead: 'http://keto-read.test',
          ketoWrite: 'http://keto-write.test',
        },
        axios,
      );
      const registry = makeRegistry({ customer: clients });
      const { sink, emitted } = makeSink();

      const indicator = new IamHealthIndicator(registry, sink);
      await expect(indicator.isHealthy()).rejects.toBeInstanceOf(
        HealthCheckError,
      );

      expect(emitted).toHaveLength(2);
      const events = emitted.map((e) => ({
        event: e.event,
        tenant: e.tenant,
        result: e.result,
        attributes: e.attributes,
      }));
      expect(events).toEqual(
        expect.arrayContaining([
          {
            event: 'health.probe_failure',
            tenant: 'customer',
            result: 'failure',
            attributes: { tenant: 'customer', product: 'keto_read' },
          },
          {
            event: 'health.probe_failure',
            tenant: 'customer',
            result: 'failure',
            attributes: { tenant: 'customer', product: 'keto_write' },
          },
        ]),
      );
      // Every event has an ISO timestamp string.
      for (const evt of emitted) {
        expect(typeof evt.timestamp).toBe('string');
        expect(evt.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      }
    });

    it('does NOT leak URLs, tokens, or headers into the payload or audit events', async () => {
      const axios = makeAxios();
      axios.get.mockImplementation((url: string) => {
        if (url === 'http://secret-keto.internal/health/ready') {
          return Promise.reject(
            Object.assign(new Error('boom'), {
              config: {
                headers: { Authorization: 'Bearer s3cr3t' },
                url: 'http://secret-keto.internal/health/ready',
              },
            }),
          );
        }
        return Promise.resolve(okResponse());
      });
      const clients = makeClients(
        'customer',
        {
          kratosPublic: 'http://kratos.test',
          ketoRead: 'http://secret-keto.internal',
          ketoWrite: 'http://kw.test',
        },
        axios,
      );
      const registry = makeRegistry({ customer: clients });
      const { sink, emitted } = makeSink();

      const indicator = new IamHealthIndicator(registry, sink);
      let caught: unknown;
      try {
        await indicator.isHealthy();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(HealthCheckError);
      const err = caught as HealthCheckError;
      const payloadStr = JSON.stringify(err.causes);
      expect(payloadStr).not.toContain('secret-keto.internal');
      expect(payloadStr).not.toContain('Bearer');
      expect(payloadStr).not.toContain('s3cr3t');
      expect(payloadStr).not.toContain('/health/ready');

      const eventsStr = JSON.stringify(emitted);
      expect(eventsStr).not.toContain('secret-keto.internal');
      expect(eventsStr).not.toContain('Bearer');
      expect(eventsStr).not.toContain('s3cr3t');
    });

    it('non-200 status codes (e.g. 204, 301) are treated as down', async () => {
      const axios = makeAxios();
      axios.get.mockImplementation((url: string) => {
        if (url === 'http://kratos.test/health/ready') {
          return Promise.resolve(badResponse(204));
        }
        return Promise.resolve(okResponse());
      });
      const clients = makeClients(
        'customer',
        { kratosPublic: 'http://kratos.test' },
        axios,
      );
      const registry = makeRegistry({ customer: clients });
      const { sink } = makeSink();

      const indicator = new IamHealthIndicator(registry, sink);
      await expect(indicator.isHealthy()).rejects.toBeInstanceOf(
        HealthCheckError,
      );
    });
  });

  describe('isHealthy() — probe timeout', () => {
    it('timeout / rejection marks the probe down without retry', async () => {
      const axios = makeAxios();
      const getSpy = jest.fn().mockImplementation(() =>
        Promise.reject(
          Object.assign(new Error('timeout of 500ms exceeded'), {
            code: 'ECONNABORTED',
          }),
        ),
      );
      axios.get = getSpy;
      const clients = makeClients(
        'customer',
        { kratosPublic: 'http://kratos.test' },
        axios,
      );
      const registry = makeRegistry({ customer: clients });
      const { sink, emitted } = makeSink();

      const indicator = new IamHealthIndicator(registry, sink);
      await expect(indicator.isHealthy()).rejects.toBeInstanceOf(
        HealthCheckError,
      );

      // Exactly one GET call — no retry.
      expect(getSpy).toHaveBeenCalledTimes(1);
      expect(emitted).toHaveLength(1);
      expect(emitted[0].event).toBe('health.probe_failure');
      expect(emitted[0].attributes).toEqual({
        tenant: 'customer',
        product: 'kratos_public',
      });
    });

    it('passes a 500ms timeout to axios.get', async () => {
      const axios = makeAxios();
      axios.get.mockResolvedValue(okResponse());
      const clients = makeClients(
        'customer',
        { kratosPublic: 'http://kratos.test' },
        axios,
      );
      const registry = makeRegistry({ customer: clients });
      const { sink } = makeSink();

      const indicator = new IamHealthIndicator(registry, sink);
      await indicator.isHealthy();
      expect(axios.get).toHaveBeenCalledWith(
        'http://kratos.test/health/ready',
        expect.objectContaining({ timeout: 500 }),
      );
    });
  });

  describe('AuditSink fallback', () => {
    it('without a sink, falls back to Logger.warn for failing probes', async () => {
      const axios = makeAxios();
      axios.get.mockRejectedValue(new Error('boom'));
      const clients = makeClients(
        'customer',
        { kratosPublic: 'http://kratos.test' },
        axios,
      );
      const registry = makeRegistry({ customer: clients });

      const warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      // Construct WITHOUT an AuditSink.
      const indicator = new IamHealthIndicator(registry);
      await expect(indicator.isHealthy()).rejects.toBeInstanceOf(
        HealthCheckError,
      );

      expect(warnSpy).toHaveBeenCalled();
      // The logged payload must include the structured event shape and
      // must not leak any URL / header / token content.
      const allCalls = JSON.stringify(warnSpy.mock.calls);
      expect(allCalls).toContain('health.probe_failure');
      expect(allCalls).toContain('kratos_public');
      expect(allCalls).toContain('customer');
      expect(allCalls).not.toContain('/health/ready');
      expect(allCalls).not.toContain('kratos.test');
    });
  });

  describe('barrel exports', () => {
    it('re-exports IamHealthIndicator + HealthCheckError + HealthIndicatorResult', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const barrel = require('../../../src/health');
      expect(typeof barrel.IamHealthIndicator).toBe('function');
      expect(typeof barrel.HealthCheckError).toBe('function');
      const err = new barrel.HealthCheckError('x', {});
      expect(err.name).toBe('HealthCheckError');
    });
  });
});
