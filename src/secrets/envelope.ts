/**
 * envelope.ts — Passphrase-based envelope for API keys at rest.
 *
 * Format: `enc:v1:<b64salt>.<b64nonce>.<b64tag>.<b64ciphertext>`
 *   scrypt(N=2^15, r=8, p=1, 32 bytes) → AES-256-GCM.
 *
 * The AAD binds the version and the key label, so a ciphertext copied from one
 * key entry onto another (or edited to look like another version) fails the
 * authentication tag instead of silently decrypting to the wrong credential.
 *
 * Decryption never throws: it returns a typed error whose message contains no
 * plaintext and no passphrase. The caller decides how to report it.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

export const ENVELOPE_PREFIX = 'enc:v1:';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
/** N=32768, r=8 needs 32 MiB for the scrypt buffer plus overhead. */
const SCRYPT_OPTIONS = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export type EnvelopeErrorCode =
  | 'unsupported-version'
  | 'corrupt'
  | 'wrong-passphrase'
  | 'empty-passphrase';

export interface EnvelopeError {
  code: EnvelopeErrorCode;
  message: string;
}

export type DecryptResult = { ok: true; value: string } | { ok: false; error: EnvelopeError };

/** Typed failure raised by {@link encryptValue}; never carries key material. */
export class EnvelopeFailure extends Error {
  constructor(
    readonly code: EnvelopeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EnvelopeFailure';
  }
}

/** True when a config value uses the current envelope format. */
export function isEnvelope(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(ENVELOPE_PREFIX);
}

/** AAD binds the envelope version and the key label. */
function aad(label: string): Buffer {
  return Buffer.from(`${ENVELOPE_PREFIX}${label}`, 'utf8');
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LENGTH, SCRYPT_OPTIONS);
}

/**
 * Encrypt `plaintext` under `passphrase`, bound to `label`.
 * Throws {@link EnvelopeFailure} on an empty passphrase — never on data.
 */
export function encryptValue(plaintext: string, passphrase: string, label: string): string {
  if (passphrase.length === 0) {
    throw new EnvelopeFailure('empty-passphrase', 'Passphrase must not be empty');
  }

  const salt = randomBytes(SALT_LENGTH);
  const nonce = randomBytes(NONCE_LENGTH);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  cipher.setAAD(aad(label));

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return (
    ENVELOPE_PREFIX +
    [salt, nonce, tag, ciphertext].map((part) => part.toString('base64')).join('.')
  );
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function decodePart(value: string): Buffer | null {
  if (!BASE64.test(value) || value.length % 4 !== 0) return null;
  return Buffer.from(value, 'base64');
}

function corrupt(message: string): DecryptResult {
  return { ok: false, error: { code: 'corrupt', message } };
}

/**
 * Decrypt an envelope. Returns the plaintext or a typed error; never throws
 * for malformed input, a wrong passphrase, or an unknown version.
 */
export function decryptValue(envelope: string, passphrase: string, label: string): DecryptResult {
  if (typeof envelope !== 'string' || !envelope.startsWith('enc:')) {
    return corrupt('Malformed envelope');
  }
  if (!isEnvelope(envelope)) {
    return {
      ok: false,
      error: {
        code: 'unsupported-version',
        message: 'Unsupported envelope version',
      },
    };
  }
  if (passphrase.length === 0) {
    return {
      ok: false,
      error: { code: 'empty-passphrase', message: 'Passphrase must not be empty' },
    };
  }

  const parts = envelope.slice(ENVELOPE_PREFIX.length).split('.');
  if (parts.length !== 4) return corrupt('Malformed envelope');

  const salt = decodePart(parts[0]);
  const nonce = decodePart(parts[1]);
  const tag = decodePart(parts[2]);
  const ciphertext = decodePart(parts[3]);
  if (
    !salt ||
    !nonce ||
    !tag ||
    !ciphertext ||
    salt.length !== SALT_LENGTH ||
    nonce.length !== NONCE_LENGTH ||
    tag.length !== TAG_LENGTH
  ) {
    return corrupt('Malformed envelope');
  }

  try {
    const key = deriveKey(passphrase, salt);
    const decipher = createDecipheriv(ALGORITHM, key, nonce);
    decipher.setAAD(aad(label));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return { ok: true, value: plaintext.toString('utf8') };
  } catch {
    // GCM cannot distinguish a wrong passphrase from a modified ciphertext.
    return {
      ok: false,
      error: {
        code: 'wrong-passphrase',
        message: 'Wrong passphrase or corrupt ciphertext',
      },
    };
  }
}
