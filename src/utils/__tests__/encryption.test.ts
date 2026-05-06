import { describe, it, expect, afterEach, vi } from 'vitest';
import { encryptApiKey, decryptApiKey, validateEncryptionKey } from '../encryption';

const ORIG_ENV = { ...process.env };

describe('encryption', () => {
  afterEach(() => {
    process.env = { ...ORIG_ENV };
    vi.restoreAllMocks();
  });

  describe('encrypt/decrypt round-trip', () => {
    it('returns the same plaintext after encrypt+decrypt', () => {
      const plaintext = 'super-secret-token-1234567890';
      const ciphertext = encryptApiKey(plaintext);
      expect(decryptApiKey(ciphertext)).toBe(plaintext);
    });

    it('produces different ciphertext on each call (non-deterministic IV)', () => {
      const plaintext = 'same-input';
      const c1 = encryptApiKey(plaintext);
      const c2 = encryptApiKey(plaintext);
      expect(c1).not.toBe(c2);
      expect(decryptApiKey(c1)).toBe(plaintext);
      expect(decryptApiKey(c2)).toBe(plaintext);
    });

    it('throws on tampered ciphertext (auth tag mismatch)', () => {
      const ct = encryptApiKey('hello');
      // Flip a byte in the encrypted payload (after IV+authTag = first 64 chars)
      const tampered = ct.slice(0, 64) + (ct[64] === '0' ? '1' : '0') + ct.slice(65);
      expect(() => decryptApiKey(tampered)).toThrow(/Failed to decrypt/);
    });
  });

  describe('validateEncryptionKey', () => {
    it('throws in production when ENCRYPTION_KEY is unset', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.ENCRYPTION_KEY;
      expect(() => validateEncryptionKey()).toThrow(/unset or using the public default/);
    });

    it('throws in production when ENCRYPTION_KEY equals the public default', () => {
      process.env.NODE_ENV = 'production';
      process.env.ENCRYPTION_KEY = 'default-insecure-key-change-in-production';
      expect(() => validateEncryptionKey()).toThrow(/unset or using the public default/);
    });

    it('warns (does not throw) in development when key is unset', () => {
      process.env.NODE_ENV = 'development';
      delete process.env.ENCRYPTION_KEY;
      // First-time warning from a previous test could have been cached;
      // spyOn after deleting env to capture the fresh call.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(() => validateEncryptionKey()).not.toThrow();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('publicly-known key'));
    });

    it('does not warn or throw in production with a strong key', () => {
      process.env.NODE_ENV = 'production';
      process.env.ENCRYPTION_KEY = 'a'.repeat(64);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(() => validateEncryptionKey()).not.toThrow();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('warns about short keys (< 16 chars) in dev but does not throw', () => {
      process.env.NODE_ENV = 'development';
      process.env.ENCRYPTION_KEY = 'short';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(() => validateEncryptionKey()).not.toThrow();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('only 5 chars'));
    });

    it('test environment is silent and does not throw', () => {
      process.env.NODE_ENV = 'test';
      delete process.env.ENCRYPTION_KEY;
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(() => validateEncryptionKey()).not.toThrow();
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});
