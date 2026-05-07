/**
 * services/credential-validator.ts
 *
 * 24h background task that validates every stored API key against its adapter
 * via testConnection() and writes the result to brand_profiles.platform_test_status.
 *
 * The env-injection / snapshot / restore mechanic was historically duplicated
 * here. Plan 2026-05-07-002 Unit 3 consolidated it into
 * `services/admin/credential-store.ts`. This file now decrypts the stored key
 * and delegates to `testCredentialAgainstAdapter` with `keepOnSuccess: false`.
 */

import type Database from 'better-sqlite3';
import { logger } from '../utils/logger';
import { allAdapters } from '../adapters/index';
import { getAdapterId } from './browser-session';
import { decryptApiKey } from '../utils/encryption';
import { testCredentialAgainstAdapter } from './admin/credential-store';

export interface CredentialValidationResult {
  platformId: string;
  platform: string;
  ok: boolean;
  error?: string;
  tested_at: string;
}

export async function validateAllCredentials(db: Database.Database): Promise<CredentialValidationResult[]> {
  const results: CredentialValidationResult[] = [];

  try {
    const profileRow = db.prepare('SELECT api_keys_encrypted FROM brand_profiles LIMIT 1').get() as
      { api_keys_encrypted?: string } | undefined;
    if (!profileRow?.api_keys_encrypted) return results;

    let apiKeys: Record<string, string> = {};
    try {
      apiKeys = JSON.parse(profileRow.api_keys_encrypted);
    } catch (e) {
      logger.warn('Failed to parse stored API keys');
      return results;
    }

    const now = new Date().toISOString();
    const testStatus: Record<string, any> = {};

    const statusRow = db.prepare('SELECT platform_test_status FROM brand_profiles LIMIT 1').get() as
      { platform_test_status?: string } | undefined;
    if (statusRow?.platform_test_status) {
      try { Object.assign(testStatus, JSON.parse(statusRow.platform_test_status)); } catch (e) { /* ignore parse error */ }
    }

    // Parallel validation with concurrency limit (3 at a time)
    const entries = Object.entries(apiKeys);
    const concurrency = 3;

    for (let i = 0; i < entries.length; i += concurrency) {
      const batch = entries.slice(i, i + concurrency);
      const batchPromises = batch.map(async ([platformId, encryptedKey]) => {
        const adapter = allAdapters.find(a => getAdapterId(a) === platformId);
        if (!adapter || adapter.isBrowserAutomation) return null;

        let plaintext: string;
        try {
          plaintext = decryptApiKey(encryptedKey);
        } catch (e: any) {
          return {
            platformId,
            platform: adapter.name,
            ok: false,
            error: 'Failed to decrypt stored credential',
            tested_at: now,
          } satisfies CredentialValidationResult;
        }

        const testResult = await testCredentialAgainstAdapter(adapter, plaintext, { keepOnSuccess: false });

        return {
          platformId,
          platform: adapter.name,
          ok: testResult.ok,
          error: testResult.error,
          tested_at: now,
        } satisfies CredentialValidationResult;
      });

      const batchResults = await Promise.all(batchPromises);
      for (const result of batchResults) {
        if (!result) continue;
        results.push(result);
        testStatus[result.platformId] = {
          connected_at: testStatus[result.platformId]?.connected_at ?? now,
          last_test_error: result.ok ? null : result.error,
          test_timestamp: now,
        };
      }
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
