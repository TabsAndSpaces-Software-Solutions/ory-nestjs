/**
 * Library-owned audit event DTO.
 *
 * Zero-Ory-leakage contract: this file MUST NOT import from `@ory/*`.
 */
import type { TenantName } from './tenant';

export interface IamAuditEvent {
  /** ISO 8601 timestamp. */
  readonly timestamp: string;
  readonly event: string;
  readonly tenant: TenantName;
  readonly actorId?: string;
  readonly targetId?: string;
  readonly result: 'success' | 'failure' | 'deny';
  readonly attributes: Record<string, unknown>;
  readonly correlationId?: string;
}
