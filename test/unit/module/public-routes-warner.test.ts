/**
 * Unit tests for `PublicRoutesWarner` — the dev-only bootstrap hook that
 * logs a warning listing every `@Public()` handler registered in the Nest
 * container. Keeps developers aware of the auth-bypass surface during
 * pre-prod development; gated out in production by IamModule itself.
 */
import 'reflect-metadata';
import { Controller, Get, Logger, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';

import { Public } from '../../../src/decorators/public.decorator';
import { PublicRoutesWarner } from '../../../src/module/public-routes-warner';

@Controller('alpha')
class AlphaController {
  @Get('/secret')
  secret(): string {
    return 's';
  }

  @Get('/open')
  @Public()
  open(): string {
    return 'o';
  }
}

@Public()
@Controller('beta')
class BetaController {
  @Get()
  all(): string {
    return 'b';
  }
}

@Module({
  imports: [DiscoveryModule],
  controllers: [AlphaController, BetaController],
  providers: [PublicRoutesWarner],
})
class HostModule {}

describe('PublicRoutesWarner', () => {
  it('logs a warning naming each @Public() route at bootstrap', async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    try {
      const app = await Test.createTestingModule({
        imports: [HostModule],
      }).compile();
      await app.init();

      // Expect at least one warn call that mentions both a handler-level
      // and a class-level @Public() entry.
      const calls = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(
        calls.some(
          (msg) =>
            msg.includes('AlphaController.open') &&
            msg.includes('BetaController (class-level)'),
        ),
      ).toBe(true);

      await app.close();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('emits no warning when there are zero @Public() handlers', async () => {
    @Controller()
    class PlainController {
      @Get()
      all(): string {
        return 'x';
      }
    }

    @Module({
      imports: [DiscoveryModule],
      controllers: [PlainController],
      providers: [PublicRoutesWarner],
    })
    class PlainHostModule {}

    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    try {
      const app = await Test.createTestingModule({
        imports: [PlainHostModule],
      }).compile();
      await app.init();

      const publicRelated = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((msg) => msg.includes('@Public()'));
      expect(publicRelated).toHaveLength(0);

      await app.close();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
