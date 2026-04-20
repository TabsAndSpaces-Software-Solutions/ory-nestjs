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
