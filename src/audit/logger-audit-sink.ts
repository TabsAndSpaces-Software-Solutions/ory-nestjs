/**
 * `LoggerAuditSink` — default `AuditSink` implementation that wraps a NestJS
 * `Logger` and emits structured audit lines.
 *
 * Behavior:
 *   - Runs every event through the configured `Redactor` BEFORE delivery.
 *     Consumers can opt out with `{ redactionMode: 'raw' }` (dev-only; do NOT
 *     use in production).
 *   - Log-level selection:
 *       * `result === 'success'` → `info` (`Logger.log`)
 *       * events starting with `authz.permission.grant` or
 *         `authz.session.revoke` → `info`
 *       * `result === 'failure'` or `result === 'deny'` → `warn`
 *       * everything else falls back to `info`.
 *   - Passes the full (redacted) event object to the logger so structured
 *     sinks can JSON-serialize it.
 */
import { Logger } from '@nestjs/common';
import type { IamAuditEvent } from '../dto';
import type { AuditSink } from './audit-sink.interface';
import { Redactor } from './redactor';

export type RedactionMode = 'default' | 'raw';

export interface LoggerAuditSinkOptions {
  /**
   * When set to `'raw'`, the sink bypasses redaction and forwards the event
   * untouched. Intended for local development only — DO NOT use in prod.
   */
  readonly redactionMode?: RedactionMode;
}

export class LoggerAuditSink implements AuditSink {
  private readonly redactor: Redactor;
  private readonly logger: Logger;
  private readonly redactionMode: RedactionMode;

  public constructor(
    redactor: Redactor,
    logger?: Logger,
    opts?: LoggerAuditSinkOptions,
  ) {
    this.redactor = redactor;
    this.logger = logger ?? new Logger('OryNestjs.Audit');
    this.redactionMode = opts?.redactionMode ?? 'default';
  }

  public emit(event: IamAuditEvent): void {
    const payload =
      this.redactionMode === 'raw'
        ? event
        : (this.redactor.redact(event) as IamAuditEvent);

    if (this.isWarnLevel(event)) {
      this.logger.warn(payload);
    } else {
      this.logger.log(payload);
    }
  }

  private isWarnLevel(event: IamAuditEvent): boolean {
    if (event.result === 'failure' || event.result === 'deny') return true;
    return false;
  }
}
