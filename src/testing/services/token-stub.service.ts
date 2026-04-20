/**
 * `TokenStubService` — in-memory replacement for `TokenService`.
 *
 * `introspect(token)` returns the matching entry from
 * `TestingState.introspections` or a synthetic `{ active: false, tenant }`
 * response. `clientCredentials(scope)` returns a fixture bearer token;
 * consumers testing machine-to-machine flows can seed the corresponding
 * introspection entry to pair the two.
 */
import { Inject, Injectable } from '@nestjs/common';

import type {
  TenantName,
  IamToken,
  IamTokenIntrospection,
} from '../../dto';
import { TESTING_STATE, TestingState } from '../testing-state';

class TokenStubServiceFor {
  constructor(
    private readonly tenant: TenantName,
    private readonly state: TestingState,
  ) {}

  public async clientCredentials(scope: string[]): Promise<IamToken> {
    void this.state;
    return {
      accessToken: `fake-token-${this.tenant}`,
      tokenType: 'Bearer',
      expiresIn: 3600,
      scope,
      tenant: this.tenant,
    };
  }

  public async introspect(token: string): Promise<IamTokenIntrospection> {
    const hit = this.state.introspections.get(token);
    if (hit !== undefined) {
      return { ...hit, tenant: this.tenant };
    }
    return { active: false, tenant: this.tenant };
  }
}

@Injectable()
export class TokenStubService {
  private readonly byTenant = new Map<TenantName, TokenStubServiceFor>();

  constructor(
    @Inject(TESTING_STATE) private readonly state: TestingState,
  ) {}

  public forTenant(name: TenantName): TokenStubServiceFor {
    let existing = this.byTenant.get(name);
    if (existing === undefined) {
      existing = new TokenStubServiceFor(name, this.state);
      this.byTenant.set(name, existing);
    }
    return existing;
  }
}
