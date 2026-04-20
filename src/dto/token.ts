/**
 * Library-owned OAuth2 token DTOs.
 *
 * Zero-Ory-leakage contract: this file MUST NOT import from `@ory/*`.
 */
import type { TenantName } from './tenant';

export interface IamToken {
  readonly accessToken: string;
  readonly tokenType: 'Bearer';
  /** Seconds until the access token expires. */
  readonly expiresIn: number;
  readonly scope: readonly string[];
  readonly tenant: TenantName;
}

export interface IamTokenIntrospection {
  readonly active: boolean;
  readonly subject?: string;
  readonly clientId?: string;
  readonly scope?: readonly string[];
  /** Epoch seconds. */
  readonly exp?: number;
  /** Epoch seconds. */
  readonly iat?: number;
  readonly tenant: TenantName;
}
