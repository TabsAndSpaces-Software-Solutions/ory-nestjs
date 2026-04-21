/**
 * Library-owned identity DTOs.
 *
 * `IamIdentity` is the sanitized projection consumers see by default —
 * traits are stripped to prevent PII leakage. Callers who explicitly need
 * traits receive a `IamIdentityWithTraits`.
 *
 * Zero-Ory-leakage contract: this file MUST NOT import from `@ory/*`.
 */
import type { TenantName } from './tenant';

/** Whether the identity has verified email / phone addresses. */
export interface IamVerifiedAddressesFlags {
  readonly email: boolean;
  readonly phone: boolean;
}

/** Sanitized identity (no traits). */
export interface IamIdentity {
  readonly id: string;
  readonly schemaId: string;
  readonly state: 'active' | 'inactive';
  readonly verifiedAddressesFlags: IamVerifiedAddressesFlags;
  readonly metadataPublic?: Record<string, unknown>;
  readonly tenant: TenantName;
}

/** Identity with traits attached — use only when callers explicitly need them. */
export interface IamIdentityWithTraits extends IamIdentity {
  readonly traits: Record<string, unknown>;
}

/**
 * Identity schema descriptor — the JSON-Schema fragment used by Kratos
 * for a given `schema_id`. Consumers typically render `schema` to build
 * registration/settings forms dynamically.
 */
export interface IamIdentitySchema {
  readonly id: string;
  readonly schema: Record<string, unknown>;
  readonly tenant: TenantName;
}

/**
 * Delivered courier message metadata. `body` is intentionally redacted by
 * default (full message bodies contain tokens, recovery codes, and links);
 * consumers that need the body must opt in via `includeBody: true` at the
 * service call site.
 */
export interface IamCourierMessage {
  readonly id: string;
  readonly status: 'queued' | 'sent' | 'processing' | 'abandoned';
  readonly channel: 'email' | 'sms' | string;
  readonly recipient: string;
  readonly subject: string;
  readonly templateType: string;
  readonly createdAt: string;
  readonly sendCount: number;
  readonly body?: string;
  readonly tenant: TenantName;
}
