/**
 * `@Public()` — opts a handler (or an entire controller) out of the
 * authentication guard. It is a pure metadata attacher: no logging, no I/O.
 */
import 'reflect-metadata';
import { Reflector } from '@nestjs/core';

import { Public } from '../../../src/decorators/public.decorator';
import { IS_PUBLIC_KEY } from '../../../src/decorators/metadata-keys';

describe('@Public()', () => {
  it('stamps IS_PUBLIC_KEY = true on a method', () => {
    class Ctrl {
      @Public()
      handler(): void {
        return;
      }
    }

    const value = Reflect.getMetadata(IS_PUBLIC_KEY, Ctrl.prototype.handler);
    expect(value).toBe(true);
  });

  it('stamps IS_PUBLIC_KEY = true on a class', () => {
    @Public()
    class Ctrl {}

    const value = Reflect.getMetadata(IS_PUBLIC_KEY, Ctrl);
    expect(value).toBe(true);
  });

  it('is readable via Reflector.getAllAndOverride (method overrides class)', () => {
    @Public()
    class Ctrl {
      handler(): void {
        return;
      }
    }

    const reflector = new Reflector();
    const value = reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      Ctrl.prototype.handler,
      Ctrl,
    ]);
    expect(value).toBe(true);
  });
});
