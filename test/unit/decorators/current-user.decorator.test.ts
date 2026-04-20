/**
 * `@CurrentUser()` — param decorator that returns `req.user` without
 * transformation.
 *
 * The `ROUTE_ARGS_METADATA` stored by NestJS records the param factory; we
 * extract it and invoke it with a mocked `ExecutionContext` whose HTTP
 * adapter returns a known request. The factory must return that request's
 * `.user` field verbatim (including `undefined`).
 */
import 'reflect-metadata';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import type { ExecutionContext } from '@nestjs/common';

import { CurrentUser } from '../../../src/decorators/current-user.decorator';

function makeCtx(user: unknown): ExecutionContext {
  const req = { user };
  return {
    switchToHttp: () => ({
      getRequest: <T = unknown>(): T => req as T,
      getResponse: <T = unknown>(): T => ({} as T),
      getNext: <T = unknown>(): T => ({} as T),
    }),
  } as unknown as ExecutionContext;
}

function extractFactory(decorator: ParameterDecorator): (
  data: unknown,
  ctx: ExecutionContext,
) => unknown {
  // Apply the decorator to a probe class/method and read back the stored
  // param metadata. The shape is `{ '<type>:<index>': { index, data,
  // factory, pipes } }` for createParamDecorator-built decorators.
  class Probe {
    handler(_u: unknown): void {
      return;
    }
  }
  decorator(Probe.prototype, 'handler', 0);
  const meta = Reflect.getMetadata(ROUTE_ARGS_METADATA, Probe, 'handler') as Record<
    string,
    { index: number; data: unknown; factory: (d: unknown, c: ExecutionContext) => unknown }
  >;
  const entry = Object.values(meta).find((e) => e.index === 0);
  if (!entry) {
    throw new Error('param metadata not recorded');
  }
  return entry.factory;
}

describe('@CurrentUser()', () => {
  it('returns req.user when present', () => {
    const user = { id: 'abc', tenant: 'customer' };
    const factory = extractFactory(CurrentUser());
    expect(factory(undefined, makeCtx(user))).toBe(user);
  });

  it('returns undefined when req.user is absent', () => {
    const factory = extractFactory(CurrentUser());
    expect(factory(undefined, makeCtx(undefined))).toBeUndefined();
  });

  it('also returns a machine principal verbatim (no transformation)', () => {
    const machine = { kind: 'machine', clientId: 'm-1', scope: [], tenant: 'customer' };
    const factory = extractFactory(CurrentUser());
    expect(factory(undefined, makeCtx(machine))).toBe(machine);
  });
});
