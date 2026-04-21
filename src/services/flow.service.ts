/**
 * `FlowService` — tenant-scoped proxy around Kratos self-service flows.
 *
 * Spec unit: `flw`.
 *
 * Design invariants (aligned with `IdentityService` / `SessionService`):
 *   - Public surface leaks **zero** `@ory/*` types. This file does NOT
 *     import from `@ory/*` — the ESLint ban rule forbids it under
 *     `src/services/**`. All outward traffic is library DTOs produced by
 *     `flowMapper`.
 *   - Every `initiateX` calls the Kratos Frontend API (public product),
 *     never any admin API. The only dependency is
 *     `TenantClients.kratosFrontend`, which every tenant has.
 *   - Every `submitX` forwards the caller's `body` + `{ flow: flowId }`
 *     into the corresponding Kratos `updateXFlow` call. The response is
 *     either a `SuccessfulNativeLogin` / `SuccessfulNativeRegistration`
 *     (contains `session`) — mapped to `{ kind: 'success', sessionId }` —
 *     or another flow (mapped via `flowMapper`) returned as
 *     `{ kind: 'continue', flow }`. Recovery / settings / verification
 *     normally only return continue flows.
 *   - `fetchFlow(kind, flowId)` supports state retrieval across all five
 *     flow families via the matching `getXFlow`.
 *   - `.forTenant(name)` returns a stable, memoized instance per the
 *     standard pattern.
 *   - Upstream errors funnel through `ErrorMapper.toNest` so an Ory
 *     5xx / 401 / network timeout reaches the HTTP boundary as the right
 *     Nest exception.
 *
 * `as unknown as ...` escape hatches at the Kratos call sites are the
 * price of keeping `@ory/client` out of this file; the mapper layer
 * re-establishes type safety at the boundary.
 */
import { Inject, Injectable } from '@nestjs/common';

import { correlationStorage } from '../clients/correlation-storage';
import type { TenantClients } from '../clients';
import type {
  TenantName,
  IamLoginFlow,
  IamLogoutFlow,
  IamRecoveryFlow,
  IamRegistrationFlow,
  IamSettingsFlow,
  IamVerificationFlow,
} from '../dto';
import { flowMapper } from '../dto/mappers';
import { ErrorMapper } from '../errors';
import { TENANT_REGISTRY } from '../module/registry/tokens';
import type { TenantRegistry } from '../module/registry/tenant-registry.service';

/* ------------------------------------------------------------------ */
/* Result types                                                        */
/* ------------------------------------------------------------------ */

export type IamLoginResult =
  | { kind: 'success'; sessionId: string }
  | { kind: 'continue'; flow: IamLoginFlow };

export type IamRegistrationResult =
  | { kind: 'success'; sessionId: string }
  | { kind: 'continue'; flow: IamRegistrationFlow };

export type IamRecoveryResult = {
  kind: 'continue';
  flow: IamRecoveryFlow;
};

export type IamSettingsResult = {
  kind: 'continue';
  flow: IamSettingsFlow;
};

export type IamVerificationResult = {
  kind: 'continue';
  flow: IamVerificationFlow;
};

/** Set of flow families supported by `fetchFlow`. */
export type IamFlowKind =
  | 'login'
  | 'registration'
  | 'recovery'
  | 'settings'
  | 'verification';

/**
 * How the consumer wants Kratos to initiate a self-service flow.
 *
 * - `'browser'` (default, backwards-compatible): calls `createBrowser*Flow`.
 *   Kratos issues a CSRF-cookied flow intended for a real browser; the
 *   consumer must round-trip cookies between `initiate*` and `submit*`.
 * - `'native'`: calls `createNative*Flow`. No CSRF cookie, suitable for
 *   mobile clients, CLIs, and BFFs proxying non-browser traffic.
 *
 * See `docs/usage/self-service-flows.md` for guidance on picking between
 * browser and native transports.
 */
export type IamFlowInitiateKind = 'browser' | 'native';

/** Common options accepted by every `initiate*` method. */
export interface IamFlowInitiateOptions {
  /**
   * Kratos API flavour to call. Defaults to `'browser'` to preserve
   * pre-0.2.0 behaviour. Use `'native'` for mobile, curl, or any consumer
   * that cannot round-trip a CSRF cookie.
   */
  kind?: IamFlowInitiateKind;
  /** Forwarded to Kratos as `returnTo`. */
  returnTo?: string;
  /** Extra fields forwarded to the underlying Kratos call unchanged. */
  [extra: string]: unknown;
}

/** Discriminated union returned by `fetchFlow` — keyed by `kind`. */
export type IamAnyFlow =
  | IamLoginFlow
  | IamRegistrationFlow
  | IamRecoveryFlow
  | IamSettingsFlow
  | IamVerificationFlow;

/* ------------------------------------------------------------------ */
/* Service                                                             */
/* ------------------------------------------------------------------ */

@Injectable()
export class FlowService {
  private readonly byTenant = new Map<TenantName, FlowServiceFor>();

  constructor(
    @Inject(TENANT_REGISTRY) private readonly registry: TenantRegistry,
  ) {}

  /**
   * Memoized accessor: returns the same `FlowServiceFor` instance for a
   * given tenant across repeated calls.
   */
  public forTenant(name: TenantName): FlowServiceFor {
    let existing = this.byTenant.get(name);
    if (existing === undefined) {
      existing = new FlowServiceFor(name, this.registry);
      this.byTenant.set(name, existing);
    }
    return existing;
  }
}

/**
 * Tenant-scoped projection of `FlowService`. Every method resolves the
 * tenant's `kratosFrontend` on demand via the registry; the `TenantClients`
 * bundle guarantees this client is always present.
 */
export class FlowServiceFor {
  constructor(
    private readonly tenant: TenantName,
    private readonly registry: TenantRegistry,
  ) {}

  /* ---- login ---------------------------------------------------- */

  public async initiateLogin(
    opts?: IamFlowInitiateOptions,
  ): Promise<IamLoginFlow> {
    const api = this.frontendAny();
    const { kind, rest } = splitInitiateOpts(opts);
    try {
      const { data } =
        kind === 'native'
          ? await api.createNativeLoginFlow(rest)
          : await api.createBrowserLoginFlow(rest);
      return flowMapper.loginFromOry(
        data as Parameters<typeof flowMapper.loginFromOry>[0],
        this.tenant,
      );
    } catch (err) {
      throw ErrorMapper.toNest(err, {
        correlationId: this.currentCorrelationId(),
      });
    }
  }

  public async submitLogin(
    flowId: string,
    body: Record<string, unknown>,
  ): Promise<IamLoginResult> {
    const api = this.frontendAny();
    try {
      const { data } = await api.updateLoginFlow({
        flow: flowId,
        updateLoginFlowBody: body,
      });
      const success = extractSessionId(data);
      if (success !== null) {
        return { kind: 'success', sessionId: success };
      }
      const flow = flowMapper.loginFromOry(
        data as Parameters<typeof flowMapper.loginFromOry>[0],
        this.tenant,
      );
      return { kind: 'continue', flow };
    } catch (err) {
      const envelope = extractFlowEnvelopeFromError(err);
      if (envelope !== null) {
        return {
          kind: 'continue',
          flow: flowMapper.loginFromOry(
            envelope as Parameters<typeof flowMapper.loginFromOry>[0],
            this.tenant,
          ),
        };
      }
      throw ErrorMapper.toNest(err, {
        correlationId: this.currentCorrelationId(),
      });
    }
  }

  /* ---- registration --------------------------------------------- */

  public async initiateRegistration(
    opts?: IamFlowInitiateOptions,
  ): Promise<IamRegistrationFlow> {
    const api = this.frontendAny();
    const { kind, rest } = splitInitiateOpts(opts);
    try {
      const { data } =
        kind === 'native'
          ? await api.createNativeRegistrationFlow(rest)
          : await api.createBrowserRegistrationFlow(rest);
      return flowMapper.registrationFromOry(
        data as Parameters<typeof flowMapper.registrationFromOry>[0],
        this.tenant,
      );
    } catch (err) {
      throw ErrorMapper.toNest(err, {
        correlationId: this.currentCorrelationId(),
      });
    }
  }

  public async submitRegistration(
    flowId: string,
    body: Record<string, unknown>,
  ): Promise<IamRegistrationResult> {
    const api = this.frontendAny();
    try {
      const { data } = await api.updateRegistrationFlow({
        flow: flowId,
        updateRegistrationFlowBody: body,
      });
      const success = extractSessionId(data);
      if (success !== null) {
        return { kind: 'success', sessionId: success };
      }
      const flow = flowMapper.registrationFromOry(
        data as Parameters<typeof flowMapper.registrationFromOry>[0],
        this.tenant,
      );
      return { kind: 'continue', flow };
    } catch (err) {
      const envelope = extractFlowEnvelopeFromError(err);
      if (envelope !== null) {
        return {
          kind: 'continue',
          flow: flowMapper.registrationFromOry(
            envelope as Parameters<typeof flowMapper.registrationFromOry>[0],
            this.tenant,
          ),
        };
      }
      throw ErrorMapper.toNest(err, {
        correlationId: this.currentCorrelationId(),
      });
    }
  }

  /* ---- recovery ------------------------------------------------- */

  public async initiateRecovery(
    opts?: IamFlowInitiateOptions,
  ): Promise<IamRecoveryFlow> {
    const api = this.frontendAny();
    const { kind, rest } = splitInitiateOpts(opts);
    try {
      const { data } =
        kind === 'native'
          ? await api.createNativeRecoveryFlow(rest)
          : await api.createBrowserRecoveryFlow(rest);
      return flowMapper.recoveryFromOry(
        data as Parameters<typeof flowMapper.recoveryFromOry>[0],
        this.tenant,
      );
    } catch (err) {
      throw ErrorMapper.toNest(err, {
        correlationId: this.currentCorrelationId(),
      });
    }
  }

  public async submitRecovery(
    flowId: string,
    body: Record<string, unknown>,
  ): Promise<IamRecoveryResult> {
    const api = this.frontendAny();
    try {
      const { data } = await api.updateRecoveryFlow({
        flow: flowId,
        updateRecoveryFlowBody: body,
      });
      const flow = flowMapper.recoveryFromOry(
        data as Parameters<typeof flowMapper.recoveryFromOry>[0],
        this.tenant,
      );
      return { kind: 'continue', flow };
    } catch (err) {
      const envelope = extractFlowEnvelopeFromError(err);
      if (envelope !== null) {
        return {
          kind: 'continue',
          flow: flowMapper.recoveryFromOry(
            envelope as Parameters<typeof flowMapper.recoveryFromOry>[0],
            this.tenant,
          ),
        };
      }
      throw ErrorMapper.toNest(err, {
        correlationId: this.currentCorrelationId(),
      });
    }
  }

  /* ---- settings ------------------------------------------------- */

  public async initiateSettings(
    opts?: IamFlowInitiateOptions,
  ): Promise<IamSettingsFlow> {
    const api = this.frontendAny();
    const { kind, rest } = splitInitiateOpts(opts);
    try {
      const { data } =
        kind === 'native'
          ? await api.createNativeSettingsFlow(rest)
          : await api.createBrowserSettingsFlow(rest);
      return flowMapper.settingsFromOry(
        data as Parameters<typeof flowMapper.settingsFromOry>[0],
        this.tenant,
      );
    } catch (err) {
      throw ErrorMapper.toNest(err, {
        correlationId: this.currentCorrelationId(),
      });
    }
  }

  public async submitSettings(
    flowId: string,
    body: Record<string, unknown>,
  ): Promise<IamSettingsResult> {
    const api = this.frontendAny();
    try {
      const { data } = await api.updateSettingsFlow({
        flow: flowId,
        updateSettingsFlowBody: body,
      });
      const flow = flowMapper.settingsFromOry(
        data as Parameters<typeof flowMapper.settingsFromOry>[0],
        this.tenant,
      );
      return { kind: 'continue', flow };
    } catch (err) {
      throw ErrorMapper.toNest(err, {
        correlationId: this.currentCorrelationId(),
      });
    }
  }

  /* ---- verification --------------------------------------------- */

  public async initiateVerification(
    opts?: IamFlowInitiateOptions,
  ): Promise<IamVerificationFlow> {
    const api = this.frontendAny();
    const { kind, rest } = splitInitiateOpts(opts);
    try {
      const { data } =
        kind === 'native'
          ? await api.createNativeVerificationFlow(rest)
          : await api.createBrowserVerificationFlow(rest);
      return flowMapper.verificationFromOry(
        data as Parameters<typeof flowMapper.verificationFromOry>[0],
        this.tenant,
      );
    } catch (err) {
      throw ErrorMapper.toNest(err, {
        correlationId: this.currentCorrelationId(),
      });
    }
  }

  public async submitVerification(
    flowId: string,
    body: Record<string, unknown>,
  ): Promise<IamVerificationResult> {
    const api = this.frontendAny();
    try {
      const { data } = await api.updateVerificationFlow({
        flow: flowId,
        updateVerificationFlowBody: body,
      });
      const flow = flowMapper.verificationFromOry(
        data as Parameters<typeof flowMapper.verificationFromOry>[0],
        this.tenant,
      );
      return { kind: 'continue', flow };
    } catch (err) {
      const envelope = extractFlowEnvelopeFromError(err);
      if (envelope !== null) {
        return {
          kind: 'continue',
          flow: flowMapper.verificationFromOry(
            envelope as Parameters<typeof flowMapper.verificationFromOry>[0],
            this.tenant,
          ),
        };
      }
      throw ErrorMapper.toNest(err, {
        correlationId: this.currentCorrelationId(),
      });
    }
  }

  /* ---- logout --------------------------------------------------- */

  /**
   * Browser logout: Kratos returns a `{ logout_token, logout_url }` pair.
   * The consumer redirects the browser to `logout_url?token=<logout_token>`
   * (or submits the token with `updateLogoutFlow` on modern Kratos). The
   * request MUST carry the caller's session cookie — it's attached by the
   * caller at HTTP ingress and forwarded verbatim to Kratos via the shared
   * axios instance.
   *
   * `cookie` is the raw `Cookie` header to forward; typically
   * `req.headers.cookie` in the controller.
   */
  public async initiateBrowserLogout(cookie: string): Promise<IamLogoutFlow> {
    const api = this.frontendAny();
    try {
      const { data } = await api.createBrowserLogoutFlow({
        cookie,
      });
      return flowMapper.logoutFromOry(
        data as Parameters<typeof flowMapper.logoutFromOry>[0],
        this.tenant,
      );
    } catch (err) {
      throw ErrorMapper.toNest(err, {
        correlationId: this.currentCorrelationId(),
      });
    }
  }

  /**
   * Complete a browser logout flow by submitting the `logout_token`
   * previously obtained from `initiateBrowserLogout`. On success, Kratos
   * clears the session cookie; the caller should forward the `Set-Cookie`
   * header to the browser.
   */
  public async submitBrowserLogout(logoutToken: string): Promise<void> {
    const api = this.frontendAny();
    try {
      await api.updateLogoutFlow({ token: logoutToken });
    } catch (err) {
      throw ErrorMapper.toNest(err, {
        correlationId: this.currentCorrelationId(),
      });
    }
  }

  /**
   * Native logout: invalidates a session identified by its session token
   * (the token returned by `createNativeLoginFlow` / `updateLoginFlow`
   * success). No flow envelope; returns `void` on success.
   */
  public async performNativeLogout(sessionToken: string): Promise<void> {
    const api = this.frontendAny();
    try {
      await api.performNativeLogout({
        performNativeLogoutBody: { session_token: sessionToken },
      });
    } catch (err) {
      throw ErrorMapper.toNest(err, {
        correlationId: this.currentCorrelationId(),
      });
    }
  }

  /* ---- fetch ---------------------------------------------------- */

  public async fetchFlow(
    kind: IamFlowKind,
    flowId: string,
  ): Promise<IamAnyFlow> {
    const api = this.frontendAny();
    try {
      switch (kind) {
        case 'login': {
          const { data } = await api.getLoginFlow({ id: flowId });
          return flowMapper.loginFromOry(
            data as Parameters<typeof flowMapper.loginFromOry>[0],
            this.tenant,
          );
        }
        case 'registration': {
          const { data } = await api.getRegistrationFlow({ id: flowId });
          return flowMapper.registrationFromOry(
            data as Parameters<typeof flowMapper.registrationFromOry>[0],
            this.tenant,
          );
        }
        case 'recovery': {
          const { data } = await api.getRecoveryFlow({ id: flowId });
          return flowMapper.recoveryFromOry(
            data as Parameters<typeof flowMapper.recoveryFromOry>[0],
            this.tenant,
          );
        }
        case 'settings': {
          const { data } = await api.getSettingsFlow({ id: flowId });
          return flowMapper.settingsFromOry(
            data as Parameters<typeof flowMapper.settingsFromOry>[0],
            this.tenant,
          );
        }
        case 'verification': {
          const { data } = await api.getVerificationFlow({ id: flowId });
          return flowMapper.verificationFromOry(
            data as Parameters<typeof flowMapper.verificationFromOry>[0],
            this.tenant,
          );
        }
      }
    } catch (err) {
      throw ErrorMapper.toNest(err, {
        correlationId: this.currentCorrelationId(),
      });
    }
  }

  /* ---- internals ------------------------------------------------ */

  /**
   * Resolve the tenant's Kratos Frontend client and return it typed
   * structurally (no `@ory/client` reference in this file). The bundle
   * guarantees `kratosFrontend` is always present — every tenant has a
   * public Kratos URL.
   */
  private frontendAny(): FrontendLike {
    const clients: TenantClients = this.registry.get(this.tenant);
    return clients.kratosFrontend as unknown as FrontendLike;
  }

  private currentCorrelationId(): string | undefined {
    return correlationStorage.getStore()?.correlationId;
  }
}

/* ------------------------------------------------------------------ */
/* Structural types                                                    */
/* ------------------------------------------------------------------ */

/**
 * Structural subset of `FrontendApi` used by this file. Keeping the shape
 * inline (instead of `import type { FrontendApi } from '@ory/client'`)
 * satisfies the `src/services/**` ESLint ban while still giving us
 * autocomplete / type checks on the call sites.
 *
 * Every method signature below intentionally uses `any` for request &
 * response — the mapper layer is the single source of type truth for the
 * Kratos payload shape; at the service boundary we only care that the
 * method names match.
 */
interface FrontendLike {
  createBrowserLoginFlow(req?: unknown): Promise<{ data: unknown }>;
  createNativeLoginFlow(req?: unknown): Promise<{ data: unknown }>;
  updateLoginFlow(req: unknown): Promise<{ data: unknown }>;
  getLoginFlow(req: unknown): Promise<{ data: unknown }>;
  createBrowserRegistrationFlow(req?: unknown): Promise<{ data: unknown }>;
  createNativeRegistrationFlow(req?: unknown): Promise<{ data: unknown }>;
  updateRegistrationFlow(req: unknown): Promise<{ data: unknown }>;
  getRegistrationFlow(req: unknown): Promise<{ data: unknown }>;
  createBrowserRecoveryFlow(req?: unknown): Promise<{ data: unknown }>;
  createNativeRecoveryFlow(req?: unknown): Promise<{ data: unknown }>;
  updateRecoveryFlow(req: unknown): Promise<{ data: unknown }>;
  getRecoveryFlow(req: unknown): Promise<{ data: unknown }>;
  createBrowserSettingsFlow(req?: unknown): Promise<{ data: unknown }>;
  createNativeSettingsFlow(req?: unknown): Promise<{ data: unknown }>;
  updateSettingsFlow(req: unknown): Promise<{ data: unknown }>;
  getSettingsFlow(req: unknown): Promise<{ data: unknown }>;
  createBrowserVerificationFlow(req?: unknown): Promise<{ data: unknown }>;
  createNativeVerificationFlow(req?: unknown): Promise<{ data: unknown }>;
  updateVerificationFlow(req: unknown): Promise<{ data: unknown }>;
  getVerificationFlow(req: unknown): Promise<{ data: unknown }>;
  createBrowserLogoutFlow(req?: unknown): Promise<{ data: unknown }>;
  updateLogoutFlow(req: unknown): Promise<{ data: unknown }>;
  performNativeLogout(req: unknown): Promise<{ data: unknown }>;
}

/**
 * Peel the transport selector off the public options object before the
 * remainder is forwarded to Kratos verbatim. Keeps the Kratos call site a
 * single expression and avoids leaking our `kind` token into upstream.
 */
function splitInitiateOpts(
  opts: IamFlowInitiateOptions | undefined,
): { kind: IamFlowInitiateKind; rest: Record<string, unknown> } {
  if (opts === undefined || opts === null) {
    return { kind: 'browser', rest: {} };
  }
  const { kind = 'browser', ...rest } = opts;
  return { kind, rest };
}

/**
 * Extract a Kratos flow envelope from an Axios error thrown by
 * `updateXFlow`. Kratos v26+ returns HTTP 400 with the flow body for the
 * most common user-facing failure modes — wrong password, duplicate
 * email, unknown identifier — rather than the semantically-correct 422
 * older versions used. Consumers following the documented discriminated
 * union (`{ kind: 'continue', flow } | { kind: 'success', sessionId }`)
 * should see these surfaced as `continue` with `ui.messages[*].type =
 * 'error'` attached, not as a 500.
 *
 * The heuristic is tight: we require the status to be exactly 400, the
 * response body to be an object, and to carry both `id` (flow id) and
 * `ui` (UI envelope). Anything else — network error, 401, 410
 * flow-expired, 500 — falls through to `ErrorMapper.toNest`.
 */
function extractFlowEnvelopeFromError(err: unknown): unknown | null {
  if (!err || typeof err !== 'object') return null;
  const response = (err as { response?: { status?: number; data?: unknown } }).response;
  if (!response || response.status !== 400) return null;
  const data = response.data;
  if (!data || typeof data !== 'object') return null;
  const asObj = data as Record<string, unknown>;
  if (typeof asObj.id !== 'string' || asObj.id.length === 0) return null;
  if (!asObj.ui || typeof asObj.ui !== 'object') return null;
  return data;
}

/**
 * Heuristic: a submit response is a "success" iff it carries a `session`
 * (with an `id`) or a raw `session_token`. Otherwise the response is a
 * continuing flow. We return the session id — not the session itself —
 * because BFFs talk in session-ids; if they need the full `IamSession`
 * they ask `SessionService.whoami`.
 */
function extractSessionId(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;
  const session = obj.session as { id?: unknown } | undefined;
  if (session && typeof session === 'object') {
    const id = session.id;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  const token = obj.session_token;
  if (typeof token === 'string' && token.length > 0) return token;
  return null;
}
