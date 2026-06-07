/**
 * key-encryption.ts — AES-256-GCM encryption for API keys using scrypt KDF.
 *
 * Uses Node.js built-in crypto module (no external dependencies).
 * Format: enc:scrypt:<salt>:<iv>:<ciphertext>:<authTag>
 */

import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const KEY_LEN = 32;
const SALT_LEN = 16;
const IV_LEN = 12;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 };

/**
 * Encrypt a plaintext API key using AES-256-GCM with scrypt KDF.
 * Returns format: "enc:scrypt:<salt>:<iv>:<ciphertext>:<authTag>"
 */
export function encryptKey(plaintext: string, masterKey: string): string {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = scryptSync(masterKey, salt, KEY_LEN, SCRYPT_OPTS);

  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `enc:scrypt:${salt.toString('base64')}:${iv.toString('base64')}:${encrypted.toString('base64')}:${authTag.toString('base64')}`;
}

/**
 * Decrypt an encrypted API key.
 * Input format: "enc:scrypt:<salt>:<iv>:<ciphertext>:<authTag>"
 * Throws clear error if decryption fails (wrong key or corrupted data).
 */
export function decryptKey(encrypted: string, masterKey: string): string {
  const parts = encrypted.split(':');
  if (parts.length !== 6 || parts[0] !== 'enc' || parts[1] !== 'scrypt') {
    throw new Error('Invalid encrypted key format');
  }

  const [, , saltB64, ivB64, ciphertextB64, authTagB64] = parts;

  try {
    const salt = Buffer.from(saltB64, 'base64');
    const iv = Buffer.from(ivB64, 'base64');
    const ciphertext = Buffer.from(ciphertextB64, 'base64');
    const authTag = Buffer.from(authTagB64, 'base64');

    const key = scryptSync(masterKey, salt, KEY_LEN, SCRYPT_OPTS);
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to decrypt key: ${message}`);
  }
}

/**
 * Check if a key value is encrypted (starts with "enc:scrypt:").
 */
export function isEncryptedKey(value: string): boolean {
  return value.startsWith('enc:scrypt:');
}
