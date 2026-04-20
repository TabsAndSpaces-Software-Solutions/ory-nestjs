/**
 * Unit tests for identityMapper.
 */
import {
  identityMapper,
  identityToOryCreatePayload,
} from './identity.mapper';
import {
  emailOnlyVerifiedOryIdentity,
  fullyVerifiedOryIdentity,
  nullMetadataOryIdentity,
  unverifiedNoAddressesOryIdentity,
} from './__fixtures__/identity.fixture';

describe('identityMapper.fromOry', () => {
  it('maps a fully verified identity and stamps the tenant', () => {
    const dto = identityMapper.fromOry(fullyVerifiedOryIdentity, 'tenant-a');
    expect(dto).toEqual({
      id: 'ory-id-1',
      schemaId: 'default',
      state: 'active',
      verifiedAddressesFlags: { email: true, phone: true },
      metadataPublic: { role: 'admin' },
      tenant: 'tenant-a',
    });
  });

  it('does NOT include traits in the sanitized projection', () => {
    const dto = identityMapper.fromOry(fullyVerifiedOryIdentity, 'tenant-a');
    expect(dto as unknown as { traits?: unknown }).not.toHaveProperty('traits');
  });

  it('derives verifiedAddressesFlags from verifiable_addresses', () => {
    const dto = identityMapper.fromOry(emailOnlyVerifiedOryIdentity, 'tenant-b');
    expect(dto.verifiedAddressesFlags).toEqual({ email: true, phone: false });
  });

  it('defaults flags to false when verifiable_addresses is absent', () => {
    const dto = identityMapper.fromOry(unverifiedNoAddressesOryIdentity, 'tenant-c');
    expect(dto.verifiedAddressesFlags).toEqual({ email: false, phone: false });
  });

  it('defaults state to "inactive" when absent', () => {
    const dto = identityMapper.fromOry(unverifiedNoAddressesOryIdentity, 'tenant-c');
    expect(dto.state).toBe('inactive');
  });

  it('omits metadataPublic when Ory reports null', () => {
    const dto = identityMapper.fromOry(nullMetadataOryIdentity, 'tenant-d');
    expect(dto).not.toHaveProperty('metadataPublic');
  });

  it('omits metadataPublic when Ory reports a non-object', () => {
    const dto = identityMapper.fromOry(
      { ...unverifiedNoAddressesOryIdentity, metadata_public: 'not-an-object' as unknown as object },
      'tenant-d',
    );
    expect(dto).not.toHaveProperty('metadataPublic');
  });

  it('returns a deeply frozen DTO', () => {
    const dto = identityMapper.fromOry(fullyVerifiedOryIdentity, 'tenant-a');
    expect(Object.isFrozen(dto)).toBe(true);
    expect(Object.isFrozen(dto.verifiedAddressesFlags)).toBe(true);
    expect(Object.isFrozen(dto.metadataPublic)).toBe(true);
  });

  it('is pure — does not mutate the input', () => {
    const clone = JSON.parse(JSON.stringify(fullyVerifiedOryIdentity));
    identityMapper.fromOry(fullyVerifiedOryIdentity, 'tenant-a');
    expect(fullyVerifiedOryIdentity).toEqual(clone);
  });
});

describe('identityMapper.fromOryWithTraits', () => {
  it('adds traits on top of the sanitized projection', () => {
    const dto = identityMapper.fromOryWithTraits(fullyVerifiedOryIdentity, 'tenant-a');
    expect(dto.traits).toEqual({ email: 'alice@example.com', name: { first: 'Alice' } });
    expect(dto.id).toBe('ory-id-1');
    expect(dto.verifiedAddressesFlags).toEqual({ email: true, phone: true });
    expect(dto.tenant).toBe('tenant-a');
  });

  it('returns an empty traits object when Ory omits traits', () => {
    const input = { ...fullyVerifiedOryIdentity, traits: undefined as unknown as object };
    const dto = identityMapper.fromOryWithTraits(input, 'tenant-a');
    expect(dto.traits).toEqual({});
  });

  it('returns a deeply frozen DTO (traits and nested values)', () => {
    const dto = identityMapper.fromOryWithTraits(fullyVerifiedOryIdentity, 'tenant-a');
    expect(Object.isFrozen(dto)).toBe(true);
    expect(Object.isFrozen(dto.traits)).toBe(true);
    expect(Object.isFrozen((dto.traits as { name: unknown }).name)).toBe(true);
  });
});

describe('identityToOryCreatePayload (reverse mapper)', () => {
  it('translates a library input into an Ory create payload', () => {
    const payload = identityToOryCreatePayload({
      schemaId: 'default',
      traits: { email: 'new@example.com' },
      metadataPublic: { plan: 'free' },
    });
    expect(payload).toEqual({
      schema_id: 'default',
      traits: { email: 'new@example.com' },
      metadata_public: { plan: 'free' },
    });
  });

  it('omits metadata_public when the input omits it', () => {
    const payload = identityToOryCreatePayload({
      schemaId: 'default',
      traits: { email: 'new@example.com' },
    });
    expect(payload).not.toHaveProperty('metadata_public');
  });
});
