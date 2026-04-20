/**
 * Audit sink abstraction.
 *
 * Consumers can plug in their own sink (e.g., OTel exporter, Kafka producer,
 * custom writer) by implementing `AuditSink` and binding it under the
 * `AUDIT_SINK` DI token. The default implementation is `LoggerAuditSink`.
 *
 * Every default code path in ory-nestjs runs events through a `Redactor`
 * BEFORE they reach the sink, so sinks receive already-redacted payloads
 * unless the sink wrapper explicitly opts out.
 */
import type { IamAuditEvent } from '../dto';

/**
 * Closed set of audit event names taken from the SDD's tracking table.
 */
export const AUDIT_EVENT_NAMES = [
  'auth.success',
  'auth.failure.expired',
  'auth.failure.upstream',
  'auth.failure.unsigned_header',
  'auth.failure.missing_credential',
  'auth.failure.malformed',
  'auth.failure.token_inactive',
  'auth.tenant_mismatch',
  'authz.role.deny',
  'authz.permission.deny',
  'authz.permission.grant',
  'authz.permission.revoke',
  'authz.session.revoke',
  'authz.upstream_unavailable',
  'config.boot_failure',
  'health.probe_failure',
] as const;

export type AuditEventName = (typeof AUDIT_EVENT_NAMES)[number];

export interface AuditSink {
  emit(event: IamAuditEvent): Promise<void> | void;
}

/**
 * DI token for the `AuditSink` binding.
 */
export const AUDIT_SINK: unique symbol = Symbol.for('ory-nestjs/audit-sink');
