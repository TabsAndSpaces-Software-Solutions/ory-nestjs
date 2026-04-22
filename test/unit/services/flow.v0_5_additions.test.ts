/**
 * Coverage for v0.5.0 FlowService additions: browser + native logout.
 */
import 'reflect-metadata';
import { ServiceUnavailableException } from '@nestjs/common';

import { FlowService } from '../../../src/services/flow.service';
import type { TenantClients } from '../../../src/clients';
import { makeAuditSpy, makeClients, makeRegistry, oryError } from './_helpers';

describe('FlowService v0.5.0 additions', () => {
  const frontend = {
    createBrowserLogoutFlow: jest.fn(),
    updateLogoutFlow: jest.fn(),
    performNativeLogout: jest.fn(),
    // Stubs for other flow methods (not exercised here) so type-struct matches.
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
  const registry = makeRegistry({
    default: makeClients({
      tenant: 'default',
      kratosFrontend: frontend as unknown as TenantClients['kratosFrontend'],
    }),
  });
  const audit = makeAuditSpy();
  const svc = new FlowService(registry, audit);

  beforeEach(() => {
    Object.values(frontend).forEach((m) => m.mockReset());
    audit.events.length = 0;
  });

  it('initiateBrowserLogout() maps the envelope', async () => {
    frontend.createBrowserLogoutFlow.mockResolvedValue({
      data: {
        logout_token: 'lt',
        logout_url: 'https://kratos/logout',
      },
    });
    const out = await svc
      .forTenant('default')
      .initiateBrowserLogout('ory_kratos_session=…');
    expect(out.logoutToken).toBe('lt');
    expect(out.logoutUrl).toBe('https://kratos/logout');
  });

  it('submitBrowserLogout() emits iam.flow.logout.browser', async () => {
    frontend.updateLogoutFlow.mockResolvedValue({ data: null });
    await svc.forTenant('default').submitBrowserLogout('lt');
    expect(audit.events.map((e) => e.event)).toContain(
      'iam.flow.logout.browser',
    );
  });

  it('performNativeLogout() emits iam.flow.logout.native', async () => {
    frontend.performNativeLogout.mockResolvedValue({ data: null });
    await svc.forTenant('default').performNativeLogout('ory_st_…');
    expect(audit.events.map((e) => e.event)).toContain(
      'iam.flow.logout.native',
    );
  });

  it('submitBrowserLogout() maps upstream 503', async () => {
    frontend.updateLogoutFlow.mockRejectedValue(oryError(503));
    await expect(
      svc.forTenant('default').submitBrowserLogout('lt'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
