import crypto from 'crypto';

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'default-insecure-key-change-in-production';
const ALGORITHM = 'aes-256-gcm';

// Ensure key is 32 bytes (256 bits) for AES-256
function getEncryptionKey(): Buffer {
  const hash = crypto.createHash('sha256');
  hash.update(ENCRYPTION_KEY);
  return hash.digest();
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
