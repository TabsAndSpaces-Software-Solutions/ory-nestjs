/**
 * `PermissionService` — tenant-scoped Keto relationship CRUD + permission
 * checks.
 *
 * Spec unit: `prs`.
 *
 * Design invariants:
 *   - Public surface leaks **zero** `@ory/*` types. The `ketoPermission` and
 *     `ketoRelationship` fields of `TenantClients` are typed `PermissionApi`
 *     / `RelationshipApi` from `@ory/client`, but we reach them ONLY via the
 *     type-only import of `TenantClients` in `../clients/` — this file does
 *     NOT `import '@ory/client'`. The ESLint ban rule forbids that import in
 *     `src/services/**`; we rely on small `as unknown as { method(...): ... }`
 *     structural casts at each call site.
 *   - Tenants that lack the admin Keto APIs on their `TenantClients` bundle
 *     trigger a loud `IamConfigurationError` at the service boundary. The
 *     error bubbles up unmodified — the HTTP boundary's `ErrorMapper` decides
 *     the client-facing status.
 *   - Upstream failures are funneled through `ErrorMapper.toNest(err)` so Ory
 *     4xx/5xx (and AxiosError network failures) surface as NestJS exceptions
 *     consistent with the rest of the library.
 *   - `.forTenant(name)` returns a stable, memoized `PermissionServiceFor`
 *     per tenant (single Map lookup after the first call).
 *   - No caching of check results.
 *
 * Idempotency semantics:
 *   - `grant` treats upstream 409 (conflict) as success. The audit event is
 *     still emitted — from the caller's perspective the grant now exists.
 *   - `revoke` treats upstream 404 (not found) as success. The audit event is
 *     still emitted — from the caller's perspective the relationship is gone.
 *
 * Audit attributes:
 *   Every grant/revoke event carries `{ namespace, relation, object, subject }`
 *   in its `attributes` bag. Tenant + correlationId come from the service's
 *   tenant and the shared `correlationStorage` respectively.
 */
import { Inject, Injectable } from '@nestjs/common';

import { AUDIT_SINK, type AuditSink } from '../audit';
import { correlationStorage } from '../clients/correlation-storage';
import type { TenantClients } from '../clients';
import type {
  TenantName,
  IamPermissionCheckResult,
  IamPermissionQuery,
  IamPermissionTree,
  IamPermissionTreeNode,
  IamPermissionTuple,
} from '../dto';
import { ErrorMapper, IamConfigurationError } from '../errors';
import { TENANT_REGISTRY } from '../module/registry/tokens';
import type { TenantRegistry } from '../module/registry/tenant-registry.service';

/**
 * Paged `list` result — shape shared by both the full-tuple listing and the
 * eventual subject-expansion helpers.
 */
export interface IamPermissionList {
  items: IamPermissionTuple[];
  nextPageToken?: string;
}

/** Tenant-scoped projection of `PermissionService`. */
export interface PermissionServiceFor {
  /**
   * Check whether `tuple.subject` has `tuple.relation` on `tuple.object`.
   * Returns the raw `allowed` boolean from the upstream Keto check. Never
   * caches.
   */
  check(tuple: IamPermissionTuple): Promise<boolean>;

  /**
   * Grant the relationship tuple. Idempotent: a 409 conflict is treated as
   * success. Emits `authz.permission.grant` on success.
   */
  grant(tuple: IamPermissionTuple): Promise<void>;

  /**
   * Revoke the relationship tuple. Idempotent: a 404 is treated as success.
   * Emits `authz.permission.revoke` on success.
   */
  revoke(tuple: IamPermissionTuple): Promise<void>;

  /**
   * List relationship tuples matching `query`. Returns mapped library DTOs
   * plus an optional `nextPageToken` for pagination.
   */
  list(query: IamPermissionQuery): Promise<IamPermissionList>;

  /**
   * Expand a subject tree for `(namespace, object, relation)` up to
   * `maxDepth` levels. Useful for "who can access X" introspection.
   */
  expand(
    req: {
      namespace: string;
      object: string;
      relation: string;
      maxDepth?: number;
    },
  ): Promise<IamPermissionTree>;

  /**
   * Batch-check an array of tuples. Runs concurrently against Keto and
   * returns one result per input in order. Upstream errors surface per-tuple
   * via `error` rather than throwing — callers decide fail-open/closed.
   */
  checkBatch(
    tuples: ReadonlyArray<IamPermissionTuple>,
  ): Promise<IamPermissionCheckResult[]>;
}

@Injectable()
export class PermissionService {
  private readonly byTenant = new Map<TenantName, PermissionServiceFor>();

  constructor(
    @Inject(TENANT_REGISTRY) private readonly registry: TenantRegistry,
    @Inject(AUDIT_SINK) private readonly audit: AuditSink,
  ) {}

  /**
   * Memoized accessor: returns the same `PermissionServiceFor` instance for
   * each tenant across calls.
   */
  public forTenant(name: TenantName): PermissionServiceFor {
    const existing = this.byTenant.get(name);
    if (existing !== undefined) return existing;

    const registry = this.registry;
    const audit = this.audit;
    const wrapper: PermissionServiceFor = {
      check: (tuple) => checkImpl(registry, name, tuple),
      grant: (tuple) => grantImpl(registry, audit, name, tuple),
      revoke: (tuple) => revokeImpl(registry, audit, name, tuple),
      list: (query) => listImpl(registry, name, query),
      expand: (req) => expandImpl(registry, name, req),
      checkBatch: (tuples) => checkBatchImpl(registry, name, tuples),
    };
    this.byTenant.set(name, wrapper);
    return wrapper;
  }
}

// ---------- implementations ----------

async function checkImpl(
  registry: TenantRegistry,
  tenant: TenantName,
  tuple: IamPermissionTuple,
): Promise<boolean> {
  const api = requirePermissionApi(registry, tenant);
  try {
    // Cast away @ory/client types at the boundary — the ESLint ban rule forbids
    // importing those types in `src/services/**`. The structural contract
    // `{ checkPermission(req): Promise<{ data: ... }> }` is what we rely on.
    const apiAny = api as unknown as {
      checkPermission(req: unknown): Promise<{ data: unknown }>;
    };
    const { data } = await apiAny.checkPermission({
      namespace: tuple.namespace,
      object: tuple.object,
      relation: tuple.relation,
      subjectId: tuple.subject,
    });
    const allowed = (data as { allowed?: unknown })?.allowed;
    return allowed === true;
  } catch (err) {
    throw ErrorMapper.toNest(err, {
      correlationId: currentCorrelationId(),
    });
  }
}

async function grantImpl(
  registry: TenantRegistry,
  audit: AuditSink,
  tenant: TenantName,
  tuple: IamPermissionTuple,
): Promise<void> {
  const api = requireRelationshipApi(registry, tenant);
  try {
    const apiAny = api as unknown as {
      createRelationship(req: unknown): Promise<{ data: unknown }>;
    };
    await apiAny.createRelationship({
      createRelationshipBody: {
        namespace: tuple.namespace,
        object: tuple.object,
        relation: tuple.relation,
        subject_id: tuple.subject,
      },
    });
  } catch (err) {
    // Idempotency: a 409 conflict means the tuple already exists — treat as
    // success and continue to emit the audit event. Any other error is
    // funneled through ErrorMapper.
    if (statusOf(err) !== 409) {
      throw ErrorMapper.toNest(err, {
        correlationId: currentCorrelationId(),
      });
    }
  }

  await audit.emit({
    timestamp: new Date().toISOString(),
    event: 'authz.permission.grant',
    tenant,
    result: 'success',
    attributes: {
      namespace: tuple.namespace,
      relation: tuple.relation,
      object: tuple.object,
      subject: tuple.subject,
    },
    correlationId: currentCorrelationId(),
  });
}

async function revokeImpl(
  registry: TenantRegistry,
  audit: AuditSink,
  tenant: TenantName,
  tuple: IamPermissionTuple,
): Promise<void> {
  const api = requireRelationshipApi(registry, tenant);
  try {
    const apiAny = api as unknown as {
      deleteRelationships(req: unknown): Promise<{ data: unknown }>;
    };
    await apiAny.deleteRelationships({
      namespace: tuple.namespace,
      object: tuple.object,
      relation: tuple.relation,
      subjectId: tuple.subject,
    });
  } catch (err) {
    // Idempotency: a 404 means the tuple was already gone — treat as success
    // and continue to emit the audit event.
    if (statusOf(err) !== 404) {
      throw ErrorMapper.toNest(err, {
        correlationId: currentCorrelationId(),
      });
    }
  }

  await audit.emit({
    timestamp: new Date().toISOString(),
    event: 'authz.permission.revoke',
    tenant,
    result: 'success',
    attributes: {
      namespace: tuple.namespace,
      relation: tuple.relation,
      object: tuple.object,
      subject: tuple.subject,
    },
    correlationId: currentCorrelationId(),
  });
}

async function listImpl(
  registry: TenantRegistry,
  tenant: TenantName,
  query: IamPermissionQuery,
): Promise<IamPermissionList> {
  const api = requireRelationshipApi(registry, tenant);
  const req: Record<string, unknown> = {};
  if (query.namespace !== undefined) req.namespace = query.namespace;
  if (query.object !== undefined) req.object = query.object;
  if (query.relation !== undefined) req.relation = query.relation;
  if (query.subject !== undefined) req.subjectId = query.subject;
  if (query.limit !== undefined) req.pageSize = query.limit;
  if (query.pageToken !== undefined) req.pageToken = query.pageToken;

  try {
    const apiAny = api as unknown as {
      getRelationships(req: unknown): Promise<{ data: unknown }>;
    };
    const { data } = await apiAny.getRelationships(req);
    const dataAny = (data ?? {}) as {
      relation_tuples?: Array<{
        namespace?: string;
        object?: string;
        relation?: string;
        subject_id?: string;
      }>;
      next_page_token?: string;
    };
    const list = Array.isArray(dataAny.relation_tuples)
      ? dataAny.relation_tuples
      : [];
    const items: IamPermissionTuple[] = list.map((t) => ({
      namespace: t.namespace ?? '',
      object: t.object ?? '',
      relation: t.relation ?? '',
      subject: t.subject_id ?? '',
      tenant,
    }));
    const result: IamPermissionList = { items };
    // Keto returns an empty string when no further page exists — treat falsy
    // values as "no next page" to avoid emitting a useless cursor.
    if (
      typeof dataAny.next_page_token === 'string' &&
      dataAny.next_page_token.length > 0
    ) {
      result.nextPageToken = dataAny.next_page_token;
    }
    return result;
  } catch (err) {
    throw ErrorMapper.toNest(err, {
      correlationId: currentCorrelationId(),
    });
  }
}

async function expandImpl(
  registry: TenantRegistry,
  tenant: TenantName,
  req: {
    namespace: string;
    object: string;
    relation: string;
    maxDepth?: number;
  },
): Promise<IamPermissionTree> {
  const api = requirePermissionApi(registry, tenant);
  try {
    const apiAny = api as unknown as {
      expandPermissions(req: unknown): Promise<{ data: unknown }>;
    };
    const payload: Record<string, unknown> = {
      namespace: req.namespace,
      object: req.object,
      relation: req.relation,
    };
    if (req.maxDepth !== undefined) payload.maxDepth = req.maxDepth;
    const { data } = await apiAny.expandPermissions(payload);
    return { root: mapTreeNode(data), tenant };
  } catch (err) {
    throw ErrorMapper.toNest(err, {
      correlationId: currentCorrelationId(),
    });
  }
}

function mapTreeNode(raw: unknown): IamPermissionTreeNode {
  const n = (raw ?? {}) as {
    type?: unknown;
    tuple?: { namespace?: unknown; object?: unknown; relation?: unknown; subject_id?: unknown };
    children?: unknown[];
  };
  const node: IamPermissionTreeNode = {
    type: (typeof n.type === 'string' ? n.type : 'unspecified') as IamPermissionTreeNode['type'],
    ...(n.tuple
      ? {
          tuple: {
            namespace: typeof n.tuple.namespace === 'string' ? n.tuple.namespace : '',
            object: typeof n.tuple.object === 'string' ? n.tuple.object : '',
            relation: typeof n.tuple.relation === 'string' ? n.tuple.relation : '',
            subject: typeof n.tuple.subject_id === 'string' ? n.tuple.subject_id : undefined,
          },
        }
      : {}),
    ...(Array.isArray(n.children)
      ? { children: n.children.map(mapTreeNode) }
      : {}),
  };
  return node;
}

async function checkBatchImpl(
  registry: TenantRegistry,
  tenant: TenantName,
  tuples: ReadonlyArray<IamPermissionTuple>,
): Promise<IamPermissionCheckResult[]> {
  // Run all checks concurrently; never let one upstream failure fail the batch.
  const settled = await Promise.allSettled(
    tuples.map((t) => checkImpl(registry, tenant, t)),
  );
  return settled.map((r, i) => {
    if (r.status === 'fulfilled') {
      return { tuple: tuples[i], allowed: r.value };
    }
    const reason = r.reason;
    const msg =
      reason instanceof Error ? reason.message : String(reason ?? 'error');
    return { tuple: tuples[i], allowed: false, error: msg };
  });
}

// ---------- helpers ----------

/**
 * Resolve the tenant's Keto permission (check) API or throw
 * `IamConfigurationError` — fail fast with a single, consistent shape.
 */
function requirePermissionApi(
  registry: TenantRegistry,
  tenant: TenantName,
): NonNullable<TenantClients['ketoPermission']> {
  const clients = registry.get(tenant);
  if (clients.ketoPermission === undefined) {
    throw new IamConfigurationError({
      message: `Keto permission API not configured for tenant ${tenant}`,
    });
  }
  return clients.ketoPermission;
}

/** Resolve the tenant's Keto relationship (CRUD) API or throw. */
function requireRelationshipApi(
  registry: TenantRegistry,
  tenant: TenantName,
): NonNullable<TenantClients['ketoRelationship']> {
  const clients = registry.get(tenant);
  if (clients.ketoRelationship === undefined) {
    throw new IamConfigurationError({
      message: `Keto relationship API not configured for tenant ${tenant}`,
    });
  }
  return clients.ketoRelationship;
}

/**
 * Structural HTTP-status extraction for idempotency detection. AxiosError and
 * most Ory SDK errors expose `err.response.status`; some library callers also
 * attach `err.status` directly. We accept either shape.
 */
function statusOf(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const any = err as { response?: { status?: unknown }; status?: unknown };
  if (typeof any.response?.status === 'number') return any.response.status;
  if (typeof any.status === 'number') return any.status;
  return undefined;
}

function currentCorrelationId(): string | undefined {
  return correlationStorage.getStore()?.correlationId;
}
