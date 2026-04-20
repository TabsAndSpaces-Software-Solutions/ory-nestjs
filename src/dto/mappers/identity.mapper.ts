/**
 * Maps between @ory/client `Identity` and the library-owned identity DTOs.
 *
 * Allowed to import @ory/client — this file is under `src/dto/mappers/**`
 * which is covered by the ESLint override for the ban rule.
 */
import type {
  Identity as OryIdentity,
  VerifiableIdentityAddress as OryVerifiableIdentityAddress,
} from '@ory/client';

import { deepFreeze } from '../freeze';
import type {
  IamIdentity,
  IamIdentityWithTraits,
  IamVerifiedAddressesFlags,
} from '../identity';
import type { TenantName } from '../tenant';

/**
 * Input type for creating a new identity via the library. The mapper
 * translates it into the @ory/client create payload shape.
 */
export interface IamCreateIdentityInput {
  readonly schemaId: string;
  readonly traits: Record<string, unknown>;
  readonly metadataPublic?: Record<string, unknown>;
}

/** @ory/client-compatible create-identity request body. */
export interface OryCreateIdentityPayload {
  readonly schema_id: string;
  readonly traits: Record<string, unknown>;
  readonly metadata_public?: Record<string, unknown>;
}

function deriveVerifiedFlags(
  addresses: ReadonlyArray<OryVerifiableIdentityAddress> | undefined,
): IamVerifiedAddressesFlags {
  if (!addresses || addresses.length === 0) {
    return { email: false, phone: false };
  }
  let email = false;
  let phone = false;
  for (const a of addresses) {
    if (!a.verified) continue;
    // Ory emits `email` or `sms` as the delivery channel. Map both `sms`
    // and the legacy `phone` label onto the library's `phone` flag.
    if (a.via === 'email') email = true;
    else if ((a.via as string) === 'sms' || (a.via as string) === 'phone') {
      phone = true;
    }
  }
  return { email, phone };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function buildSanitized(
  o: OryIdentity,
  tenant: TenantName,
): IamIdentity {
  const flags = deriveVerifiedFlags(o.verifiable_addresses);
  const state: IamIdentity['state'] = o.state === 'active' ? 'active' : 'inactive';
  const base: Omit<IamIdentity, 'metadataPublic'> & { metadataPublic?: Record<string, unknown> } = {
    id: o.id,
    schemaId: o.schema_id,
    state,
    verifiedAddressesFlags: flags,
    tenant,
  };
  if (isPlainObject(o.metadata_public)) {
    base.metadataPublic = o.metadata_public as Record<string, unknown>;
  }
  return base as IamIdentity;
}

export const identityMapper = {
  fromOry(o: OryIdentity, tenant: TenantName): IamIdentity {
    return deepFreeze(buildSanitized(o, tenant));
  },

  fromOryWithTraits(o: OryIdentity, tenant: TenantName): IamIdentityWithTraits {
    const sanitized = buildSanitized(o, tenant);
    const traits: Record<string, unknown> = isPlainObject(o.traits)
      ? (o.traits as Record<string, unknown>)
      : {};
    const withTraits: IamIdentityWithTraits = { ...sanitized, traits };
    return deepFreeze(withTraits);
  },
};

/**
 * Reverse mapper: library input → Ory create payload. Kept as a free
 * function because the `fromOry` side dominates usage and we want a concise
 * `identityMapper.fromOry(...)` call site.
 */
export function identityToOryCreatePayload(
  input: IamCreateIdentityInput,
): OryCreateIdentityPayload {
  const payload: { -readonly [K in keyof OryCreateIdentityPayload]: OryCreateIdentityPayload[K] } = {
    schema_id: input.schemaId,
    traits: input.traits,
  };
  if (input.metadataPublic !== undefined) {
    payload.metadata_public = input.metadataPublic;
  }
  return payload as OryCreateIdentityPayload;
}
