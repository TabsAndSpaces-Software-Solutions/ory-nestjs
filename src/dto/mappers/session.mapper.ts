/**
 * Maps @ory/client `Session` to the library-owned `IamSession` DTO.
 *
 * The embedded identity is ALWAYS sanitized (no traits). Callers that
 * need traits must fetch the full identity separately.
 */
import type { Session as OrySession } from '@ory/client';

import { deepFreeze } from '../freeze';
import type { IamSession } from '../session';
import type { TenantName } from '../tenant';
import { identityMapper } from './identity.mapper';

function placeholderIdentity(tenant: TenantName) {
  // When Ory omits `identity` on the session, we still want a typed DTO.
  // Emit a placeholder so downstream code can read `.identity.tenant`
  // without null-checking.
  return identityMapper.fromOry(
    {
      id: '',
      schema_id: '',
      schema_url: '',
      traits: {},
    },
    tenant,
  );
}

export const sessionMapper = {
  fromOry(s: OrySession, tenant: TenantName): IamSession {
    const methods: string[] = [];
    if (Array.isArray(s.authentication_methods)) {
      for (const m of s.authentication_methods) {
        if (m && typeof m.method === 'string') {
          methods.push(m.method);
        }
      }
    }

    const identity = s.identity
      ? identityMapper.fromOry(s.identity, tenant)
      : placeholderIdentity(tenant);

    const dto: IamSession = {
      id: s.id,
      active: s.active === true,
      expiresAt: s.expires_at ?? '',
      authenticatedAt: s.authenticated_at ?? '',
      authenticationMethods: methods,
      identity,
      tenant,
    };
    return deepFreeze(dto);
  },
};
