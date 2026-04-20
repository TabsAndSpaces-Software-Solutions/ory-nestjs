/**
 * Unit tests for the HMAC-SHA256 envelope signature verifier used by
 * OathkeeperTransport.
 */
import * as crypto from 'crypto';
import { verifyEnvelopeSignature } from '../../../src/transport/signature-verify';

function signBase64(envelope: string, key: string): string {
  return crypto.createHmac('sha256', key).update(envelope).digest('base64');
}

describe('verifyEnvelopeSignature', () => {
  const envelope = '{"id":"u_1","schemaId":"default","state":"active"}';
  const primaryKey = 'primary-secret';
  const secondaryKey = 'secondary-secret';

  it('returns { ok: true, matchedKeyIndex: 0 } when the signature matches the first key', () => {
    const sig = signBase64(envelope, primaryKey);
    const result = verifyEnvelopeSignature(envelope, sig, [primaryKey]);
    expect(result).toEqual({ ok: true, matchedKeyIndex: 0 });
  });

  it('returns { ok: true, matchedKeyIndex: 1 } when signature matches a secondary key (rotation)', () => {
    const sig = signBase64(envelope, secondaryKey);
    const result = verifyEnvelopeSignature(envelope, sig, [primaryKey, secondaryKey]);
    expect(result).toEqual({ ok: true, matchedKeyIndex: 1 });
  });

  it('returns { ok: false } when no key matches', () => {
    const sig = signBase64(envelope, 'other-key');
    const result = verifyEnvelopeSignature(envelope, sig, [primaryKey, secondaryKey]);
    expect(result).toEqual({ ok: false });
  });

  it('returns { ok: false } when the signature is empty', () => {
    const result = verifyEnvelopeSignature(envelope, '', [primaryKey]);
    expect(result).toEqual({ ok: false });
  });

  it('returns { ok: false } when the keys list is empty', () => {
    const sig = signBase64(envelope, primaryKey);
    const result = verifyEnvelopeSignature(envelope, sig, []);
    expect(result).toEqual({ ok: false });
  });

  it('returns { ok: false } when the signature is syntactically invalid base64/hex junk', () => {
    const result = verifyEnvelopeSignature(envelope, '!!!not-a-signature!!!', [primaryKey]);
    expect(result).toEqual({ ok: false });
  });

  it('does not throw on malformed signatures', () => {
    expect(() =>
      verifyEnvelopeSignature(envelope, '\u0000binary', [primaryKey]),
    ).not.toThrow();
  });
});
