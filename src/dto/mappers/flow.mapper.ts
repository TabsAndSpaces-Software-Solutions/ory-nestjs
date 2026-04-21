/**
 * Maps Kratos self-service flow types to library flow DTOs.
 *
 * All five flows (login / registration / recovery / settings / verification)
 * share the same extraction logic; we parameterise on the input type.
 */
import type {
  LoginFlow as OryLoginFlow,
  LogoutFlow as OryLogoutFlow,
  RecoveryFlow as OryRecoveryFlow,
  RegistrationFlow as OryRegistrationFlow,
  SettingsFlow as OrySettingsFlow,
  UiContainer as OryUiContainer,
  UiNode as OryUiNode,
  VerificationFlow as OryVerificationFlow,
} from '@ory/client';

import { deepFreeze } from '../freeze';
import type {
  IamFlowUi,
  IamLoginFlow,
  IamLogoutFlow,
  IamRecoveryFlow,
  IamRegistrationFlow,
  IamSettingsFlow,
  IamVerificationFlow,
} from '../flow';
import type { TenantName } from '../tenant';

/** Anything with at least `id` and a `ui` container of Kratos shape. */
interface OryLikeFlow {
  readonly id: string;
  readonly expires_at?: string;
  readonly ui: OryUiContainer;
}

function extractCsrfToken(ui: OryUiContainer | undefined): string {
  if (!ui || !Array.isArray(ui.nodes)) return '';
  for (const node of ui.nodes as OryUiNode[]) {
    const attrs = node.attributes as { name?: string; value?: unknown } | undefined;
    if (attrs && attrs.name === 'csrf_token') {
      return typeof attrs.value === 'string' ? attrs.value : '';
    }
  }
  return '';
}

function buildUi(ui: OryUiContainer | undefined): IamFlowUi {
  const nodes: readonly unknown[] = Array.isArray(ui?.nodes) ? (ui!.nodes as unknown[]) : [];
  const messages: readonly unknown[] = Array.isArray(ui?.messages)
    ? (ui!.messages as unknown[])
    : [];
  return { nodes, messages };
}

function mapFlow<T extends OryLikeFlow>(f: T, tenant: TenantName) {
  return {
    id: f.id,
    expiresAt: f.expires_at ?? '',
    ui: buildUi(f.ui),
    csrfToken: extractCsrfToken(f.ui),
    tenant,
  };
}

export const flowMapper = {
  loginFromOry(f: OryLoginFlow, tenant: TenantName): IamLoginFlow {
    return deepFreeze(mapFlow(f as unknown as OryLikeFlow, tenant));
  },
  registrationFromOry(f: OryRegistrationFlow, tenant: TenantName): IamRegistrationFlow {
    return deepFreeze(mapFlow(f as unknown as OryLikeFlow, tenant));
  },
  recoveryFromOry(f: OryRecoveryFlow, tenant: TenantName): IamRecoveryFlow {
    return deepFreeze(mapFlow(f as unknown as OryLikeFlow, tenant));
  },
  settingsFromOry(f: OrySettingsFlow, tenant: TenantName): IamSettingsFlow {
    return deepFreeze(mapFlow(f as unknown as OryLikeFlow, tenant));
  },
  verificationFromOry(f: OryVerificationFlow, tenant: TenantName): IamVerificationFlow {
    return deepFreeze(mapFlow(f as unknown as OryLikeFlow, tenant));
  },
  logoutFromOry(f: OryLogoutFlow, tenant: TenantName): IamLogoutFlow {
    const anyF = f as unknown as {
      logout_token?: unknown;
      logout_url?: unknown;
    };
    return deepFreeze({
      logoutToken: typeof anyF.logout_token === 'string' ? anyF.logout_token : '',
      logoutUrl: typeof anyF.logout_url === 'string' ? anyF.logout_url : '',
      tenant,
    });
  },
};
