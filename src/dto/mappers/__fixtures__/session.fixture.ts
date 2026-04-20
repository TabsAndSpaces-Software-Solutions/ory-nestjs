/**
 * Hand-crafted @ory/client Session payloads for mapper tests.
 */
import type { Session } from '@ory/client';

import { fullyVerifiedOryIdentity } from './identity.fixture';

export const activeOrySession: Session = {
  id: 'sess-1',
  active: true,
  expires_at: '2030-01-01T00:00:00.000Z',
  authenticated_at: '2029-12-31T23:00:00.000Z',
  authentication_methods: [
    { method: 'password', aal: 'aal1' },
    { method: 'totp', aal: 'aal2' },
  ],
  identity: fullyVerifiedOryIdentity,
};

export const minimalOrySession: Session = {
  id: 'sess-2',
  // active omitted intentionally
};

export const sessionWithMissingMethodEntries: Session = {
  id: 'sess-3',
  active: true,
  expires_at: '2030-01-01T00:00:00.000Z',
  authenticated_at: '2029-12-31T23:00:00.000Z',
  authentication_methods: [
    { method: 'password' },
    { aal: 'aal1' }, // missing `method`
    { method: undefined },
  ],
};
