/**
 * Unit tests for flowMapper.
 */
import { flowMapper } from './flow.mapper';
import {
  oryLoginFlow,
  oryLoginFlowMissingExpires,
  oryLoginFlowNoCsrf,
  oryRecoveryFlow,
  oryRegistrationFlow,
  orySettingsFlow,
  oryVerificationFlow,
} from './__fixtures__/flow.fixture';

describe('flowMapper.loginFromOry', () => {
  it('maps core fields and stamps the tenant', () => {
    const dto = flowMapper.loginFromOry(oryLoginFlow, 'tenant-a');
    expect(dto.id).toBe('login-1');
    expect(dto.expiresAt).toBe('2030-01-01T00:00:00.000Z');
    expect(dto.csrfToken).toBe('csrf-login');
    expect(dto.tenant).toBe('tenant-a');
  });

  it('passes ui.nodes and ui.messages through', () => {
    const dto = flowMapper.loginFromOry(oryLoginFlow, 'tenant-a');
    expect(Array.isArray(dto.ui.nodes)).toBe(true);
    expect(dto.ui.nodes.length).toBeGreaterThan(0);
    expect(Array.isArray(dto.ui.messages)).toBe(true);
    expect(dto.ui.messages.length).toBeGreaterThan(0);
  });

  it('defaults csrfToken to "" when absent and does not throw', () => {
    const dto = flowMapper.loginFromOry(oryLoginFlowNoCsrf, 'tenant-a');
    expect(dto.csrfToken).toBe('');
  });

  it('defaults expiresAt to "" when Ory omits it', () => {
    const dto = flowMapper.loginFromOry(oryLoginFlowMissingExpires, 'tenant-a');
    expect(dto.expiresAt).toBe('');
  });

  it('returns a deeply frozen DTO', () => {
    const dto = flowMapper.loginFromOry(oryLoginFlow, 'tenant-a');
    expect(Object.isFrozen(dto)).toBe(true);
    expect(Object.isFrozen(dto.ui)).toBe(true);
    expect(Object.isFrozen(dto.ui.nodes)).toBe(true);
    expect(Object.isFrozen(dto.ui.messages)).toBe(true);
  });

  it('is pure — does not mutate the input', () => {
    const clone = JSON.parse(JSON.stringify(oryLoginFlow));
    flowMapper.loginFromOry(oryLoginFlow, 'tenant-a');
    expect(oryLoginFlow).toEqual(clone);
  });
});

describe('flowMapper.{registration,recovery,settings,verification}FromOry', () => {
  it('maps the registration flow', () => {
    const dto = flowMapper.registrationFromOry(oryRegistrationFlow, 'tenant-b');
    expect(dto.id).toBe('reg-1');
    expect(dto.csrfToken).toBe('csrf-reg');
    expect(dto.tenant).toBe('tenant-b');
  });

  it('maps the recovery flow', () => {
    const dto = flowMapper.recoveryFromOry(oryRecoveryFlow, 'tenant-b');
    expect(dto.id).toBe('rec-1');
    expect(dto.csrfToken).toBe('csrf-rec');
  });

  it('maps the settings flow', () => {
    const dto = flowMapper.settingsFromOry(orySettingsFlow, 'tenant-b');
    expect(dto.id).toBe('set-1');
    expect(dto.csrfToken).toBe('csrf-set');
  });

  it('maps the verification flow', () => {
    const dto = flowMapper.verificationFromOry(oryVerificationFlow, 'tenant-b');
    expect(dto.id).toBe('ver-1');
    expect(dto.csrfToken).toBe('csrf-ver');
  });
});
