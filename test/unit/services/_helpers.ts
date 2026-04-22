/**
 * Shared fixtures for v0.5.0 service unit tests.
 *
 * Provides:
 *   - `makeRegistry({ default: clients })`: a stub `TenantRegistry` backed by
 *     a record — exactly matches the shape `identity.service.test.ts` uses.
 *   - `makeClients(partial)`: a partial `TenantClients` with every optional
 *     client defaulting to `undefined`. Pass the ones your test needs.
 *   - `makeAuditSpy()`: a Jest-spy audit sink that records every emission for
 *     assertions.
 *   - `oryError(status)`: a synthetic axios-style error shape the library's
 *     ErrorMapper consumes.
 */
import type { AuditSink } from '../../../src/audit';
import type { TenantClients } from '../../../src/clients';
import type { TenantName, IamAuditEvent } from '../../../src/dto';
import { IamConfigurationError } from '../../../src/errors';
import type { TenantRegistry } from '../../../src/module/registry/tenant-registry.service';

export function makeClients(
  partial: Partial<TenantClients> & { tenant: TenantName },
): TenantClients {
  return {
    config: {} as TenantClients['config'],
    axios: {} as TenantClients['axios'],
    kratosFrontend: {} as TenantClients['kratosFrontend'],
    ...partial,
  } as TenantClients;
}

export function makeRegistry(
  byTenant: Record<TenantName, TenantClients>,
): TenantRegistry {
  const get = (name: TenantName): TenantClients => {
    const clients = byTenant[name];
    if (!clients) {
      throw new IamConfigurationError({
        message: `unknown tenant: ${name}`,
      });
    }
    return clients;
  };
  return {
    get,
    tryGet: (name: TenantName): TenantClients | undefined => byTenant[name],
    defaultTenant: () => undefined,
    list: () => Object.keys(byTenant),
  } as unknown as TenantRegistry;
}

export interface AuditSpy extends AuditSink {
  readonly events: IamAuditEvent[];
  readonly emit: jest.Mock;
}

export function makeAuditSpy(): AuditSpy {
  const events: IamAuditEvent[] = [];
  const emit = jest.fn(async (ev: IamAuditEvent) => {
    events.push(ev);
  });
  return { events, emit } as unknown as AuditSpy;
}

/**
 * Build an axios-style error the `ErrorMapper` can translate. Status `401` →
 * UnauthorizedException; `403` → ForbiddenException; `5xx` → ServiceUnavailable.
 */
export function oryError(status: number, body: unknown = { error: { message: 'oops' } }): Error {
  const err = new Error(`upstream ${status}`) as Error & {
    isAxiosError?: boolean;
    response?: { status: number; data: unknown };
  };
  err.isAxiosError = true;
  err.response = { status, data: body };
  return err;
}
