/**
 * `SessionStubService` — in-memory replacement for `SessionService`.
 *
 * `whoami(req)` returns a synthetic `IamSession` containing the fixture
 * identity (if any). Without a fixture, `whoami` throws
 * `UnauthorizedException` and `whoamiOrNull` returns null.
 *
 * `revoke(sessionId)` is a no-op that always succeeds.
 */
import {
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import type {
  TenantName,
  IamIdentity,
  IamIdentityWithTraits,
  IamSession,
} from '../../dto';
import { TESTING_STATE, TestingState } from '../testing-state';

function sanitize(
  i: IamIdentity | IamIdentityWithTraits,
  tenant: TenantName,
): IamIdentity {
  const { id, schemaId, state, verifiedAddressesFlags, metadataPublic } = i;
  const sanitized: IamIdentity = metadataPublic
    ? {
        id,
        schemaId,
        state,
        verifiedAddressesFlags,
        metadataPublic,
        tenant,
      }
    : {
        id,
        schemaId,
        state,
        verifiedAddressesFlags,
        tenant,
      };
  return sanitized;
}

function syntheticSession(
  identity: IamIdentity | IamIdentityWithTraits,
  tenant: TenantName,
): IamSession {
  return {
    id: 'sess-fake',
    active: true,
    expiresAt: '2099-01-01T00:00:00.000Z',
    authenticatedAt: '2026-01-01T00:00:00.000Z',
    authenticationMethods: ['password'],
    identity: sanitize(identity, tenant),
    tenant,
  };
}

class SessionStubServiceFor {
  constructor(
    private readonly tenant: TenantName,
    private readonly state: TestingState,
  ) {}

  public async whoami(_req: unknown): Promise<IamSession> {
    void _req;
    if (this.state.identity === undefined) {
      throw new UnauthorizedException({
        statusCode: 401,
        message: 'missing credential',
      });
    }
    return syntheticSession(this.state.identity, this.tenant);
  }

  public async whoamiOrNull(_req: unknown): Promise<IamSession | null> {
    void _req;
    if (this.state.identity === undefined) return null;
    return syntheticSession(this.state.identity, this.tenant);
  }

  public async revoke(_sessionId: string): Promise<void> {
    void _sessionId;
    return;
  }
}

@Injectable()
export class SessionStubService {
  private readonly byTenant = new Map<TenantName, SessionStubServiceFor>();

  constructor(
    @Inject(TESTING_STATE) private readonly state: TestingState,
  ) {}

  public forTenant(name: TenantName): SessionStubServiceFor {
    let existing = this.byTenant.get(name);
    if (existing === undefined) {
      existing = new SessionStubServiceFor(name, this.state);
      this.byTenant.set(name, existing);
    }
    return existing;
  }
}
