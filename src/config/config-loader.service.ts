/**
 * `ConfigLoader` — NestJS-injectable service that validates and freezes the
 * `IamOptions` passed to `IamModule.forRoot[Async]`.
 *
 * Contract:
 *   - Input is `unknown` — the consumer's options go through the full zod
 *     pipeline, not a cast. No trust in caller types.
 *   - Validation failures throw `IamConfigurationError` with an aggregated,
 *     human-readable issue list.
 *   - The returned object is deep-frozen, so downstream services can safely
 *     share references without defensive copying.
 */
import { Injectable } from '@nestjs/common';

import { deepFreeze } from '../dto/freeze';
import { IamConfigurationError } from '../errors';
import { IamOptionsSchema } from './config.schema';
import type { ValidatedIamOptions } from './config.types';
import { formatZodError } from './format-zod-error';

@Injectable()
export class ConfigLoader {
  /**
   * Validate `input` against `IamOptionsSchema` and return a deep-frozen,
   * defaults-applied result. Throws `IamConfigurationError` on failure with
   * the aggregated zod issue list embedded in the error message.
   */
  public load(input: unknown): ValidatedIamOptions {
    const parsed = IamOptionsSchema.safeParse(input);
    if (!parsed.success) {
      throw new IamConfigurationError({
        message: `Invalid ory-nestjs config:\n${formatZodError(parsed.error)}`,
      });
    }

    // `auditSink` and `sessionCache` are OPAQUE consumer references — a
    // NestJS Provider, a class constructor, or a live backend instance
    // (e.g. InMemorySessionCache, CapturingAuditSink). deep-freezing them
    // would freeze the backend's internal state (Map<>, Array<>, ...) and
    // break subsequent writes during normal operation. Strip them out,
    // deep-freeze the pure-data portion of the validated options, then
    // reattach the consumer references on the shallow-frozen wrapper so
    // downstream code still sees a structurally immutable config.
    const { auditSink, sessionCache, ...dataOnly } = parsed.data as {
      auditSink?: unknown;
      sessionCache?: unknown;
    } & Record<string, unknown>;
    deepFreeze(dataOnly);
    const result: Record<string, unknown> = { ...dataOnly };
    if (auditSink !== undefined) result.auditSink = auditSink;
    if (sessionCache !== undefined) result.sessionCache = sessionCache;
    return Object.freeze(result) as unknown as ValidatedIamOptions;
  }
}
