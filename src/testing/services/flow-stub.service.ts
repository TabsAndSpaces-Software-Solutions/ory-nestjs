/**
 * `FlowStubService` — in-memory replacement for `FlowService`.
 *
 * Every `initiateX` returns a synthetic flow DTO stamped with the tenant
 * name and a unique id. Every `submitX` returns a `{ kind: 'success' }`
 * result (login/registration) or a `{ kind: 'continue', flow }` echo
 * (recovery/settings/verification) — the bare minimum to let controllers
 * exercise their happy path.
 *
 * Tests that need richer flow fidelity should reach for integration tests
 * against the real Kratos stack. These stubs are deliberately minimal.
 */
import { Inject, Injectable } from '@nestjs/common';

import type {
  TenantName,
  IamLoginFlow,
  IamRecoveryFlow,
  IamRegistrationFlow,
  IamSettingsFlow,
  IamVerificationFlow,
} from '../../dto';
import { TESTING_STATE, TestingState } from '../testing-state';

type IamFlowKind =
  | 'login'
  | 'registration'
  | 'recovery'
  | 'settings'
  | 'verification';

type IamAnyFlow =
  | IamLoginFlow
  | IamRegistrationFlow
  | IamRecoveryFlow
  | IamSettingsFlow
  | IamVerificationFlow;

type IamLoginResult =
  | { kind: 'success'; sessionId: string }
  | { kind: 'continue'; flow: IamLoginFlow };

type IamRegistrationResult =
  | { kind: 'success'; sessionId: string }
  | { kind: 'continue'; flow: IamRegistrationFlow };

type IamRecoveryResult = { kind: 'continue'; flow: IamRecoveryFlow };
type IamSettingsResult = { kind: 'continue'; flow: IamSettingsFlow };
type IamVerificationResult = {
  kind: 'continue';
  flow: IamVerificationFlow;
};

function makeFlow(tenant: TenantName, kind: IamFlowKind): IamLoginFlow {
  return {
    id: `fake-${kind}-${tenant}-${Date.now()}`,
    expiresAt: '2099-01-01T00:00:00.000Z',
    ui: { nodes: [], messages: [] },
    csrfToken: 'fake-csrf',
    tenant,
  };
}

class FlowStubServiceFor {
  constructor(
    private readonly tenant: TenantName,
    private readonly state: TestingState,
  ) {
    void this.state;
  }

  public async initiateLogin(
    _opts: Record<string, unknown>,
  ): Promise<IamLoginFlow> {
    void _opts;
    return makeFlow(this.tenant, 'login');
  }
  public async submitLogin(
    _flowId: string,
    _body: Record<string, unknown>,
  ): Promise<IamLoginResult> {
    void _flowId;
    void _body;
    return { kind: 'success', sessionId: 'sess-fake' };
  }

  public async initiateRegistration(
    _opts: Record<string, unknown>,
  ): Promise<IamRegistrationFlow> {
    void _opts;
    return makeFlow(this.tenant, 'registration');
  }
  public async submitRegistration(
    _flowId: string,
    _body: Record<string, unknown>,
  ): Promise<IamRegistrationResult> {
    void _flowId;
    void _body;
    return { kind: 'success', sessionId: 'sess-fake' };
  }

  public async initiateRecovery(
    _opts: Record<string, unknown>,
  ): Promise<IamRecoveryFlow> {
    void _opts;
    return makeFlow(this.tenant, 'recovery');
  }
  public async submitRecovery(
    _flowId: string,
    _body: Record<string, unknown>,
  ): Promise<IamRecoveryResult> {
    void _flowId;
    void _body;
    return { kind: 'continue', flow: makeFlow(this.tenant, 'recovery') };
  }

  public async initiateSettings(
    _opts: Record<string, unknown>,
  ): Promise<IamSettingsFlow> {
    void _opts;
    return makeFlow(this.tenant, 'settings');
  }
  public async submitSettings(
    _flowId: string,
    _body: Record<string, unknown>,
  ): Promise<IamSettingsResult> {
    void _flowId;
    void _body;
    return { kind: 'continue', flow: makeFlow(this.tenant, 'settings') };
  }

  public async initiateVerification(
    _opts: Record<string, unknown>,
  ): Promise<IamVerificationFlow> {
    void _opts;
    return makeFlow(this.tenant, 'verification');
  }
  public async submitVerification(
    _flowId: string,
    _body: Record<string, unknown>,
  ): Promise<IamVerificationResult> {
    void _flowId;
    void _body;
    return {
      kind: 'continue',
      flow: makeFlow(this.tenant, 'verification'),
    };
  }

  public async fetchFlow(
    kind: IamFlowKind,
    _flowId: string,
  ): Promise<IamAnyFlow> {
    void _flowId;
    return makeFlow(this.tenant, kind);
  }
}

@Injectable()
export class FlowStubService {
  private readonly byTenant = new Map<TenantName, FlowStubServiceFor>();

  constructor(
    @Inject(TESTING_STATE) private readonly state: TestingState,
  ) {}

  public forTenant(name: TenantName): FlowStubServiceFor {
    let existing = this.byTenant.get(name);
    if (existing === undefined) {
      existing = new FlowStubServiceFor(name, this.state);
      this.byTenant.set(name, existing);
    }
    return existing;
  }
}
