/**
 * Library-owned self-service flow DTOs (login / registration / recovery /
 * settings / verification).
 *
 * `IamFlowUi.nodes` and `IamFlowUi.messages` are loosely typed for v1 —
 * they pass through Kratos's UI structure. A stricter type can be introduced
 * later without breaking callers that render the UI generically.
 *
 * Zero-Ory-leakage contract: this file MUST NOT import from `@ory/*`.
 */
import type { TenantName } from './tenant';

export interface IamFlowUi {
  readonly nodes: readonly unknown[];
  readonly messages: readonly unknown[];
}

interface IamFlowBase {
  readonly id: string;
  /** ISO 8601 timestamp. */
  readonly expiresAt: string;
  readonly ui: IamFlowUi;
  readonly csrfToken: string;
  readonly tenant: TenantName;
}

export type IamLoginFlow = IamFlowBase;
export type IamRegistrationFlow = IamFlowBase;
export type IamRecoveryFlow = IamFlowBase;
export type IamSettingsFlow = IamFlowBase;
export type IamVerificationFlow = IamFlowBase;

/**
 * Logout token envelope returned by Kratos browser-logout initiation.
 *
 * Logout is not a regular "flow" in Kratos — for browser clients it returns
 * a single `{ logout_token, logout_url }` pair you submit to complete the
 * action; for native clients there's no envelope at all (you call
 * `performNativeLogout` with the session token directly). We model the
 * browser envelope here; the native path only needs the session token on
 * input and returns `void` on success.
 */
export interface IamLogoutFlow {
  readonly logoutToken: string;
  readonly logoutUrl: string;
  readonly tenant: TenantName;
}
