/**
 * `IdentityStubService` — in-memory replacement for `IdentityService`.
 *
 * Operates entirely on `TestingState.identityStore`. No network, no Ory.
 *
 * Scope: v1 of the testing harness implements the read-mostly surface
 * consumers exercise in controller tests (`get`, `getWithTraits`,
 * `list`, `create`, `updateTraits`, `delete`). `listSessions` and
 * `revokeSession` are provided as no-op stubs returning empty
 * collections / resolving void — tests that need richer fidelity can
 * mutate `state.identityStore` directly.
 */
import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import type {
  TenantName,
  IamIdentity,
  IamIdentityWithTraits,
  IamSession,
} from '../../dto';
import { TESTING_STATE, TestingState } from '../testing-state';

/** Input shape matches the real service's `IamCreateIdentityInput`. */
interface StubCreateInput {
  readonly schemaId: string;
  readonly traits: Record<string, unknown>;
  readonly verifiedAddresses?: ReadonlyArray<{
    via: 'email' | 'phone';
    value: string;
    verified: boolean;
  }>;
}

function sanitize(i: IamIdentityWithTraits): IamIdentity {
  const { traits: _traits, ...rest } = i;
  void _traits;
  return rest;
}

class IdentityStubServiceFor {
  constructor(
    private readonly tenant: TenantName,
    private readonly state: TestingState,
  ) {}

  public async get(id: string): Promise<IamIdentity> {
    const stored = this.state.identityStore.get(id);
    if (stored === undefined) {
      throw new NotFoundException(`identity ${id} not found`);
    }
    return sanitize({ ...stored, tenant: this.tenant });
  }

  public async getWithTraits(id: string): Promise<IamIdentityWithTraits> {
    const stored = this.state.identityStore.get(id);
    if (stored === undefined) {
      throw new NotFoundException(`identity ${id} not found`);
    }
    return { ...stored, tenant: this.tenant };
  }

  public async list(opts: {
    page?: number;
    perPage?: number;
  }): Promise<{ items: IamIdentity[]; nextPage?: number }> {
    const all = Array.from(this.state.identityStore.values()).map((i) =>
      sanitize({ ...i, tenant: this.tenant }),
    );
    const page = opts.page ?? 1;
    const perPage = opts.perPage;
    if (perPage === undefined) {
      return { items: all };
    }
    const start = (page - 1) * perPage;
    const items = all.slice(start, start + perPage);
    const result: { items: IamIdentity[]; nextPage?: number } = { items };
    if (items.length === perPage) {
      result.nextPage = page + 1;
    }
    return result;
  }

  public async create(
    input: StubCreateInput,
  ): Promise<IamIdentityWithTraits> {
    const id = `stub-${this.state.identityStore.size + 1}`;
    const email =
      input.verifiedAddresses?.some((a) => a.via === 'email' && a.verified) ??
      false;
    const phone =
      input.verifiedAddresses?.some((a) => a.via === 'phone' && a.verified) ??
      false;
    const record: IamIdentityWithTraits = {
      id,
      schemaId: input.schemaId,
      state: 'active',
      verifiedAddressesFlags: { email, phone },
      traits: input.traits,
      tenant: this.tenant,
    };
    this.state.identityStore.set(id, record);
    return record;
  }

  public async updateTraits(
    id: string,
    traits: Record<string, unknown>,
  ): Promise<IamIdentityWithTraits> {
    const stored = this.state.identityStore.get(id);
    if (stored === undefined) {
      throw new NotFoundException(`identity ${id} not found`);
    }
    const updated: IamIdentityWithTraits = {
      ...stored,
      tenant: this.tenant,
      traits,
    };
    this.state.identityStore.set(id, updated);
    return updated;
  }

  public async delete(id: string): Promise<void> {
    this.state.identityStore.delete(id);
  }

  public async listSessions(_id: string): Promise<IamSession[]> {
    void _id;
    return [];
  }

  public async revokeSession(_sessionId: string): Promise<void> {
    void _sessionId;
    return;
  }
}

@Injectable()
export class IdentityStubService {
  private readonly byTenant = new Map<TenantName, IdentityStubServiceFor>();

  constructor(
    @Inject(TESTING_STATE) private readonly state: TestingState,
  ) {}

  public forTenant(name: TenantName): IdentityStubServiceFor {
    let existing = this.byTenant.get(name);
    if (existing === undefined) {
      existing = new IdentityStubServiceFor(name, this.state);
      this.byTenant.set(name, existing);
    }
    return existing;
  }
}
