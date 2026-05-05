import type Database from 'better-sqlite3';
import { logger } from '../utils/logger';
import { allAdapters } from '../adapters/index';
import { getAdapterId } from './browser-session';
import { decryptApiKey } from '../utils/encryption';

export interface CredentialValidationResult {
  platformId: string;
  platform: string;
  ok: boolean;
  error?: string;
  tested_at: string;
}

async function testSingleCredential(
  adapter: any,
  encryptedKey: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const apiKey = decryptApiKey(encryptedKey);
    const originalEnv = { ...process.env };

    const envKeyMap: Record<string, string> = {
      'devto': 'DEVTO_API_KEY',
      'medium': 'MEDIUM_INTEGRATION_TOKEN',
      'hashnode': 'HASHNODE_TOKEN',
      'github': 'GITHUB_TOKEN',
      'blogger': 'GOOGLE_APPLICATION_CREDENTIALS_JSON',
      'wordpress': 'WORDPRESS_SITE_URL',
      'telegraph': 'TELEGRA_PH_TOKEN',
    };

    const platformId = getAdapterId(adapter);
    const envVar = envKeyMap[platformId];

    if (!envVar) {
      return { ok: false, error: 'Platform not supported for validation' };
    }

    process.env[envVar] = apiKey;
    const result = await adapter.testConnection();
    process.env = originalEnv;

    return result;
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Unknown error' };
  }
}

export async function validateAllCredentials(db: Database.Database): Promise<CredentialValidationResult[]> {
  const results: CredentialValidationResult[] = [];

  try {
    const profileRow = db.prepare('SELECT api_keys_encrypted FROM brand_profiles LIMIT 1').get();
    if (!profileRow || typeof profileRow.api_keys_encrypted !== 'string') {
      return results;
    }

    let apiKeys: Record<string, string> = {};
    try {
      apiKeys = JSON.parse(profileRow.api_keys_encrypted);
    } catch (e) {
      logger.warn('Failed to parse stored API keys');
      return results;
    }

    const now = new Date().toISOString();
    const testStatus: Record<string, any> = {};

    const statusRow = db.prepare('SELECT platform_test_status FROM brand_profiles LIMIT 1').get();
    if (statusRow && typeof statusRow.platform_test_status === 'string') {
      try {
        Object.assign(testStatus, JSON.parse(statusRow.platform_test_status));
      } catch (e) {}
    }

    for (const [platformId, encryptedKey] of Object.entries(apiKeys)) {
      const adapter = allAdapters.find(a => getAdapterId(a) === platformId);
      if (!adapter || adapter.isBrowserAutomation) continue;

      const testResult = await testSingleCredential(adapter, encryptedKey);

      results.push({
        platformId,
        platform: adapter.name,
        ok: testResult.ok,
        error: testResult.error,
        tested_at: now,
      });

      testStatus[platformId] = {
        connected_at: testStatus[platformId]?.connected_at ?? now,
        last_test_error: testResult.ok ? null : testResult.error,
        test_timestamp: now,
      };
    }

    if (Object.keys(apiKeys).length > 0) {
      db.prepare(`
        UPDATE brand_profiles
        SET platform_test_status = ?, updated_at = ?
        WHERE brand_id = 'default'
      `).run(JSON.stringify(testStatus), now);
    }

    return results;
  } catch (err: any) {
    logger.error('Credential validation failed', err);
    return results;
  }
}
