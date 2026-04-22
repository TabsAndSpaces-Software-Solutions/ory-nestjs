/**
 * `TrustedIssuerService` — tenant-scoped Hydra `jwt-bearer` trusted-issuer
 * management. Lets a Hydra deployment accept JWTs signed by a registered
 * external issuer as input to the `urn:ietf:params:oauth:grant-type:jwt-bearer`
 * grant.
 *
 * Wraps `OAuth2Api.trustOAuth2JwtGrantIssuer` / `getTrustedOAuth2JwtGrantIssuer`
 * / `listTrustedOAuth2JwtGrantIssuers` / `deleteTrustedOAuth2JwtGrantIssuer`.
 *
 * Zero `@ory/*` imports here.
 */
import { Inject, Injectable } from '@nestjs/common';

import { AUDIT_SINK, type AuditSink } from '../audit';
import { correlationStorage } from '../clients/correlation-storage';
import type { TenantClients } from '../clients';
import type {
  TenantName,
  IamJsonWebKey,
  IamTrustedIssuer,
} from '../dto';
import { tokenMapper } from '../dto/mappers';
import { ErrorMapper, IamConfigurationError } from '../errors';
import { TENANT_REGISTRY } from '../module/registry/tokens';
import type { TenantRegistry } from '../module/registry/tenant-registry.service';
import { emitAudit } from './audit-helpers';

export interface IamTrustIssuerInput {
  readonly issuer: string;
  readonly subject?: string;
  readonly scope: readonly string[];
  /** ISO 8601 expiry. */
  readonly expiresAt: string;
  readonly publicKey: IamJsonWebKey;
  /** If true, accept the issuer for any subject (subject omitted). */
  readonly allowAnySubject?: boolean;
}

export interface TrustedIssuerServiceFor {
  trust(input: IamTrustIssuerInput): Promise<IamTrustedIssuer>;
  get(id: string): Promise<IamTrustedIssuer>;
  list(opts?: {
    issuer?: string;
    pageSize?: number;
    pageToken?: string;
  }): Promise<{ items: IamTrustedIssuer[] }>;
  delete(id: string): Promise<void>;
}

interface AdminLike {
  trustOAuth2JwtGrantIssuer(req: unknown): Promise<{ data: unknown }>;
  getTrustedOAuth2JwtGrantIssuer(req: unknown): Promise<{ data: unknown }>;
  listTrustedOAuth2JwtGrantIssuers(req?: unknown): Promise<{ data: unknown }>;
  deleteTrustedOAuth2JwtGrantIssuer(req: unknown): Promise<{ data: unknown }>;
}

@Injectable()
export class TrustedIssuerService {
  private readonly byTenant = new Map<TenantName, TrustedIssuerServiceFor>();

  constructor(
    @Inject(TENANT_REGISTRY) private readonly registry: TenantRegistry,
    @Inject(AUDIT_SINK) private readonly audit: AuditSink,
  ) {}

  public forTenant(name: TenantName): TrustedIssuerServiceFor {
    const existing = this.byTenant.get(name);
    if (existing !== undefined) return existing;
    const reg = this.registry;
    const audit = this.audit;
    const wrapper: TrustedIssuerServiceFor = {
      trust: async (input) => {
        const api = admin(reg, name);
        try {
          const body: Record<string, unknown> = {
            issuer: input.issuer,
            scope: [...input.scope],
            expires_at: input.expiresAt,
            jwk: input.publicKey,
            allow_any_subject: input.allowAnySubject === true,
          };
          if (input.subject !== undefined) body.subject = input.subject;
          const { data } = await api.trustOAuth2JwtGrantIssuer({
            trustOAuth2JwtGrantIssuer: body,
          });
          const issuer = tokenMapper.trustedIssuerFromOry(
            data as Parameters<typeof tokenMapper.trustedIssuerFromOry>[0],
            name,
          );
          await emitAudit(audit, 'iam.oauth2.trustedIssuer.trust', name, {
            targetId: issuer.id,
            attributes: { issuer: issuer.issuer },
          });
          return issuer;
        } catch (err) {
          throw ErrorMapper.toNest(err, { correlationId: corrId() });
        }
      },
      get: async (id) => {
        const api = admin(reg, name);
        try {
          const { data } = await api.getTrustedOAuth2JwtGrantIssuer({ id });
          return tokenMapper.trustedIssuerFromOry(
            data as Parameters<typeof tokenMapper.trustedIssuerFromOry>[0],
            name,
          );
        } catch (err) {
          throw ErrorMapper.toNest(err, { correlationId: corrId() });
        }
      },
      list: async (opts) => {
        const api = admin(reg, name);
        const req: Record<string, unknown> = {};
        if (opts?.issuer !== undefined) req.issuer = opts.issuer;
        if (opts?.pageSize !== undefined) req.maxItems = opts.pageSize;
        if (opts?.pageToken !== undefined) req.defaultItems = opts.pageToken;
        try {
          const { data } = await api.listTrustedOAuth2JwtGrantIssuers(req);
          const list = Array.isArray(data) ? data : [];
          const items = list.map((i) =>
            tokenMapper.trustedIssuerFromOry(
              i as Parameters<typeof tokenMapper.trustedIssuerFromOry>[0],
              name,
            ),
          );
          return { items };
        } catch (err) {
          throw ErrorMapper.toNest(err, { correlationId: corrId() });
        }
      },
      delete: async (id) => {
        const api = admin(reg, name);
        try {
          await api.deleteTrustedOAuth2JwtGrantIssuer({ id });
        } catch (err) {
          throw ErrorMapper.toNest(err, { correlationId: corrId() });
        }
        await emitAudit(audit, 'iam.oauth2.trustedIssuer.delete', name, {
          targetId: id,
        });
      },
    };
    this.byTenant.set(name, wrapper);
    return wrapper;
  }
}

function admin(registry: TenantRegistry, tenant: TenantName): AdminLike {
  const clients: TenantClients = registry.get(tenant);
  if (!clients.hydraOauth2) {
    throw new IamConfigurationError({
      message: `Hydra admin OAuth2 client not configured for tenant '${tenant}'`,
    });
  }
  return clients.hydraOauth2 as unknown as AdminLike;
}

function corrId(): string | undefined {
  return correlationStorage.getStore()?.correlationId;
}
