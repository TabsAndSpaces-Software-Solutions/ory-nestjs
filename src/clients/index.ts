/**
 * INTERNAL barrel for the client adapter layer.
 *
 * This module exists so internal consumers (services, module assembly,
 * transport) can import the factories / DI tokens / correlation storage
 * from one path. It MUST NOT be re-exported from `src/index.ts` — the
 * public surface is required to be @ory-free and this barrel transitively
 * imports `@ory/client` classes.
 */
export { AxiosFactory } from './axios.factory';
export type { AxiosFactoryDeps } from './axios.factory';
export { OryClientFactory } from './ory-client.factory';
export type { OryClientFactoryDeps } from './ory-client.factory';
export { correlationStorage } from './correlation-storage';
export type { CorrelationContext } from './correlation-storage';
export { TENANT_CLIENTS_TOKEN } from './internal-tokens';
export type { TenantClients } from './tenant-clients';
export {
  applyRequestId,
  requestIdInterceptor,
} from './interceptors/request-id.interceptor';
export { redactErrorHandler } from './interceptors/redact-error.interceptor';
export {
  installRetryInterceptor,
  isRetryable,
} from './interceptors/retry.interceptor';
export type { RetryOptions } from './interceptors/retry.interceptor';
