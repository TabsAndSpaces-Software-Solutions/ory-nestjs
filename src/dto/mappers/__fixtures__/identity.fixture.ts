/**
 * Hand-crafted @ory/client Identity payloads for mapper tests.
 *
 * This file lives under `src/dto/mappers/**` so the ESLint override allows
 * the @ory/client import.
 */
import type { Identity } from '@ory/client';

export const fullyVerifiedOryIdentity: Identity = {
  id: 'ory-id-1',
  schema_id: 'default',
  schema_url: 'http://example.test/schemas/default',
  state: 'active',
  traits: { email: 'alice@example.com', name: { first: 'Alice' } },
  metadata_public: { role: 'admin' },
  verifiable_addresses: [
    {
      id: 'va-1',
      status: 'completed',
      value: 'alice@example.com',
      verified: true,
      via: 'email',
    },
    {
      id: 'va-2',
      status: 'completed',
      value: '+15551234567',
      verified: true,
      via: 'sms',
    },
  ],
};

export const emailOnlyVerifiedOryIdentity: Identity = {
  id: 'ory-id-2',
  schema_id: 'default',
  schema_url: 'http://example.test/schemas/default',
  state: 'active',
  traits: { email: 'bob@example.com' },
  verifiable_addresses: [
    {
      id: 'va-3',
      status: 'completed',
      value: 'bob@example.com',
      verified: true,
      via: 'email',
    },
    {
      id: 'va-4',
      status: 'pending',
      value: '+15550000000',
      verified: false,
      via: 'sms',
    },
  ],
};

export const unverifiedNoAddressesOryIdentity: Identity = {
  id: 'ory-id-3',
  schema_id: 'default',
  schema_url: 'http://example.test/schemas/default',
  // state absent on purpose
  traits: {},
};

export const nullMetadataOryIdentity: Identity = {
  id: 'ory-id-4',
  schema_id: 'default',
  schema_url: 'http://example.test/schemas/default',
  state: 'inactive',
  traits: {},
  metadata_public: null,
};
