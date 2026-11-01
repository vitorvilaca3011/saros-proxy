/**
 * secrets-redaction.test.ts — Prove the passphrase/envelope never reaches a
 * log line: pattern redaction, pino redact paths, boot line and error text.
 */
import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import pino from 'pino';
import { LOG_REDACT_PATHS } from '../src/logger.js';
import { redactErrorMessage, redactSecrets } from '../src/log-redact.js';
import { encryptValue, decryptValue } from '../src/secrets/envelope.js';
import { NO_PASSPHRASE_MESSAGE, decryptFailureMessage } from '../src/secrets/source.js';

const PASSPHRASE = 'redaction-test-passphrase-fixture';
const PLAINTEXT = 'sk-redaction-fixture-key-long-enough-0001';

function captureLogger(): { logger: pino.Logger; output: () => string } {
  let buffer = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      buffer += String(chunk);
      callback();
    },
  });
  const logger = pino(
    { redact: { paths: [...LOG_REDACT_PATHS], censor: '[redacted]' } },
    stream,
  );
  return { logger, output: () => buffer };
}

describe('log redaction', () => {
  it('strips v1 and legacy envelopes from free-form text', () => {
    const envelope = encryptValue(PLAINTEXT, PASSPHRASE, 'label');
    const text = `key=${envelope} legacy=enc:scrypt:c2FsdA==:aXY=:Y3Q=:dGFn`;
    const redacted = redactSecrets(text);
    expect(redacted).not.toContain(envelope);
    expect(redacted).not.toContain('enc:scrypt:');
    expect(redacted).toContain('[redacted-envelope]');
  });

  it('strips passphrase assignments from free-form text', () => {
    const redacted = redactSecrets(
      `SAROS_PASSPHRASE=${PASSPHRASE} OPENCODE_GO_ENCRYPTION_KEY=${PASSPHRASE}`,
    );
    expect(redacted).not.toContain(PASSPHRASE);
    expect(redacted).toContain('SAROS_PASSPHRASE=[redacted]');
    expect(redacted).toContain('OPENCODE_GO_ENCRYPTION_KEY=[redacted]');
  });

  it('redacts structured passphrase fields at the logger', () => {
    const { logger, output } = captureLogger();
    logger.info(
      {
        passphrase: PASSPHRASE,
        secret: PASSPHRASE,
        secretValue: PASSPHRASE,
        apiKey: PLAINTEXT,
        SAROS_PASSPHRASE: PASSPHRASE,
        note: 'ok',
      },
      'boot',
    );
    const line = output();
    expect(line).toContain('[redacted]');
    expect(line).toContain('"note":"ok"');
    expect(line).not.toContain(PASSPHRASE);
    expect(line).not.toContain(PLAINTEXT);
  });

  it('keeps only a redacted first line for error text', () => {
    expect(
      redactErrorMessage(new Error('Missing closing quote at line 4:\n  key: sk-leak-0000\n^')),
    ).toBe('Missing closing quote at line 4:');
    expect(redactErrorMessage('sk-string-error-0000')).toBe('[redacted-key]');
    expect(redactErrorMessage(new Error('first sk-leak-0000\nsecond'))).toBe(
      'first [redacted-key]',
    );
  });

  it('keeps error and boot text free of plaintext, passphrase and ciphertext', () => {
    const envelope = encryptValue(PLAINTEXT, PASSPHRASE, 'label');
    const wrong = decryptValue(envelope, 'wrong-fixture-passphrase', 'label');
    const messages = [
      NO_PASSPHRASE_MESSAGE,
      wrong.ok ? '' : decryptFailureMessage('label', wrong.error.message),
    ].join('\n');
    for (const secret of [PASSPHRASE, PLAINTEXT, envelope]) {
      expect(messages).not.toContain(secret);
    }
  });
});
