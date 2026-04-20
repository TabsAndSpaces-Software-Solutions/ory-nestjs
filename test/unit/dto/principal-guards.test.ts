/**
 * Type guards for principals: user (IamIdentity) vs machine (IamMachinePrincipal).
 * Discriminator is `kind === 'machine'`. IamIdentity has no `kind` field.
 */
import {
  isMachinePrincipal,
  isUserPrincipal,
  type IamIdentity,
  type IamMachinePrincipal,
} from '../../../src/dto';

describe('principal type guards', () => {
  const user: IamIdentity = {
    id: 'id-1',
    schemaId: 'default',
    state: 'active',
    verifiedAddressesFlags: { email: true, phone: false },
    tenant: 'demo',
  };

  const machine: IamMachinePrincipal = {
    kind: 'machine',
    clientId: 'svc-1',
    scope: ['svc.read'],
    tenant: 'demo',
  };

  it('isMachinePrincipal recognises machine principals', () => {
    expect(isMachinePrincipal(machine)).toBe(true);
    expect(isMachinePrincipal(user)).toBe(false);
  });

  it('isUserPrincipal recognises user identities', () => {
    expect(isUserPrincipal(user)).toBe(true);
    expect(isUserPrincipal(machine)).toBe(false);
  });

  it('guards reject null / undefined / non-objects', () => {
    expect(isUserPrincipal(null as unknown as IamIdentity)).toBe(false);
    expect(isUserPrincipal(undefined as unknown as IamIdentity)).toBe(false);
    expect(isUserPrincipal('string' as unknown as IamIdentity)).toBe(false);
    expect(isMachinePrincipal(null as unknown as IamMachinePrincipal)).toBe(false);
    expect(isMachinePrincipal(undefined as unknown as IamMachinePrincipal)).toBe(false);
    expect(isMachinePrincipal(42 as unknown as IamMachinePrincipal)).toBe(false);
  });

  it('narrows within type-guarded blocks', () => {
    const principal: IamIdentity | IamMachinePrincipal = machine;
    if (isMachinePrincipal(principal)) {
      // Type-narrowed — TS should be happy with this.
      expect(principal.clientId).toBe('svc-1');
    } else {
      throw new Error('expected machine principal');
    }

    const principal2: IamIdentity | IamMachinePrincipal = user;
    if (isUserPrincipal(principal2)) {
      expect(principal2.id).toBe('id-1');
    } else {
      throw new Error('expected user identity');
    }
  });
});
