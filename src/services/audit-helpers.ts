/**
 * Shared audit-emission helpers for mutating service calls.
 *
 * Every mutating method across Kratos admin, Hydra, Keto, and Ory Network
 * services emits a structured audit event with a stable name of the form
 * `iam.<product>.<action>`. Centralising emission here keeps the shape and
 * redaction consistent and makes the test assertions trivial.
 */
import type { AuditSink } from '../audit';
import { correlationStorage } from '../clients/correlation-storage';
import type { TenantName } from '../dto';

export interface AuditEmitOpts {
  readonly targetId?: string;
  readonly attributes?: Record<string, unknown>;
  readonly result?: 'success' | 'failure' | 'deny';
}

export async function emitAudit(
  audit: AuditSink,
  event: string,
  tenant: TenantName,
  opts: AuditEmitOpts = {},
): Promise<void> {
  await audit.emit({
    timestamp: new Date().toISOString(),
    event,
    tenant,
    result: opts.result ?? 'success',
    ...(opts.targetId ? { targetId: opts.targetId } : {}),
    attributes: opts.attributes ?? {},
    correlationId: correlationStorage.getStore()?.correlationId,
  });
}
