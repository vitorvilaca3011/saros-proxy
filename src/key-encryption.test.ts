import { describe, it, expect } from 'vitest';
import { encryptKey, decryptKey, isEncryptedKey } from './key-encryption.js';

describe('key-encryption', () => {
  const masterKey = 'test-master-key-that-is-at-least-16-chars';
  const plaintext = 'sk-test-api-key-that-is-valid-and-long-enough';

  describe('encryptKey', () => {
    it('returns encrypted string with correct format', () => {
      const encrypted = encryptKey(plaintext, masterKey);
      expect(encrypted).toMatch(/^enc:scrypt:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    });

    it('produces different ciphertexts for same plaintext (random IV/salt)', () => {
      const enc1 = encryptKey(plaintext, masterKey);
      const enc2 = encryptKey(plaintext, masterKey);
      expect(enc1).not.toBe(enc2);
    });
  });

  describe('decryptKey', () => {
    it('round-trip: encrypt then decrypt returns original', () => {
      const encrypted = encryptKey(plaintext, masterKey);
      const decrypted = decryptKey(encrypted, masterKey);
      expect(decrypted).toBe(plaintext);
    });

    it('wrong master key throws clear error', () => {
      const encrypted = encryptKey(plaintext, masterKey);
      expect(() => decryptKey(encrypted, 'wrong-master-key-that-is-also-long')).toThrow('Failed to decrypt');
    });

    it('invalid format throws clear error', () => {
      expect(() => decryptKey('not-encrypted', masterKey)).toThrow('Invalid encrypted key format');
      expect(() => decryptKey('enc:wrong:salt:iv:ct:tag', masterKey)).toThrow('Invalid encrypted key format');
    });

    it('corrupted data throws clear error', () => {
      const encrypted = encryptKey(plaintext, masterKey);
      const corrupted = encrypted.slice(0, -5) + 'XXXXX'; // corrupt auth tag
      expect(() => decryptKey(corrupted, masterKey)).toThrow('Failed to decrypt');
    });
  });

  describe('isEncryptedKey', () => {
    it('returns true for encrypted keys', () => {
      const encrypted = encryptKey(plaintext, masterKey);
      expect(isEncryptedKey(encrypted)).toBe(true);
    });

    it('returns false for plaintext keys', () => {
      expect(isEncryptedKey(plaintext)).toBe(false);
      expect(isEncryptedKey('sk-plaintext-key')).toBe(false);
    });
  });
});
