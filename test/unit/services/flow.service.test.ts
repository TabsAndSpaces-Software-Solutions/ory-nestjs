/**
 * Unit tests for `FlowService` (spec unit `flw`).
 *
 * The service proxies Kratos self-service flows (login / registration /
 * recovery / settings / verification) through library DTOs so BFF callers
 * never touch `@ory/client` shapes. It exposes a memoized
 * `.forTenant(name)` accessor per the standard pattern used by
 * `IdentityService` / `SessionService`.
 *
 * Test strategy
 *   - Stub `TenantRegistry` with a Map-backed implementation.
 *   - Fake `TenantClients.kratosFrontend` with Jest-spy functions for each
 *     of the five flow families (create / update / get).
 *   - For each flow family assert:
 *       1) initiate happy path  -> returns a mapped IamXFlow DTO
 *          carrying id, ui, csrfToken, tenant, expiresAt.
 *       2) initiate upstream error -> funneled through ErrorMapper.
 *       3) submit that returns a flow -> { kind: 'continue', flow }.
 *       4) submit that returns a session (login/registration only) ->
 *          { kind: 'success', sessionId }.
 *   - `.fetchFlow(kind, flowId)` delegates to the right getXFlow.
 */
import 'reflect-metadata';
import { ServiceUnavailableException } from '@nestjs/common';

import { FlowService } from '../../../src/services/flow.service';
import type { TenantClients } from '../../../src/clients';
import type { TenantName } from '../../../src/dto';
import type { TenantRegistry } from '../../../src/module/registry/tenant-registry.service';
import { IamConfigurationError } from '../../../src/errors';

/* ------------------------------------------------------------------ */
/* Stubs & helpers                                                     */
/* ------------------------------------------------------------------ */

interface SpyFrontendApi {
  createBrowserLoginFlow: jest.Mock;
  createNativeLoginFlow: jest.Mock;
  updateLoginFlow: jest.Mock;
  getLoginFlow: jest.Mock;
  createBrowserRegistrationFlow: jest.Mock;
  createNativeRegistrationFlow: jest.Mock;
  updateRegistrationFlow: jest.Mock;
  getRegistrationFlow: jest.Mock;
  createBrowserRecoveryFlow: jest.Mock;
  createNativeRecoveryFlow: jest.Mock;
  updateRecoveryFlow: jest.Mock;
  getRecoveryFlow: jest.Mock;
  createBrowserSettingsFlow: jest.Mock;
  createNativeSettingsFlow: jest.Mock;
  updateSettingsFlow: jest.Mock;
  getSettingsFlow: jest.Mock;
  createBrowserVerificationFlow: jest.Mock;
  createNativeVerificationFlow: jest.Mock;
  updateVerificationFlow: jest.Mock;
  getVerificationFlow: jest.Mock;
}

function makeSpyFrontend(): SpyFrontendApi {
  return {
    createBrowserLoginFlow: jest.fn(),
    createNativeLoginFlow: jest.fn(),
    updateLoginFlow: jest.fn(),
    getLoginFlow: jest.fn(),
    createBrowserRegistrationFlow: jest.fn(),
    createNativeRegistrationFlow: jest.fn(),
    updateRegistrationFlow: jest.fn(),
    getRegistrationFlow: jest.fn(),
    createBrowserRecoveryFlow: jest.fn(),
    createNativeRecoveryFlow: jest.fn(),
    updateRecoveryFlow: jest.fn(),
    getRecoveryFlow: jest.fn(),
    createBrowserSettingsFlow: jest.fn(),
    createNativeSettingsFlow: jest.fn(),
    updateSettingsFlow: jest.fn(),
    getSettingsFlow: jest.fn(),
    createBrowserVerificationFlow: jest.fn(),
    createNativeVerificationFlow: jest.fn(),
    updateVerificationFlow: jest.fn(),
    getVerificationFlow: jest.fn(),
  };
}

function makeClients(opts: {
  tenant: TenantName;
  frontend?: SpyFrontendApi;
}): TenantClients {
  return {
    tenant: opts.tenant,
    config: {} as TenantClients['config'],
    axios: {} as TenantClients['axios'],
    kratosFrontend: (opts.frontend ??
      makeSpyFrontend()) as unknown as TenantClients['kratosFrontend'],
  };
}

function makeRegistry(
  byTenant: Record<TenantName, TenantClients>,
): TenantRegistry {
  const get = (name: TenantName): TenantClients => {
    const clients = byTenant[name];
    if (!clients) {
      throw new IamConfigurationError({
        message: `unknown tenant: ${name}`,
      });
    }
    return clients;
  };
  const tryGet = (name: TenantName): TenantClients | undefined =>
    byTenant[name];
  return {
    get,
    tryGet,
    defaultTenant: () => undefined,
    list: () => Object.keys(byTenant),
  } as unknown as TenantRegistry;
}

/** Build a minimal Ory-shaped flow payload that the mapper can process. */
function buildOryFlow(overrides?: {
  id?: string;
  csrf?: string;
  expiresAt?: string;
}) {
  return {
    id: overrides?.id ?? 'flow-1',
    expires_at: overrides?.expiresAt ?? '2030-01-01T00:00:00.000Z',
    issued_at: '2030-01-01T00:00:00.000Z',
    request_url: 'http://example.test/',
    state: 'choose_method',
    ui: {
      action: 'http://example.test/submit',
      method: 'POST',
      nodes: [
        {
          type: 'input',
          group: 'default',
          attributes: {
            name: 'csrf_token',
            node_type: 'input',
            type: 'hidden',
            value: overrides?.csrf ?? 'csrf-token-value',
            disabled: false,
          },
          messages: [],
          meta: {},
        },
      ],
      messages: [],
    },
  };
}

function axiosErr(status: number): unknown {
  return {
    isAxiosError: true,
    response: { status, data: { error: 'x' } },
    message: `Request failed with status code ${status}`,
  };
}

/* ------------------------------------------------------------------ */
/* Tests                                                              */
/* ------------------------------------------------------------------ */

describe('FlowService', () => {
  /* ---------- memoization ----------------------------------------- */
  describe('.forTenant() memoization', () => {
    it('returns the same instance for the same tenant across calls', () => {
      const frontend = makeSpyFrontend();
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', frontend }),
      });
      const service = new FlowService(registry);
      const a = service.forTenant('customer');
      const b = service.forTenant('customer');
      expect(a).toBe(b);
    });

    it('returns different instances for different tenants', () => {
      const registry = makeRegistry({
        customer: makeClients({
          tenant: 'customer',
          frontend: makeSpyFrontend(),
        }),
        admin: makeClients({
          tenant: 'admin',
          frontend: makeSpyFrontend(),
        }),
      });
      const service = new FlowService(registry);
      expect(service.forTenant('customer')).not.toBe(
        service.forTenant('admin'),
      );
    });
  });

  /* ---------- login flow ------------------------------------------ */
  describe('login flow', () => {
    it('initiateLogin happy path returns IamLoginFlow with id/ui/csrf/expiresAt', async () => {
      const frontend = makeSpyFrontend();
      frontend.createBrowserLoginFlow.mockResolvedValue({
        data: buildOryFlow({ id: 'login-1', csrf: 'csrf-login' }),
      });
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', frontend }),
      });
      const service = new FlowService(registry);

      const flow = await service
        .forTenant('customer')
        .initiateLogin({ refresh: false });

      expect(frontend.createBrowserLoginFlow).toHaveBeenCalledTimes(1);
      expect(flow.id).toBe('login-1');
      expect(flow.csrfToken).toBe('csrf-login');
      expect(flow.expiresAt).toBe('2030-01-01T00:00:00.000Z');
      expect(flow.tenant).toBe('customer');
      expect(Array.isArray(flow.ui.nodes)).toBe(true);
      expect(flow.ui.nodes.length).toBeGreaterThan(0);
    });

    it('initiateLogin maps 5xx through ErrorMapper to ServiceUnavailableException', async () => {
      const frontend = makeSpyFrontend();
      frontend.createBrowserLoginFlow.mockRejectedValue(axiosErr(503));
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', frontend }),
      });
      const service = new FlowService(registry);
      await expect(
        service.forTenant('customer').initiateLogin({}),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it('initiateLogin with kind:native routes to createNativeLoginFlow and strips the kind option', async () => {
      // Added for the 0.2.0 browser/native split — a BFF proxying mobile
      // or curl traffic cannot round-trip the CSRF cookie that browser
      // flows require. Passing `kind: 'native'` must call the Native API
      // and must NOT forward `kind` as an upstream parameter.
      const frontend = makeSpyFrontend();
      frontend.createNativeLoginFlow.mockResolvedValue({
        data: buildOryFlow({ id: 'login-native', csrf: 'csrf-login' }),
      });
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', frontend }),
      });
      const service = new FlowService(registry);

      const flow = await service
        .forTenant('customer')
        .initiateLogin({ kind: 'native', returnTo: '/after' });

      expect(frontend.createNativeLoginFlow).toHaveBeenCalledTimes(1);
      expect(frontend.createBrowserLoginFlow).not.toHaveBeenCalled();
      // The Kratos call must NOT see our internal `kind` discriminator.
      const forwarded = frontend.createNativeLoginFlow.mock.calls[0][0];
      expect(forwarded).toEqual({ returnTo: '/after' });
      expect(flow.id).toBe('login-native');
    });

    it('initiateLogin without opts (or without kind) defaults to the Browser API for backwards compat', async () => {
      const frontend = makeSpyFrontend();
      frontend.createBrowserLoginFlow.mockResolvedValue({
        data: buildOryFlow({ id: 'login-default', csrf: 'csrf' }),
      });
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', frontend }),
      });
      const service = new FlowService(registry);

      await service.forTenant('customer').initiateLogin();
      expect(frontend.createBrowserLoginFlow).toHaveBeenCalledTimes(1);
      expect(frontend.createNativeLoginFlow).not.toHaveBeenCalled();
    });

    it('submitLogin that returns a session maps to { kind: "success", sessionId }', async () => {
      const frontend = makeSpyFrontend();
      frontend.updateLoginFlow.mockResolvedValue({
        data: { session: { id: 'sess-42' } },
      });
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', frontend }),
      });
      const service = new FlowService(registry);

      const result = await service
        .forTenant('customer')
        .submitLogin('login-1', { method: 'password', password: 'secret' });

      expect(result).toEqual({ kind: 'success', sessionId: 'sess-42' });
      expect(frontend.updateLoginFlow).toHaveBeenCalledTimes(1);
      const arg = frontend.updateLoginFlow.mock.calls[0][0];
      expect(arg.flow).toBe('login-1');
    });

    it('submitLogin that returns another flow maps to { kind: "continue", flow }', async () => {
      const frontend = makeSpyFrontend();
      frontend.updateLoginFlow.mockResolvedValue({
        data: buildOryFlow({ id: 'login-1', csrf: 'csrf-login-2' }),
      });
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', frontend }),
      });
      const service = new FlowService(registry);

      const result = await service
        .forTenant('customer')
        .submitLogin('login-1', { method: 'password' });

      expect(result.kind).toBe('continue');
      if (result.kind === 'continue') {
        expect(result.flow.id).toBe('login-1');
        expect(result.flow.csrfToken).toBe('csrf-login-2');
        expect(result.flow.tenant).toBe('customer');
      }
    });

    it('submitLogin upstream 5xx is mapped to ServiceUnavailableException', async () => {
      const frontend = makeSpyFrontend();
      frontend.updateLoginFlow.mockRejectedValue(axiosErr(500));
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', frontend }),
      });
      const service = new FlowService(registry);
      await expect(
        service.forTenant('customer').submitLogin('login-1', {}),
      ).rejects.toThrow(ServiceUnavailableException);
    });
  });

  /* ---------- registration flow ----------------------------------- */
  describe('registration flow', () => {
    it('initiateRegistration happy path returns IamRegistrationFlow', async () => {
      const frontend = makeSpyFrontend();
      frontend.createBrowserRegistrationFlow.mockResolvedValue({
        data: buildOryFlow({ id: 'reg-1', csrf: 'csrf-reg' }),
      });
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', frontend }),
      });
      const service = new FlowService(registry);

      const flow = await service.forTenant('customer').initiateRegistration({});

      expect(flow.id).toBe('reg-1');
      expect(flow.csrfToken).toBe('csrf-reg');
      expect(flow.tenant).toBe('customer');
    });

    it('initiateRegistration 5xx maps to ServiceUnavailableException', async () => {
      const frontend = makeSpyFrontend();
      frontend.createBrowserRegistrationFlow.mockRejectedValue(axiosErr(500));
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', frontend }),
      });
      const service = new FlowService(registry);
      await expect(
        service.forTenant('customer').initiateRegistration({}),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it('submitRegistration success (session present) returns success result', async () => {
      const frontend = makeSpyFrontend();
      frontend.updateRegistrationFlow.mockResolvedValue({
        data: { session: { id: 'sess-reg' }, identity: { id: 'id-1' } },
      });
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', frontend }),
      });
      const service = new FlowService(registry);

      const result = await service
        .forTenant('customer')
        .submitRegistration('reg-1', {
          method: 'password',
          traits: { email: 'a@b.test' },
          password: 'secret',
        });

      expect(result).toEqual({ kind: 'success', sessionId: 'sess-reg' });
    });

    it('submitRegistration continue returns next flow', async () => {
      const frontend = makeSpyFrontend();
      frontend.updateRegistrationFlow.mockResolvedValue({
        data: buildOryFlow({ id: 'reg-1', csrf: 'csrf-reg-2' }),
      });
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', frontend }),
      });
      const service = new FlowService(registry);

      const result = await service
        .forTenant('customer')
        .submitRegistration('reg-1', {});

      expect(result.kind).toBe('continue');
      if (result.kind === 'continue') {
        expect(result.flow.id).toBe('reg-1');
      }
    });
  });

  /* ---------- recovery flow --------------------------------------- */
  describe('recovery flow', () => {
    it('initiateRecovery happy path', async () => {
      const frontend = makeSpyFrontend();
      frontend.createBrowserRecoveryFlow.mockResolvedValue({
        data: buildOryFlow({ id: 'rec-1', csrf: 'csrf-rec' }),
      });
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', frontend }),
      });
      const service = new FlowService(registry);
      const flow = await service.forTenant('customer').initiateRecovery({});
      expect(flow.id).toBe('rec-1');
      expect(flow.csrfToken).toBe('csrf-rec');
    });

    it('initiateRecovery 5xx maps to ServiceUnavailableException', async () => {
      const frontend = makeSpyFrontend();
      frontend.createBrowserRecoveryFlow.mockRejectedValue(axiosErr(502));
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', frontend }),
      });
      const service = new FlowService(registry);
      await expect(
        service.forTenant('customer').initiateRecovery({}),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it('submitRecovery returns a continue result with the next flow', async () => {
      const frontend = makeSpyFrontend();
      frontend.updateRecoveryFlow.mockResolvedValue({
        data: buildOryFlow({ id: 'rec-1', csrf: 'csrf-rec-2' }),
      });
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', frontend }),
      });
      const service = new FlowService(registry);
      const result = await service
        .forTenant('customer')
        .submitRecovery('rec-1', { email: 'a@b.test', method: 'link' });
      expect(result.kind).toBe('continue');
      if (result.kind === 'continue') {
        expect(result.flow.id).toBe('rec-1');
      }
    });
  });

  /* ---------- settings flow --------------------------------------- */
  describe('settings flow', () => {
    it('initiateSettings happy path', async () => {
      const frontend = makeSpyFrontend();
      frontend.createBrowserSettingsFlow.mockResolvedValue({
        data: buildOryFlow({ id: 'set-1', csrf: 'csrf-set' }),
      });
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', frontend }),
      });
      const service = new FlowService(registry);
      const flow = await service.forTenant('customer').initiateSettings({});
      expect(flow.id).toBe('set-1');
      expect(flow.csrfToken).toBe('csrf-set');
    });

    it('initiateSettings 5xx maps to ServiceUnavailableException', async () => {
      const frontend = makeSpyFrontend();
      frontend.createBrowserSettingsFlow.mockRejectedValue(axiosErr(500));
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', frontend }),
      });
      const service = new FlowService(registry);
      await expect(
        service.forTenant('customer').initiateSettings({}),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it('submitSettings returns a continue result', async () => {
      const frontend = makeSpyFrontend();
      frontend.updateSettingsFlow.mockResolvedValue({
        data: buildOryFlow({ id: 'set-1', csrf: 'csrf-set-2' }),
      });
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', frontend }),
      });
      const service = new FlowService(registry);
      const result = await service
        .forTenant('customer')
        .submitSettings('set-1', { method: 'profile' });
      expect(result.kind).toBe('continue');
      if (result.kind === 'continue') {
        expect(result.flow.id).toBe('set-1');
      }
    });
  });

  /* ---------- verification flow ----------------------------------- */
  describe('verification flow', () => {
    it('initiateVerification happy path', async () => {
      const frontend = makeSpyFrontend();
      frontend.createBrowserVerificationFlow.mockResolvedValue({
        data: buildOryFlow({ id: 'ver-1', csrf: 'csrf-ver' }),
      });
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', frontend }),
      });
      const service = new FlowService(registry);
      const flow = await service.forTenant('customer').initiateVerification({});
      expect(flow.id).toBe('ver-1');
      expect(flow.csrfToken).toBe('csrf-ver');
    });

    it('initiateVerification 5xx maps to ServiceUnavailableException', async () => {
      const frontend = makeSpyFrontend();
      frontend.createBrowserVerificationFlow.mockRejectedValue(axiosErr(500));
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', frontend }),
      });
      const service = new FlowService(registry);
      await expect(
        service.forTenant('customer').initiateVerification({}),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it('submitVerification returns a continue result', async () => {
      const frontend = makeSpyFrontend();
      frontend.updateVerificationFlow.mockResolvedValue({
        data: buildOryFlow({ id: 'ver-1', csrf: 'csrf-ver-2' }),
      });
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', frontend }),
      });
      const service = new FlowService(registry);
      const result = await service
        .forTenant('customer')
        .submitVerification('ver-1', { method: 'link' });
      expect(result.kind).toBe('continue');
      if (result.kind === 'continue') {
        expect(result.flow.id).toBe('ver-1');
      }
    });
  });

  /* ---------- fetchFlow ------------------------------------------- */
  describe('.fetchFlow(kind, flowId)', () => {
    it('delegates login to getLoginFlow and maps the result', async () => {
      const frontend = makeSpyFrontend();
      frontend.getLoginFlow.mockResolvedValue({
        data: buildOryFlow({ id: 'login-1', csrf: 'csrf-login' }),
      });
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', frontend }),
      });
      const service = new FlowService(registry);
      const flow = await service
        .forTenant('customer')
        .fetchFlow('login', 'login-1');
      expect(frontend.getLoginFlow).toHaveBeenCalledWith({ id: 'login-1' });
      expect(flow.id).toBe('login-1');
      expect(flow.csrfToken).toBe('csrf-login');
    });

    it('delegates registration to getRegistrationFlow', async () => {
      const frontend = makeSpyFrontend();
      frontend.getRegistrationFlow.mockResolvedValue({
        data: buildOryFlow({ id: 'reg-1' }),
      });
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', frontend }),
      });
      const service = new FlowService(registry);
      const flow = await service
        .forTenant('customer')
        .fetchFlow('registration', 'reg-1');
      expect(frontend.getRegistrationFlow).toHaveBeenCalledWith({
        id: 'reg-1',
      });
      expect(flow.id).toBe('reg-1');
    });

    it('delegates recovery to getRecoveryFlow', async () => {
      const frontend = makeSpyFrontend();
      frontend.getRecoveryFlow.mockResolvedValue({
        data: buildOryFlow({ id: 'rec-1' }),
      });
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', frontend }),
      });
      const service = new FlowService(registry);
      const flow = await service
        .forTenant('customer')
        .fetchFlow('recovery', 'rec-1');
      expect(frontend.getRecoveryFlow).toHaveBeenCalledWith({ id: 'rec-1' });
      expect(flow.id).toBe('rec-1');
    });

    it('delegates settings to getSettingsFlow', async () => {
      const frontend = makeSpyFrontend();
      frontend.getSettingsFlow.mockResolvedValue({
        data: buildOryFlow({ id: 'set-1' }),
      });
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', frontend }),
      });
      const service = new FlowService(registry);
      const flow = await service
        .forTenant('customer')
        .fetchFlow('settings', 'set-1');
      expect(frontend.getSettingsFlow).toHaveBeenCalledWith({ id: 'set-1' });
      expect(flow.id).toBe('set-1');
    });

    it('delegates verification to getVerificationFlow', async () => {
      const frontend = makeSpyFrontend();
      frontend.getVerificationFlow.mockResolvedValue({
        data: buildOryFlow({ id: 'ver-1' }),
      });
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', frontend }),
      });
      const service = new FlowService(registry);
      const flow = await service
        .forTenant('customer')
        .fetchFlow('verification', 'ver-1');
      expect(frontend.getVerificationFlow).toHaveBeenCalledWith({
        id: 'ver-1',
      });
      expect(flow.id).toBe('ver-1');
    });

    it('fetchFlow upstream 5xx surfaces as ServiceUnavailableException', async () => {
      const frontend = makeSpyFrontend();
      frontend.getLoginFlow.mockRejectedValue(axiosErr(500));
      const registry = makeRegistry({
        customer: makeClients({ tenant: 'customer', frontend }),
      });
      const service = new FlowService(registry);
      await expect(
        service.forTenant('customer').fetchFlow('login', 'login-1'),
      ).rejects.toThrow(ServiceUnavailableException);
    });
  });
});
