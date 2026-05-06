import crypto from 'crypto';

const DEFAULT_KEY = 'default-insecure-key-change-in-production';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || DEFAULT_KEY;
const ALGORITHM = 'aes-256-gcm';

// Ensure key is 32 bytes (256 bits) for AES-256
function getEncryptionKey(): Buffer {
  const hash = crypto.createHash('sha256');
  hash.update(ENCRYPTION_KEY);
  return hash.digest();
}

/**
 * Validates ENCRYPTION_KEY at server startup. Refuses to boot in production
 * when the key is unset or matches the public default — running with the
 * default key reduces "encryption at rest" to obfuscation, since anyone with
 * the codebase can derive the same AES key. Should be called once from the
 * server entry point (src/index.ts), not at module load (would break tests
 * and tooling that import this module without intending to start the server).
 */
export function validateEncryptionKey(): void {
  const isProd = process.env.NODE_ENV === 'production';
  const keyEnv = process.env.ENCRYPTION_KEY;
  const usingDefault = !keyEnv || keyEnv === DEFAULT_KEY;

  if (usingDefault && isProd) {
    throw new Error(
      'ENCRYPTION_KEY is unset or using the public default value in production. ' +
      'Set ENCRYPTION_KEY to a strong random secret (e.g. `openssl rand -hex 32`) ' +
      'in your .env before starting. This key encrypts api_keys_encrypted and ' +
      'oauth_tokens.refresh_token at rest — booting with the default would store ' +
      'long-lived credentials under a publicly-known key.',
    );
  }

  // Stay silent in test runs — fixtures often leave ENCRYPTION_KEY unset and
  // the warning would pollute every test file's output.
  const isTest = process.env.NODE_ENV === 'test';

  if (usingDefault && !isProd && !isTest) {
    // eslint-disable-next-line no-console
    console.warn(
      '[encryption] WARNING: ENCRYPTION_KEY is unset or default. Stored secrets ' +
      '(api_keys, oauth refresh_tokens) are protected by a publicly-known key. ' +
      'OK for local dev; do NOT deploy to production this way.',
    );
  }

  if (keyEnv && !usingDefault && keyEnv.length < 16 && !isTest) {
    // Short keys still work via SHA-256 stretching, but flag weak inputs.
    // eslint-disable-next-line no-console
    console.warn(
      `[encryption] WARNING: ENCRYPTION_KEY is only ${keyEnv.length} chars. ` +
      'Recommend at least 32 hex chars (e.g. `openssl rand -hex 32`).',
    );
  }
}

export function encryptApiKey(apiKey: string): string {
  try {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, getEncryptionKey(), iv);

    let encrypted = cipher.update(apiKey, 'utf-8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    // Combine IV + authTag + encrypted data
    const combined = iv.toString('hex') + authTag.toString('hex') + encrypted;
    return combined;
  } catch (error) {
    throw new Error(`Failed to encrypt API key: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function decryptApiKey(encryptedData: string): string {
  try {
    // Extract IV, authTag, and encrypted data
    const iv = Buffer.from(encryptedData.slice(0, 32), 'hex'); // 16 bytes = 32 hex chars
    const authTag = Buffer.from(encryptedData.slice(32, 64), 'hex'); // 16 bytes = 32 hex chars
    const encrypted = encryptedData.slice(64);

    const decipher = crypto.createDecipheriv(ALGORITHM, getEncryptionKey(), iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, 'hex', 'utf-8');
    decrypted += decipher.final('utf-8');

    return decrypted;
  } catch (error) {
    throw new Error(`Failed to decrypt API key: ${error instanceof Error ? error.message : String(error)}`);
  }
}
