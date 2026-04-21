/**
 * `AxiosFactory.create(tenant, deps)` — constructs the single per-tenant
 * `AxiosInstance` that backs every Ory API client for that tenant.
 *
 * Design:
 *   - The axios `timeout` defaults to 5000ms. Tenants can override by
 *     declaring a `timeoutMs` field on the config (not yet in the zod
 *     schema; optional forward-compat). The default covers all current
 *     deployments.
 *   - Keep-alive http/https agents on the instance permit connection reuse
 *     across every API call to the same tenant — important for the
 *     serverless/NestJS-long-process mix where TCP setup cost adds up.
 *   - Interceptor order (response pipeline) matters: axios runs error
 *     handlers in reverse registration order, so `redactErrorHandler` is
 *     registered LAST (runs FIRST) to ensure retried errors are not
 *     re-scrubbed a second time and no unredacted state survives if retry
 *     ultimately fails.
 *
 * The factory is a static utility — there is exactly one way to build the
 * instance and it has no state of its own. `deps.redactor` is injected so
 * the caller can hand in an instance already extended with project-specific
 * key patterns (the default is fine for most deployments).
 */
import * as http from 'node:http';
import * as https from 'node:https';
import axios, { AxiosInstance } from 'axios';

import type { Redactor } from '../audit';
import type { ValidatedTenantConfig } from '../config';
import { applyRequestId } from './interceptors/request-id.interceptor';
import { redactErrorHandler } from './interceptors/redact-error.interceptor';
import { installRetryInterceptor } from './interceptors/retry.interceptor';

export interface AxiosFactoryDeps {
  redactor: Redactor;
}

/** Tenant configs may optionally set a per-tenant timeout override. */
interface TenantWithTimeout {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

export class AxiosFactory {
  private constructor() {
    throw new Error('AxiosFactory is a static class and cannot be instantiated.');
  }

  /**
   * Construct the shared-per-tenant axios instance.
   *
   * No `baseURL` is set — each `@ory/client` API instance supplies its own
   * `basePath` when dispatching requests (see `OryClientFactory`).
   */
  public static create(
    tenant: ValidatedTenantConfig,
    deps: AxiosFactoryDeps,
  ): AxiosInstance {
    const timeout =
      (tenant as ValidatedTenantConfig & TenantWithTimeout).timeoutMs ??
      DEFAULT_TIMEOUT_MS;

    const instance = axios.create({
      timeout,
      httpAgent: new http.Agent({ keepAlive: true }),
      httpsAgent: new https.Agent({ keepAlive: true }),
    });

    // Request pipeline: stamp an x-request-id onto every outbound request.
    instance.interceptors.request.use(applyRequestId);

    // Response pipeline.
    //   First: install retry (runs AFTER redact on errors, since axios
    //   executes error handlers in reverse registration order).
    //   Second: install redact (runs FIRST on errors) — this ensures that
    //   every error observed by retry and every error that ultimately
    //   propagates has been scrubbed exactly once.
    installRetryInterceptor(instance);
    instance.interceptors.response.use(
      (response) => response,
      redactErrorHandler(deps.redactor),
    );

    return instance;
  }
}
