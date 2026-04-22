/**
 * Integration: live Keto — permission grant/check/expand/checkBatch/revoke.
 */
import { maybeMakeFullStackApp, type FullStackHandle } from '../harness/ory-app';

describe('Keto — live integration', () => {
  let stack: FullStackHandle | null;

  beforeAll(async () => {
    stack = await maybeMakeFullStackApp();
  });

  afterAll(async () => {
    if (stack) await stack.close();
  });

  it('grant → check (pos + neg) → revoke', async () => {
    if (!stack) return;
    const { permissions } = stack;

    const obj = `listings:${Date.now()}`;
    const tuple = {
      namespace: 'listings',
      object: obj,
      relation: 'owner',
      subject: 'user:alice',
      tenant: 'demo',
    };
    await permissions.forTenant('demo').grant(tuple);

    expect(await permissions.forTenant('demo').check(tuple)).toBe(true);
    expect(
      await permissions.forTenant('demo').check({ ...tuple, subject: 'user:bob' }),
    ).toBe(false);

    await permissions.forTenant('demo').revoke(tuple);
    expect(await permissions.forTenant('demo').check(tuple)).toBe(false);
  });

  it('checkBatch returns per-tuple results', async () => {
    if (!stack) return;
    const { permissions } = stack;
    const obj = `listings:batch-${Date.now()}`;
    const alice = {
      namespace: 'listings',
      object: obj,
      relation: 'owner',
      subject: 'user:alice',
      tenant: 'demo',
    };
    await permissions.forTenant('demo').grant(alice);

    const out = await permissions.forTenant('demo').checkBatch([
      alice,
      { ...alice, subject: 'user:bob' },
    ]);
    expect(out[0].allowed).toBe(true);
    expect(out[1].allowed).toBe(false);

    await permissions.forTenant('demo').revoke(alice);
  });

  it('expand returns a tree for a populated namespace', async () => {
    if (!stack) return;
    const { permissions } = stack;
    const obj = `listings:expand-${Date.now()}`;
    const grant = {
      namespace: 'listings',
      object: obj,
      relation: 'owner',
      subject: 'user:alice',
      tenant: 'demo',
    };
    await permissions.forTenant('demo').grant(grant);

    const tree = await permissions.forTenant('demo').expand({
      namespace: 'listings',
      object: obj,
      relation: 'owner',
      maxDepth: 3,
    });
    expect(tree.root).toBeDefined();

    await permissions.forTenant('demo').revoke(grant);
  });
});
