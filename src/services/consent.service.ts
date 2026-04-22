/**
 * `ConsentService` — tenant-scoped Hydra login/consent/logout mediation.
 *
 * Hydra's OAuth2 authorization flow delegates user authentication and
 * consent collection to an application (usually a BFF). The app is given
 * a `login_challenge` / `consent_challenge` query param and replies with
 * accept/reject decisions. This service wraps those admin endpoints.
 *
 * Typical wiring (BFF):
 *
 *   1. Hydra redirects browser → `/login?login_challenge=...`.
 *   2. BFF calls `getLoginRequest(challenge)` → user identity, requested scope.
 *   3. If user logged in, call `acceptLoginRequest(challenge, { subject, remember })`
 *      → returns `{ redirectTo }`. Redirect the browser there.
 *   4. Hydra redirects back → `/consent?consent_challenge=...`.
 *   5. BFF calls `getConsentRequest(challenge)` to render consent UI.
 *   6. `acceptConsentRequest(challenge, { grantScope, remember, session })`
 *      or `rejectConsentRequest(challenge, { error })`.
 *
 * Zero `@ory/*` imports here — structural access only.
 */
import { Inject, Injectable } from '@nestjs/common';

import { correlationStorage } from '../clients/correlation-storage';
import type { TenantClients } from '../clients';
import type {
  TenantName,
  IamConsentRequest,
  IamConsentRedirect,
  IamLoginRequest,
  IamLogoutRequest,
} from '../dto';
import { tokenMapper } from '../dto/mappers';
import { ErrorMapper, IamConfigurationError } from '../errors';
import { TENANT_REGISTRY } from '../module/registry/tokens';
import type { TenantRegistry } from '../module/registry/tenant-registry.service';

export interface IamAcceptLoginBody {
  readonly subject: string;
  readonly remember?: boolean;
  readonly rememberFor?: number;
  readonly acr?: string;
  readonly amr?: readonly string[];
  readonly context?: Record<string, unknown>;
}

export interface IamRejectBody {
  readonly error: string;
  readonly errorDescription?: string;
  readonly errorHint?: string;
  readonly statusCode?: number;
}

export interface IamAcceptConsentBody {
  readonly grantScope: readonly string[];
  readonly grantAccessTokenAudience?: readonly string[];
  readonly remember?: boolean;
  readonly rememberFor?: number;
  readonly session?: {
    readonly accessToken?: Record<string, unknown>;
    readonly idToken?: Record<string, unknown>;
  };
}

export interface ConsentServiceFor {
  getLoginRequest(challenge: string): Promise<IamLoginRequest>;
  acceptLoginRequest(
    challenge: string,
    body: IamAcceptLoginBody,
  ): Promise<IamConsentRedirect>;
  rejectLoginRequest(
    challenge: string,
    body: IamRejectBody,
  ): Promise<IamConsentRedirect>;
  getConsentRequest(challenge: string): Promise<IamConsentRequest>;
  acceptConsentRequest(
    challenge: string,
    body: IamAcceptConsentBody,
  ): Promise<IamConsentRedirect>;
  rejectConsentRequest(
    challenge: string,
    body: IamRejectBody,
  ): Promise<IamConsentRedirect>;
  getLogoutRequest(challenge: string): Promise<IamLogoutRequest>;
  acceptLogoutRequest(challenge: string): Promise<IamConsentRedirect>;
  rejectLogoutRequest(challenge: string): Promise<void>;
}

interface AdminLike {
  getOAuth2LoginRequest(req: unknown): Promise<{ data: unknown }>;
  acceptOAuth2LoginRequest(req: unknown): Promise<{ data: unknown }>;
  rejectOAuth2LoginRequest(req: unknown): Promise<{ data: unknown }>;
  getOAuth2ConsentRequest(req: unknown): Promise<{ data: unknown }>;
  acceptOAuth2ConsentRequest(req: unknown): Promise<{ data: unknown }>;
  rejectOAuth2ConsentRequest(req: unknown): Promise<{ data: unknown }>;
  getOAuth2LogoutRequest(req: unknown): Promise<{ data: unknown }>;
  acceptOAuth2LogoutRequest(req: unknown): Promise<{ data: unknown }>;
  rejectOAuth2LogoutRequest(req: unknown): Promise<{ data: unknown }>;
}

@Injectable()
export class ConsentService {
  private readonly byTenant = new Map<TenantName, ConsentServiceFor>();

  constructor(
    @Inject(TENANT_REGISTRY) private readonly registry: TenantRegistry,
  ) {}

  public forTenant(name: TenantName): ConsentServiceFor {
    const existing = this.byTenant.get(name);
    if (existing !== undefined) return existing;
    const registry = this.registry;
    const wrapper: ConsentServiceFor = {
      getLoginRequest: (c) => getLogin(registry, name, c),
      acceptLoginRequest: (c, b) => acceptLogin(registry, name, c, b),
      rejectLoginRequest: (c, b) => rejectLogin(registry, name, c, b),
      getConsentRequest: (c) => getConsent(registry, name, c),
      acceptConsentRequest: (c, b) => acceptConsent(registry, name, c, b),
      rejectConsentRequest: (c, b) => rejectConsent(registry, name, c, b),
      getLogoutRequest: (c) => getLogout(registry, name, c),
      acceptLogoutRequest: (c) => acceptLogout(registry, name, c),
      rejectLogoutRequest: (c) => rejectLogout(registry, name, c),
    };
    this.byTenant.set(name, wrapper);
    return wrapper;
  }
}

async function getLogin(
  reg: TenantRegistry,
  tenant: TenantName,
  challenge: string,
): Promise<IamLoginRequest> {
  const api = admin(reg, tenant);
  try {
    const { data } = await api.getOAuth2LoginRequest({ loginChallenge: challenge });
    return tokenMapper.loginRequestFromOry(
      data as Parameters<typeof tokenMapper.loginRequestFromOry>[0],
      tenant,
    );
  } catch (err) {
    throw ErrorMapper.toNest(err, { correlationId: corrId() });
  }
}

async function acceptLogin(
  reg: TenantRegistry,
  tenant: TenantName,
  challenge: string,
  body: IamAcceptLoginBody,
): Promise<IamConsentRedirect> {
  const api = admin(reg, tenant);
  try {
    const { data } = await api.acceptOAuth2LoginRequest({
      loginChallenge: challenge,
      acceptOAuth2LoginRequest: {
        subject: body.subject,
        remember: body.remember,
        remember_for: body.rememberFor,
        acr: body.acr,
        amr: body.amr ? [...body.amr] : undefined,
        context: body.context,
      },
    });
    return redirectOf(data);
  } catch (err) {
    throw ErrorMapper.toNest(err, { correlationId: corrId() });
  }
}

async function rejectLogin(
  reg: TenantRegistry,
  tenant: TenantName,
  challenge: string,
  body: IamRejectBody,
): Promise<IamConsentRedirect> {
  const api = admin(reg, tenant);
  try {
    const { data } = await api.rejectOAuth2LoginRequest({
      loginChallenge: challenge,
      rejectOAuth2Request: toRejectBody(body),
    });
    return redirectOf(data);
  } catch (err) {
    throw ErrorMapper.toNest(err, { correlationId: corrId() });
  }
}

async function getConsent(
  reg: TenantRegistry,
  tenant: TenantName,
  challenge: string,
): Promise<IamConsentRequest> {
  const api = admin(reg, tenant);
  try {
    const { data } = await api.getOAuth2ConsentRequest({
      consentChallenge: challenge,
    });
    return tokenMapper.consentRequestFromOry(
      data as Parameters<typeof tokenMapper.consentRequestFromOry>[0],
      tenant,
    );
  } catch (err) {
    throw ErrorMapper.toNest(err, { correlationId: corrId() });
  }
}

async function acceptConsent(
  reg: TenantRegistry,
  tenant: TenantName,
  challenge: string,
  body: IamAcceptConsentBody,
): Promise<IamConsentRedirect> {
  const api = admin(reg, tenant);
  try {
    const { data } = await api.acceptOAuth2ConsentRequest({
      consentChallenge: challenge,
      acceptOAuth2ConsentRequest: {
        grant_scope: [...body.grantScope],
        grant_access_token_audience: body.grantAccessTokenAudience
          ? [...body.grantAccessTokenAudience]
          : undefined,
        remember: body.remember,
        remember_for: body.rememberFor,
        session: body.session
          ? {
              access_token: body.session.accessToken,
              id_token: body.session.idToken,
            }
          : undefined,
      },
    });
    return redirectOf(data);
  } catch (err) {
    throw ErrorMapper.toNest(err, { correlationId: corrId() });
  }
}

async function rejectConsent(
  reg: TenantRegistry,
  tenant: TenantName,
  challenge: string,
  body: IamRejectBody,
): Promise<IamConsentRedirect> {
  const api = admin(reg, tenant);
  try {
    const { data } = await api.rejectOAuth2ConsentRequest({
      consentChallenge: challenge,
      rejectOAuth2Request: toRejectBody(body),
    });
    return redirectOf(data);
  } catch (err) {
    throw ErrorMapper.toNest(err, { correlationId: corrId() });
  }
}

async function getLogout(
  reg: TenantRegistry,
  tenant: TenantName,
  challenge: string,
): Promise<IamLogoutRequest> {
  const api = admin(reg, tenant);
  try {
    const { data } = await api.getOAuth2LogoutRequest({
      logoutChallenge: challenge,
    });
    return tokenMapper.logoutRequestFromOry(
      data as Parameters<typeof tokenMapper.logoutRequestFromOry>[0],
      tenant,
    );
  } catch (err) {
    throw ErrorMapper.toNest(err, { correlationId: corrId() });
  }
}

async function acceptLogout(
  reg: TenantRegistry,
  tenant: TenantName,
  challenge: string,
): Promise<IamConsentRedirect> {
  const api = admin(reg, tenant);
  try {
    const { data } = await api.acceptOAuth2LogoutRequest({
      logoutChallenge: challenge,
    });
    return redirectOf(data);
  } catch (err) {
    throw ErrorMapper.toNest(err, { correlationId: corrId() });
  }
}

async function rejectLogout(
  reg: TenantRegistry,
  tenant: TenantName,
  challenge: string,
): Promise<void> {
  const api = admin(reg, tenant);
  try {
    await api.rejectOAuth2LogoutRequest({ logoutChallenge: challenge });
  } catch (err) {
    throw ErrorMapper.toNest(err, { correlationId: corrId() });
  }
}

function redirectOf(data: unknown): IamConsentRedirect {
  const asObj = (data ?? {}) as { redirect_to?: unknown };
  return {
    redirectTo: typeof asObj.redirect_to === 'string' ? asObj.redirect_to : '',
  };
}

function toRejectBody(body: IamRejectBody): Record<string, unknown> {
  const out: Record<string, unknown> = { error: body.error };
  if (body.errorDescription !== undefined)
    out.error_description = body.errorDescription;
  if (body.errorHint !== undefined) out.error_hint = body.errorHint;
  if (body.statusCode !== undefined) out.status_code = body.statusCode;
  return out;
}

function admin(reg: TenantRegistry, tenant: TenantName): AdminLike {
  const clients: TenantClients = reg.get(tenant);
  if (!clients.hydraOauth2) {
    throw new IamConfigurationError({
      message: `Hydra admin OAuth2 client not configured for tenant '${tenant}'`,
    });
  }
  return clients.hydraOauth2 as unknown as AdminLike;
}

function corrId(): string | undefined {
  return correlationStorage.getStore()?.correlationId;
}
