/**
 * Unit tests for `LoggerAuditSink`.
 *
 * Covers:
 *   - redacts event before delivering to the underlying logger (default mode)
 *   - `{ redactionMode: 'raw' }` opts out of redaction (dev-only)
 *   - success / permission.grant / session.revoke events log at `info`
 *   - failure / deny events log at `warn`
 *   - works with or without an explicit logger (uses NestJS Logger by default)
 */
import { Logger } from '@nestjs/common';
import type { IamAuditEvent } from '../../../src/dto';
import { LoggerAuditSink, Redactor } from '../../../src/audit';

function baseEvent(
  overrides: Partial<IamAuditEvent> & { event: string; result: IamAuditEvent['result'] },
): IamAuditEvent {
  return {
    timestamp: '2030-01-01T00:00:00.000Z',
    tenant: 'demo',
    attributes: {},
    ...overrides,
  };
}

describe('LoggerAuditSink', () => {
  let logger: Logger;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    logger = new Logger('audit-test');
    logSpy = jest.spyOn(logger, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('redacts the event before passing it to the logger (default mode)', async () => {
    const sink = new LoggerAuditSink(new Redactor(), logger);
    const evt = baseEvent({
      event: 'auth.success',
      result: 'success',
      attributes: {
        headers: {
          authorization:
            'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.abcDEFghiJKLmnoPQRstuVWXyz-_09',
        },
        raw: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.abcDEFghiJKLmnoPQRstuVWXyz-_09',
      },
    });
    await sink.emit(evt);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const payload = logSpy.mock.calls[0][0];
    const serialized = JSON.stringify(payload);
    // no JWT should reach the logger
    expect(serialized).not.toMatch(/eyJ[A-Za-z0-9_-]+\./);
    // the authorization field must be redacted
    expect(serialized).toMatch(/\[redacted\]/);
  });

  it('does not mutate the original event', async () => {
    const sink = new LoggerAuditSink(new Redactor(), logger);
    const evt = baseEvent({
      event: 'auth.success',
      result: 'success',
      attributes: { authorization: 'Bearer abc' },
    });
    const snapshot = JSON.parse(JSON.stringify(evt));
    await sink.emit(evt);
    expect(evt).toEqual(snapshot);
  });

  it('opts out of redaction when redactionMode is "raw"', async () => {
    const sink = new LoggerAuditSink(new Redactor(), logger, {
      redactionMode: 'raw',
    });
    const evt = baseEvent({
      event: 'auth.success',
      result: 'success',
      attributes: { authorization: 'Bearer RAW-TOKEN-123' },
    });
    await sink.emit(evt);

    const payload = logSpy.mock.calls[0][0];
    const serialized = JSON.stringify(payload);
    expect(serialized).toMatch(/Bearer RAW-TOKEN-123/);
    expect(serialized).not.toMatch(/\[redacted\]/);
  });

  it('logs at info for result=success', async () => {
    const sink = new LoggerAuditSink(new Redactor(), logger);
    await sink.emit(baseEvent({ event: 'auth.success', result: 'success' }));
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('logs at info for authz.permission.grant', async () => {
    const sink = new LoggerAuditSink(new Redactor(), logger);
    await sink.emit(
      baseEvent({ event: 'authz.permission.grant', result: 'success' }),
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('logs at info for authz.session.revoke', async () => {
    const sink = new LoggerAuditSink(new Redactor(), logger);
    await sink.emit(
      baseEvent({ event: 'authz.session.revoke', result: 'success' }),
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('logs at warn for result=failure', async () => {
    const sink = new LoggerAuditSink(new Redactor(), logger);
    await sink.emit(
      baseEvent({ event: 'auth.failure.expired', result: 'failure' }),
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('logs at warn for result=deny', async () => {
    const sink = new LoggerAuditSink(new Redactor(), logger);
    await sink.emit(
      baseEvent({ event: 'authz.permission.deny', result: 'deny' }),
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('defaults to an internal Logger when none is provided', async () => {
    // Intercept any Logger instance's log/warn so the default-path emission
    // does not throw and is verifiably routed to a NestJS Logger.
    const protoLog = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    const protoWarn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    const sink = new LoggerAuditSink(new Redactor());
    await sink.emit(baseEvent({ event: 'auth.success', result: 'success' }));
    expect(protoLog).toHaveBeenCalled();
    expect(protoWarn).not.toHaveBeenCalled();
  });

  it('implements AuditSink.emit returning void/Promise<void>', async () => {
    const sink = new LoggerAuditSink(new Redactor(), logger);
    const ret: unknown = sink.emit(
      baseEvent({ event: 'auth.success', result: 'success' }),
    );
    // Either void or a thenable is acceptable; if thenable, await it.
    if (
      ret !== undefined &&
      typeof (ret as Promise<void>).then === 'function'
    ) {
      await ret;
    }
    expect(logSpy).toHaveBeenCalled();
  });
});
