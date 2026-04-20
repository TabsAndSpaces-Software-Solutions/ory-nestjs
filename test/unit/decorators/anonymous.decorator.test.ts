/**
 * `@Anonymous()` — method-level opt-out with the same public-access semantics
 * as `@Public()`, but intentionally distinct so a guard can tell the two
 * apart (e.g. `Public` = never authenticate; `Anonymous` = authenticate if a
 * session exists but do not require one).
 *
 * Precedence order documented with the guard: when stacking class `@Public`
 * with method `@Anonymous`, `Reflector.getAllAndOverride([method, class])`
 * for `IS_ANONYMOUS_KEY` returns the method-level value — the method wins.
 */
import 'reflect-metadata';
import { Reflector } from '@nestjs/core';

import { Anonymous } from '../../../src/decorators/anonymous.decorator';
import { Public } from '../../../src/decorators/public.decorator';
import {
  IS_ANONYMOUS_KEY,
  IS_PUBLIC_KEY,
} from '../../../src/decorators/metadata-keys';

describe('@Anonymous()', () => {
  it('stamps IS_ANONYMOUS_KEY = true on a method', () => {
    class Ctrl {
      @Anonymous()
      handler(): void {
        return;
      }
    }

    const value = Reflect.getMetadata(
      IS_ANONYMOUS_KEY,
      Ctrl.prototype.handler,
    );
    expect(value).toBe(true);
  });

  it('method-level @Anonymous coexists with class-level @Public — both keys are set on their respective targets', () => {
    @Public()
    class Ctrl {
      @Anonymous()
      handler(): void {
        return;
      }
    }

    const reflector = new Reflector();

    // Class carries IS_PUBLIC_KEY.
    expect(
      reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
        Ctrl.prototype.handler,
        Ctrl,
      ]),
    ).toBe(true);

    // Method carries IS_ANONYMOUS_KEY; method wins in the override order.
    expect(
      reflector.getAllAndOverride<boolean>(IS_ANONYMOUS_KEY, [
        Ctrl.prototype.handler,
        Ctrl,
      ]),
    ).toBe(true);
  });
});
