/**
 * Barrel for the audit module.
 *
 * Exports the `AuditSink` interface + DI token, the closed-set of audit
 * event names, the `Redactor` utility, and the default `LoggerAuditSink`.
 *
 * Does NOT re-export `IamAuditEvent` — that DTO is already exported via
 * `src/dto/`.
 */
export { AUDIT_SINK, AUDIT_EVENT_NAMES } from './audit-sink.interface';
export type { AuditSink, AuditEventName } from './audit-sink.interface';
export { Redactor, REDACTED, REDACTED_TOKEN, DEFAULT_KEY_PATTERNS } from './redactor';
export { LoggerAuditSink } from './logger-audit-sink';
export type { LoggerAuditSinkOptions, RedactionMode } from './logger-audit-sink';
