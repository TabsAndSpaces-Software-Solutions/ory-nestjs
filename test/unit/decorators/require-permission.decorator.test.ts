/**
 * `@RequirePermission({ namespace, relation, object })` — gate a handler
 * behind a Keto-style relation check. `object` may be either a literal
 * string (static resource) or a resolver `(req) => string | undefined`
 * (extract from path params, body, etc.).
 *
 * Validation is eager: `namespace` and `relation` must be non-empty strings,
 * and `object` must be either a non-empty string or a function.
 */
import 'reflect-metadata';

import { RequirePermission } from '../../../src/decorators/require-permission.decorator';
import { REQUIRED_PERMISSION_KEY } from '../../../src/decorators/metadata-keys';

describe('@RequirePermission()', () => {
  it('stamps the spec on a method (string object)', () => {
    const spec = { namespace: 'listings', relation: 'view', object: 'l-1' };
    class Ctrl {
      @RequirePermission(spec)
      handler(): void {
        return;
      }
    }
    expect(
      Reflect.getMetadata(REQUIRED_PERMISSION_KEY, Ctrl.prototype.handler),
    ).toEqual(spec);
  });

  it('accepts a resolver function for object', () => {
    const resolver = (req: unknown): string | undefined =>
      (req as { params: { id: string } }).params.id;
    class Ctrl {
      @RequirePermission({
        namespace: 'listings',
        relation: 'edit',
        object: resolver,
      })
      handler(): void {
        return;
      }
    }
    const stored = Reflect.getMetadata(
      REQUIRED_PERMISSION_KEY,
      Ctrl.prototype.handler,
    ) as {
      namespace: string;
      relation: string;
      object: (req: unknown) => string | undefined;
    };
    expect(stored.namespace).toBe('listings');
    expect(stored.relation).toBe('edit');
    expect(typeof stored.object).toBe('function');
    expect(stored.object({ params: { id: 'abc' } })).toBe('abc');
  });

  it('is valid on a class', () => {
    @RequirePermission({ namespace: 'ns', relation: 'rel', object: 'o' })
    class Ctrl {}
    expect(Reflect.getMetadata(REQUIRED_PERMISSION_KEY, Ctrl)).toEqual({
      namespace: 'ns',
      relation: 'rel',
      object: 'o',
    });
  });

  it('throws when namespace is empty', () => {
    expect(() =>
      RequirePermission({ namespace: '', relation: 'view', object: 'x' }),
    ).toThrow(/namespace/);
  });

  it('throws when relation is empty', () => {
    expect(() =>
      RequirePermission({ namespace: 'ns', relation: '', object: 'x' }),
    ).toThrow(/relation/);
  });

  it('throws when namespace is not a string', () => {
    expect(() =>
      RequirePermission({
        namespace: 123 as unknown as string,
        relation: 'view',
        object: 'x',
      }),
    ).toThrow(/namespace/);
  });

  it('throws when relation is not a string', () => {
    expect(() =>
      RequirePermission({
        namespace: 'ns',
        relation: {} as unknown as string,
        object: 'x',
      }),
    ).toThrow(/relation/);
  });

  it('throws when object is neither a string nor a function', () => {
    expect(() =>
      RequirePermission({
        namespace: 'ns',
        relation: 'rel',
        object: 42 as unknown as string,
      }),
    ).toThrow(/object/);
    expect(() =>
      RequirePermission({
        namespace: 'ns',
        relation: 'rel',
        object: undefined as unknown as string,
      }),
    ).toThrow(/object/);
    expect(() =>
      RequirePermission({
        namespace: 'ns',
        relation: 'rel',
        object: null as unknown as string,
      }),
    ).toThrow(/object/);
  });

  it('throws when object is an empty string', () => {
    expect(() =>
      RequirePermission({ namespace: 'ns', relation: 'rel', object: '' }),
    ).toThrow(/object/);
  });

  it('throws when the spec itself is missing', () => {
    expect(() =>
      (RequirePermission as unknown as (x: unknown) => unknown)(undefined),
    ).toThrow(/@RequirePermission/);
  });
});
