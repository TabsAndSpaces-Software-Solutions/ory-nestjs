/**
 * Unit tests for tokenMapper.
 */
import { tokenMapper } from './token.mapper';
import {
  oryIntrospectionActive,
  oryIntrospectionInactive,
  oryTokenExchange,
  oryTokenExchangeNoScope,
} from './__fixtures__/token.fixture';

describe('tokenMapper.fromOryTokenExchange', () => {
  it('maps a token-exchange response and stamps the tenant', () => {
    const dto = tokenMapper.fromOryTokenExchange(oryTokenExchange, 'tenant-a');
    expect(dto).toEqual({
      accessToken: 'tok-abc',
      tokenType: 'Bearer',
      expiresIn: 3600,
      scope: ['read', 'write'],
      tenant: 'tenant-a',
    });
  });

  it('normalises tokenType to "Bearer" regardless of Ory casing', () => {
    const dto1 = tokenMapper.fromOryTokenExchange(oryTokenExchange, 'tenant-a');
    expect(dto1.tokenType).toBe('Bearer');
    const dto2 = tokenMapper.fromOryTokenExchange(oryTokenExchangeNoScope, 'tenant-a');
    expect(dto2.tokenType).toBe('Bearer');
  });

  it('defaults expiresIn to 0 and scope to [] when absent', () => {
    const dto = tokenMapper.fromOryTokenExchange(oryTokenExchangeNoScope, 'tenant-a');
    expect(dto.expiresIn).toBe(60);
    expect(dto.scope).toEqual([]);
  });

  it('defaults accessToken to "" when absent', () => {
    const dto = tokenMapper.fromOryTokenExchange({}, 'tenant-a');
    expect(dto.accessToken).toBe('');
  });

  it('returns a deeply frozen DTO', () => {
    const dto = tokenMapper.fromOryTokenExchange(oryTokenExchange, 'tenant-a');
    expect(Object.isFrozen(dto)).toBe(true);
    expect(Object.isFrozen(dto.scope)).toBe(true);
  });
});

describe('tokenMapper.fromOryIntrospection', () => {
  it('maps an active introspection and stamps the tenant', () => {
    const dto = tokenMapper.fromOryIntrospection(oryIntrospectionActive, 'tenant-a');
    expect(dto).toEqual({
      active: true,
      subject: 'user:alice',
      clientId: 'client-1',
      scope: ['read', 'write', 'admin'],
      exp: 1_700_000_000,
      iat: 1_600_000_000,
      tenant: 'tenant-a',
    });
  });

  it('maps an inactive introspection', () => {
    const dto = tokenMapper.fromOryIntrospection(oryIntrospectionInactive, 'tenant-b');
    expect(dto.active).toBe(false);
    expect(dto).not.toHaveProperty('subject');
    expect(dto).not.toHaveProperty('clientId');
    expect(dto).not.toHaveProperty('scope');
    expect(dto).not.toHaveProperty('exp');
    expect(dto).not.toHaveProperty('iat');
    expect(dto.tenant).toBe('tenant-b');
  });

  it('returns a deeply frozen DTO', () => {
    const dto = tokenMapper.fromOryIntrospection(oryIntrospectionActive, 'tenant-a');
    expect(Object.isFrozen(dto)).toBe(true);
    if (dto.scope) {
      expect(Object.isFrozen(dto.scope)).toBe(true);
    }
  });

  it('is pure — does not mutate the input', () => {
    const clone = JSON.parse(JSON.stringify(oryIntrospectionActive));
    tokenMapper.fromOryIntrospection(oryIntrospectionActive, 'tenant-a');
    expect(oryIntrospectionActive).toEqual(clone);
  });
});

describe('tokenMapper.machineFromOryIntrospection', () => {
  it('builds a IamMachinePrincipal when active and client_id is present', () => {
    const principal = tokenMapper.machineFromOryIntrospection(
      oryIntrospectionActive,
      'tenant-a',
    );
    expect(principal).not.toBeNull();
    expect(principal).toEqual({
      kind: 'machine',
      clientId: 'client-1',
      scope: ['read', 'write', 'admin'],
      tenant: 'tenant-a',
    });
    expect(Object.isFrozen(principal)).toBe(true);
  });

  it('returns null when the introspection is inactive', () => {
    const principal = tokenMapper.machineFromOryIntrospection(
      oryIntrospectionInactive,
      'tenant-a',
    );
    expect(principal).toBeNull();
  });

  it('returns null when client_id is missing', () => {
    const principal = tokenMapper.machineFromOryIntrospection(
      { active: true, scope: 'read' },
      'tenant-a',
    );
    expect(principal).toBeNull();
  });
});
