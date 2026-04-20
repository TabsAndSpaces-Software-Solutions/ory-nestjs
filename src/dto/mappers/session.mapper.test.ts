/**
 * Unit tests for sessionMapper.
 */
import { sessionMapper } from './session.mapper';
import {
  activeOrySession,
  minimalOrySession,
  sessionWithMissingMethodEntries,
} from './__fixtures__/session.fixture';

describe('sessionMapper.fromOry', () => {
  it('maps an active session and stamps the tenant', () => {
    const dto = sessionMapper.fromOry(activeOrySession, 'tenant-a');
    expect(dto.id).toBe('sess-1');
    expect(dto.active).toBe(true);
    expect(dto.expiresAt).toBe('2030-01-01T00:00:00.000Z');
    expect(dto.authenticatedAt).toBe('2029-12-31T23:00:00.000Z');
    expect(dto.authenticationMethods).toEqual(['password', 'totp']);
    expect(dto.tenant).toBe('tenant-a');
  });

  it('always sanitizes the embedded identity (no traits)', () => {
    const dto = sessionMapper.fromOry(activeOrySession, 'tenant-a');
    expect(dto.identity.id).toBe('ory-id-1');
    expect(dto.identity as unknown as { traits?: unknown }).not.toHaveProperty('traits');
    expect(dto.identity.tenant).toBe('tenant-a');
  });

  it('defaults active to false when absent', () => {
    const dto = sessionMapper.fromOry(minimalOrySession, 'tenant-b');
    expect(dto.active).toBe(false);
  });

  it('defaults authenticationMethods to [] when absent', () => {
    const dto = sessionMapper.fromOry(minimalOrySession, 'tenant-b');
    expect(dto.authenticationMethods).toEqual([]);
  });

  it('defaults expiresAt / authenticatedAt to "" when absent', () => {
    const dto = sessionMapper.fromOry(minimalOrySession, 'tenant-b');
    expect(dto.expiresAt).toBe('');
    expect(dto.authenticatedAt).toBe('');
  });

  it('filters out authentication_methods entries without a method', () => {
    const dto = sessionMapper.fromOry(sessionWithMissingMethodEntries, 'tenant-c');
    expect(dto.authenticationMethods).toEqual(['password']);
  });

  it('returns a deeply frozen DTO', () => {
    const dto = sessionMapper.fromOry(activeOrySession, 'tenant-a');
    expect(Object.isFrozen(dto)).toBe(true);
    expect(Object.isFrozen(dto.identity)).toBe(true);
    expect(Object.isFrozen(dto.authenticationMethods)).toBe(true);
  });

  it('is pure — does not mutate the input', () => {
    const clone = JSON.parse(JSON.stringify(activeOrySession));
    sessionMapper.fromOry(activeOrySession, 'tenant-a');
    expect(activeOrySession).toEqual(clone);
  });

  it('synthesizes a placeholder identity when Ory omits identity', () => {
    const dto = sessionMapper.fromOry(minimalOrySession, 'tenant-b');
    // Consumers should never see `undefined` here — map to a sentinel identity
    // with empty fields to preserve the typed contract.
    expect(dto.identity).toBeDefined();
    expect(dto.identity.tenant).toBe('tenant-b');
  });
});
