/**
 * secrets-envelope.test.ts — enc:v1 envelope: round trip, typed failures,
 * AAD label binding, malformed input. Error messages/assertions never embed
 * the passphrase or the plaintext.
 */
import { describe, it, expect } from 'vitest';
import { Buffer } from 'node:buffer';
import {
  ENVELOPE_PREFIX,
  EnvelopeFailure,
  decryptValue,
  encryptValue,
  isEnvelope,
} from '../src/secrets/envelope.js';

const PASSPHRASE = 'test-passphrase-fixture-not-a-real-secret';
const OTHER_PASSPHRASE = 'another-passphrase-fixture';
const LABEL = 'fixture-label';
const PLAINTEXT = 'sk-fixture-key-for-envelope-tests-000001';

describe('enc:v1 envelope', () => {
  it('round-trips a value and uses the documented format', () => {
    const envelope = encryptValue(PLAINTEXT, PASSPHRASE, LABEL);
    expect(envelope.startsWith(ENVELOPE_PREFIX)).toBe(true);
    expect(envelope).toMatch(/^enc:v1:[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/);
    expect(isEnvelope(envelope)).toBe(true);

    const result = decryptValue(envelope, PASSPHRASE, LABEL);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(PLAINTEXT);
  });

  it('uses a fresh salt and nonce per encryption', () => {
    expect(encryptValue(PLAINTEXT, PASSPHRASE, LABEL)).not.toBe(
      encryptValue(PLAINTEXT, PASSPHRASE, LABEL),
    );
  });

  it('rejects a wrong passphrase with a typed error and no secret material', () => {
    const envelope = encryptValue(PLAINTEXT, PASSPHRASE, LABEL);
    const result = decryptValue(envelope, OTHER_PASSPHRASE, LABEL);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('wrong-passphrase');
      expect(result.error.message).not.toContain(PASSPHRASE);
      expect(result.error.message).not.toContain(OTHER_PASSPHRASE);
      expect(result.error.message).not.toContain(PLAINTEXT);
    }
  });

  it('rejects a ciphertext swapped onto a different label (AAD binding)', () => {
    const envelope = encryptValue(PLAINTEXT, PASSPHRASE, LABEL);
    const result = decryptValue(envelope, PASSPHRASE, 'other-label');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('wrong-passphrase');
  });

  it('rejects a tampered ciphertext', () => {
    const envelope = encryptValue(PLAINTEXT, PASSPHRASE, LABEL);
    const tampered = envelope.slice(0, -2) + (envelope.endsWith('AA') ? 'BB' : 'AA');
    const result = decryptValue(tampered, PASSPHRASE, LABEL);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('wrong-passphrase');
  });

  it('rejects an empty passphrase for encryption', () => {
    expect(() => encryptValue(PLAINTEXT, '', LABEL)).toThrow(EnvelopeFailure);
    try {
      encryptValue(PLAINTEXT, '', LABEL);
    } catch (err) {
      expect(err).toBeInstanceOf(EnvelopeFailure);
      expect((err as EnvelopeFailure).code).toBe('empty-passphrase');
    }
  });

  it('returns a typed error for an empty passphrase on decrypt', () => {
    const envelope = encryptValue(PLAINTEXT, PASSPHRASE, LABEL);
    const result = decryptValue(envelope, '', LABEL);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('empty-passphrase');
  });

  it('returns unsupported-version for another enc: format', () => {
    const legacy = decryptValue('enc:scrypt:a:b:c:d', PASSPHRASE, LABEL);
    expect(legacy.ok).toBe(false);
    if (!legacy.ok) expect(legacy.error.code).toBe('unsupported-version');

    const future = decryptValue('enc:v2:aaaa', PASSPHRASE, LABEL);
    expect(future.ok).toBe(false);
    if (!future.ok) expect(future.error.code).toBe('unsupported-version');
  });

  it('returns corrupt for non-enc and non-string values', () => {
    const plain = decryptValue('sk-plain-value', PASSPHRASE, LABEL);
    expect(plain.ok).toBe(false);
    if (!plain.ok) expect(plain.error.code).toBe('corrupt');

    const nonString = decryptValue(null as unknown as string, PASSPHRASE, LABEL);
    expect(nonString.ok).toBe(false);
    if (!nonString.ok) expect(nonString.error.code).toBe('corrupt');
  });

  it('returns corrupt for truncated, non-base64 and wrong-sized parts', () => {
    const three = decryptValue('enc:v1:AAAA.BBBB.CCCC', PASSPHRASE, LABEL);
    expect(three.ok).toBe(false);
    if (!three.ok) expect(three.error.code).toBe('corrupt');

    const five = decryptValue('enc:v1:AAAA.BBBB.CCCC.DDDD.EEEE', PASSPHRASE, LABEL);
    expect(five.ok).toBe(false);
    if (!five.ok) expect(five.error.code).toBe('corrupt');

    const badBase64 = decryptValue('enc:v1:!!!!.BBBB.CCCC.DDDD', PASSPHRASE, LABEL);
    expect(badBase64.ok).toBe(false);
    if (!badBase64.ok) expect(badBase64.error.code).toBe('corrupt');

    const badLength = decryptValue(
      `enc:v1:${'A'.repeat(5)}.BBBB.CCCC.DDDD`,
      PASSPHRASE,
      LABEL,
    );
    expect(badLength.ok).toBe(false);
    if (!badLength.ok) expect(badLength.error.code).toBe('corrupt');

    // Valid base64, wrong decoded lengths (8-byte salt, 8-byte nonce/tag).
    const shortSalt = Buffer.alloc(8).toString('base64');
    const shortNonce = Buffer.alloc(8).toString('base64');
    const wrongSizes = decryptValue(
      `enc:v1:${shortSalt}.${shortNonce}.${shortNonce}.${shortNonce}`,
      PASSPHRASE,
      LABEL,
    );
    expect(wrongSizes.ok).toBe(false);
    if (!wrongSizes.ok) expect(wrongSizes.error.code).toBe('corrupt');
  });

  it('does not treat other enc: prefixes as v1 envelopes', () => {
    expect(isEnvelope('enc:scrypt:a:b:c:d')).toBe(false);
    expect(isEnvelope('enc:v2:x')).toBe(false);
    expect(isEnvelope(undefined)).toBe(false);
    expect(isEnvelope(123)).toBe(false);
  });
});
