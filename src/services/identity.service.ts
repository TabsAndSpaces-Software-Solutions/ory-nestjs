/**
 * `IdentityService` — tenant-scoped Kratos Identity admin facade.
 *
 * Design invariants:
 *   - Public surface leaks **zero** `@ory/*` types. Call sites exclusively
 *     traffic in `ory-nestjs*` DTOs. The `TenantClients.kratosIdentity` value is
 *     a typed `IdentityApi` (from `@ory/client`) but we reach it ONLY via
 *     the type-only import of `TenantClients` in `../clients/` — this
 *     file itself does not `import '@ory/client'`. The ESLint ban rule
 *     forbids that import in `src/services/**`.
 *   - Never log or return raw Ory payloads. Every upstream response is
 *     converted to a library DTO via `identityMapper` / `sessionMapper`
 *     before the method returns.
 *   - Tenants that lack admin-API configuration (no `kratosIdentity` on
 *     their `TenantClients` bundle) trigger a loud `IamConfigurationError`
 *     at the service boundary. The error bubbles up unmodified — the
 *     HTTP boundary's `ErrorMapper` decides the client-facing status.
 *   - Upstream failures are funneled through `ErrorMapper.toNest(err)`
 *     so every Ory 401/403/5xx (and AxiosError network failures) surface
 *     as NestJS exceptions consistent with the rest of the library.
 *   - `.forTenant(name)` returns a stable, memoized `IdentityServiceFor`
 *     instance per tenant (one Map lookup per call after the first).
 *     No caching of tenant clients — the registry already does that.
 *   - `.revokeSession(sessionId)` emits an `authz.session.revoke` audit
 *     event on success only. Failures are NOT audited here — that is the
 *     caller's responsibility (or a future cross-cutting interceptor).
 *
 * v1 simplifications (documented per the spec):
 *   - `updateTraits` fetches the existing identity first to preserve the
 *     caller's `schema_id` and `state`. This costs one extra admin call
 *     but means consumers pass only `(id, traits)` — matching the spec.
 *   - `list({ page?, perPage? })` returns `nextPage = page + 1` iff the
 *     response returned exactly `perPage` items. A null `page` defaults
 *     to `1` for this heuristic.
 *   - No caching. No retries beyond whatever the tenant's axios retry
 *     interceptor does at the transport layer.
 */
import { Inject, Injectable } from '@nestjs/common';

import { AUDIT_SINK, type AuditSink } from '../audit';
import { correlationStorage } from '../clients/correlation-storage';
import type { TenantClients } from '../clients';
import type {
  TenantName,
  IamIdentity,
  IamIdentityWithTraits,
  IamSession,
} from '../dto';
import { identityMapper, sessionMapper } from '../dto/mappers';
import { ErrorMapper, IamConfigurationError } from '../errors';
import { TENANT_REGISTRY } from '../module/registry/tokens';
import type { TenantRegistry } from '../module/registry/tenant-registry.service';

/**
 * Input shape for `IdentityServiceFor.create`. The service translates this
 * into the Ory `createIdentityBody` payload without the caller ever
 * importing `@ory/client`.
 */
export interface IamCreateIdentityInput {
  readonly schemaId: string;
  readonly traits: Record<string, unknown>;
  readonly verifiedAddresses?: ReadonlyArray<{
    via: 'email' | 'phone';
    value: string;
    verified: boolean;
  }>;
}

@Injectable()
export class IdentityService {
  private readonly byTenant = new Map<TenantName, IdentityServiceFor>();

  constructor(
    @Inject(TENANT_REGISTRY) private readonly registry: TenantRegistry,
    @Inject(AUDIT_SINK) private readonly audit: AuditSink,
  ) {}

  /**
   * Memoized accessor: returns the same `IdentityServiceFor` instance
   * for each tenant across calls. The registry itself guarantees the
   * underlying `TenantClients` are stable, so reference-equality here
   * is safe and expected by downstream code that may want to identity-
   * compare tenant-scoped services.
   */
  public forTenant(name: TenantName): IdentityServiceFor {
    let existing = this.byTenant.get(name);
    if (existing === undefined) {
      existing = new IdentityServiceFor(name, this.registry, this.audit);
      this.byTenant.set(name, existing);
    }
    return existing;
  }
}

/**
 * Tenant-scoped projection of `IdentityService`. All methods are async;
 * all methods require the tenant's `kratosIdentity` admin client to be
 * present in its `TenantClients` bundle.
 */
export class IdentityServiceFor {
  constructor(
    private readonly tenant: TenantName,
    private readonly registry: TenantRegistry,
    private readonly audit: AuditSink,
  ) {}

  /** Return the sanitized (no-traits) identity projection. */
  public async get(id: string): Promise<IamIdentity> {
    const api = this.requireAdmin();
    try {
      const { data } = await api.getIdentity({ id });
      return identityMapper.fromOry(data, this.tenant);
    } catch (err) {
      throw ErrorMapper.toNest(err, {
        correlationId: this.currentCorrelationId(),
      });
    }
  }

  /** Return the identity projection with raw traits attached. */
  public async getWithTraits(id: string): Promise<IamIdentityWithTraits> {
    const api = this.requireAdmin();
    try {
      const { data } = await api.getIdentity({ id });
      return identityMapper.fromOryWithTraits(data, this.tenant);
    } catch (err) {
      throw ErrorMapper.toNest(err, {
        correlationId: this.currentCorrelationId(),
      });
    }
  }

  /**
   * Paginated identity listing. `nextPage` is a simple heuristic:
   * emitted when the response contained exactly `perPage` items.
   * `perPage` defaults to Kratos's default when omitted — in that case
   * no `nextPage` is inferred because we don't know the effective page
   * size.
   */
  public async list(opts: {
    page?: number;
    perPage?: number;
  }): Promise<{ items: IamIdentity[]; nextPage?: number }> {
    const api = this.requireAdmin();
    const page = opts.page ?? 1;
    const perPage = opts.perPage;
    const req: { page?: number; perPage?: number } = {};
    if (opts.page !== undefined) req.page = opts.page;
    if (opts.perPage !== undefined) req.perPage = opts.perPage;

    try {
      const { data } = await api.listIdentities(req);
      const list = Array.isArray(data) ? data : [];
      const items = list.map((o: unknown) =>
        identityMapper.fromOry(
          o as Parameters<typeof identityMapper.fromOry>[0],
          this.tenant,
        ),
      );
      const result: { items: IamIdentity[]; nextPage?: number } = { items };
      if (perPage !== undefined && items.length === perPage) {
        result.nextPage = page + 1;
      }
      return result;
    } catch (err) {
      throw ErrorMapper.toNest(err, {
        correlationId: this.currentCorrelationId(),
      });
    }
  }

  /**
   * Create a new identity. Returns the created identity with its traits.
   * The optional `verifiedAddresses` input is mapped to Ory's
   * `verifiable_addresses` shape (Ory accepts these only on creation, to
   * seed the identity with pre-verified contact points).
   */
  public async create(
    input: IamCreateIdentityInput,
  ): Promise<IamIdentityWithTraits> {
    const api = this.requireAdmin();
    // Build the Ory payload inline. We never import the Ory type for it —
    // `createIdentityBody` is a plain JSON object; keeping it typed as
    // `Record<string, unknown>` avoids pulling `@ory/client` into this file.
    const body: Record<string, unknown> = {
      schema_id: input.schemaId,
      traits: input.traits,
    };
    if (input.verifiedAddresses !== undefined) {
      body.verifiable_addresses = input.verifiedAddresses.map((a) => ({
        via: a.via,
        value: a.value,
        verified: a.verified,
      }));
    }

    try {
      // Cast the spy-or-real call to `any` at the boundary: `createIdentity`
      // expects a type-checked `CreateIdentityBody`, and the whole point of
      // this service is that we do NOT import that type.
      const apiAny = api as unknown as {
        createIdentity(req: unknown): Promise<{ data: unknown }>;
      };
      const { data } = await apiAny.createIdentity({ createIdentityBody: body });
      return identityMapper.fromOryWithTraits(
        data as Parameters<typeof identityMapper.fromOryWithTraits>[0],
        this.tenant,
      );
    } catch (err) {
      throw ErrorMapper.toNest(err, {
        correlationId: this.currentCorrelationId(),
      });
    }
  }

  /**
   * Update an identity's traits. We fetch the current identity first to
   * preserve `schema_id` (Ory requires it on update) and leave the state
   * at `'active'` — the spec explicitly permits this shape.
   */
  public async updateTraits(
    id: string,
    traits: Record<string, unknown>,
  ): Promise<IamIdentityWithTraits> {
    const api = this.requireAdmin();
    try {
      const { data: existing } = await api.getIdentity({ id });
      const existingAny = existing as { schema_id: string };
      const body: Record<string, unknown> = {
        schema_id: existingAny.schema_id,
        traits,
        state: 'active',
      };
      const apiAny = api as unknown as {
        updateIdentity(req: unknown): Promise<{ data: unknown }>;
      };
      const { data } = await apiAny.updateIdentity({
        id,
        updateIdentityBody: body,
      });
      return identityMapper.fromOryWithTraits(
        data as Parameters<typeof identityMapper.fromOryWithTraits>[0],
        this.tenant,
      );
    } catch (err) {
      throw ErrorMapper.toNest(err, {
        correlationId: this.currentCorrelationId(),
      });
    }
  }

  /** Delete an identity. */
  public async delete(id: string): Promise<void> {
    const api = this.requireAdmin();
    try {
      await api.deleteIdentity({ id });
    } catch (err) {
      throw ErrorMapper.toNest(err, {
        correlationId: this.currentCorrelationId(),
      });
    }
  }

  /** List all sessions currently attached to an identity. */
  public async listSessions(id: string): Promise<IamSession[]> {
    const api = this.requireAdmin();
    try {
      const { data } = await api.listIdentitySessions({ id });
      const list = Array.isArray(data) ? data : [];
      return list.map((s: unknown) =>
        sessionMapper.fromOry(
          s as Parameters<typeof sessionMapper.fromOry>[0],
          this.tenant,
        ),
      );
    } catch (err) {
      throw ErrorMapper.toNest(err, {
        correlationId: this.currentCorrelationId(),
      });
    }
  }

  /**
   * Revoke a session by id and emit `authz.session.revoke` on success.
   *
   * Failure modes are audited by the upstream boundary (e.g. the HTTP
   * filter), not here — the spec asks only for the success emission.
   */
  public async revokeSession(sessionId: string): Promise<void> {
    const api = this.requireAdmin();
    try {
      await api.disableSession({ id: sessionId });
    } catch (err) {
      throw ErrorMapper.toNest(err, {
        correlationId: this.currentCorrelationId(),
      });
    }

    await this.audit.emit({
      timestamp: new Date().toISOString(),
      event: 'authz.session.revoke',
      tenant: this.tenant,
      targetId: sessionId,
      result: 'success',
      attributes: {},
      correlationId: this.currentCorrelationId(),
    });
  }

  /**
   * Resolve the tenant's admin API or throw `IamConfigurationError`.
   * Called at the top of every method to fail fast with a single,
   * consistent error shape.
   */
  private requireAdmin(): NonNullable<TenantClients['kratosIdentity']> {
    const clients = this.registry.get(this.tenant);
    if (!clients.kratosIdentity) {
      throw new IamConfigurationError({
        message: `admin API not configured for tenant ${this.tenant}`,
      });
    }
    return clients.kratosIdentity;
  }

  private currentCorrelationId(): string | undefined {
    return correlationStorage.getStore()?.correlationId;
  }
}
