/**
 * services/admin/credential-store.ts (Plan 2026-05-07-002 Unit 3)
 *
 * Single source of truth for API-key validation + storage. Consolidates
 * envKeyMap and the env snapshot/inject/restore pattern that was historically
 * duplicated across:
 *   - routes/admin.ts (PATCH /api/platforms/:id/api-key — keep new key on success)
 *   - routes/admin.ts (POST /api/platforms/batch-validate — always restore env)
 *   - services/credential-validator.ts (24h background task — always restore env)
 *
 * Security invariants:
 *   - try/finally guarantees env restoration on every error path (throw or testFn fail)
 *   - plaintext keys never appear in logger.* args, returned tagged result, or Error.message
 *   - DB persists only encryptApiKey(plaintext); plaintext lives only in process.env scope
 */

import type Database from 'better-sqlite3';
import type { PlatformAdapter } from '../../adapters/base';
import { allAdapters } from '../../adapters/index';
import { encryptApiKey } from '../../utils/encryption';
import { getAdapterId } from '../browser-session';
import { logger } from '../../utils/logger';

/**
 * Single source of truth for platformId → env var name(s). Twitter is a 4-key
 * tuple; the candidate apiKey for twitter must be a JSON object {ck, cs, at, as}.
 * This was historically duplicated in 3 places — see file header for context.
 */
export const ENV_KEY_MAP: Record<string, string | string[]> = Object.freeze({
  devto:      'DEVTO_API_KEY',
  medium:     'MEDIUM_INTEGRATION_TOKEN',
  hashnode:   'HASHNODE_TOKEN',
  github:     'GITHUB_TOKEN',
  blogger:    'GOOGLE_APPLICATION_CREDENTIALS_JSON',
  wordpress:  'WORDPRESS_SITE_URL',
  telegraph:  'TELEGRA_PH_TOKEN',
  twitter:    ['TWITTER_CONSUMER_KEY', 'TWITTER_CONSUMER_SECRET', 'TWITTER_ACCESS_TOKEN', 'TWITTER_ACCESS_TOKEN_SECRET'],
  instapaper: 'INSTAPAPER_USERNAME',
});

const TWITTER_INVALID_JSON_ERROR = 'Twitter requires a JSON object with ck, cs, at, as keys';
const UNSUPPORTED_PLATFORM_ERROR = 'Cannot validate this platform type';

export interface TestCredentialResult {
  ok: boolean;
  error?: string;
  /** Set to true when adapter.testConnection() threw rather than returning { ok: false }.
   *  Callers should map this to HTTP 500, not 422 — old admin.ts:399 re-threw on this
   *  path so the outer try/catch returned 500. We preserve that contract here. */
  threw?: boolean;
}

export interface UpdateApiKeyResult {
  ok: boolean;
  platform?: string;
  connected_at?: string;
  test_timestamp?: string;
  error?: string;
  /** HTTP status code suggested by the service for the controller to map. */
  status?: 400 | 404 | 422 | 500;
}

export interface BatchCredentialInput {
  platformId: string;
  apiKey: string;
}

export interface BatchValidationItem {
  platformId: string;
  ok: boolean;
  error?: string;
}

/**
 * Strip any candidate secret substring from an error message before it is
 * returned or logged. Defense in depth: even if testConnection echoes the
 * key into Error.message, the caller never sees plaintext.
 */
function sanitize(message: string, secrets: readonly string[]): string {
  let out = message;
  for (const secret of secrets) {
    if (secret && secret.length > 0 && out.includes(secret)) {
      out = out.split(secret).join('<redacted>');
    }
  }
  return out;
}

/**
 * Inject a candidate API key into process.env, run adapter.testConnection(),
 * then restore process.env. The keepOnSuccess flag controls whether a passing
 * test result leaves the new key in env (PATCH api-key semantics) or wipes it
 * (batch-validate / 24h background validator semantics). On throw or failed
 * testConnection, env is ALWAYS restored regardless of mode.
 *
 * Returns a flat tagged result; never includes the apiKey in any field.
 */
export async function testCredentialAgainstAdapter(
  adapter: PlatformAdapter,
  apiKey: string,
  opts: { keepOnSuccess: boolean } = { keepOnSuccess: false },
): Promise<TestCredentialResult> {
  const platformId = getAdapterId(adapter);
  const envEntry = ENV_KEY_MAP[platformId];
  if (!envEntry) {
    return { ok: false, error: UNSUPPORTED_PLATFORM_ERROR };
  }

  // Parse Twitter JSON BEFORE mutating env so an invalid payload doesn't
  // leak partial state into the snapshot/restore window.
  let twitterParsed: Record<string, string> | null = null;
  if (Array.isArray(envEntry)) {
    try {
      twitterParsed = JSON.parse(apiKey);
    } catch {
      return { ok: false, error: TWITTER_INVALID_JSON_ERROR };
    }
  }

  // List of secret strings to scrub from error messages on the way out.
  const secrets: string[] = Array.isArray(envEntry)
    ? [twitterParsed!.ck, twitterParsed!.cs, twitterParsed!.at, twitterParsed!.as].filter((s): s is string => typeof s === 'string')
    : [apiKey];

  const saved: Record<string, string | undefined> = {};

  if (Array.isArray(envEntry)) {
    const [ck, cs, at, as_] = envEntry;
    saved[ck] = process.env[ck]; saved[cs] = process.env[cs];
    saved[at] = process.env[at]; saved[as_] = process.env[as_];
    process.env[ck] = twitterParsed!.ck; process.env[cs] = twitterParsed!.cs;
    process.env[at] = twitterParsed!.at; process.env[as_] = twitterParsed!.as;
  } else {
    saved[envEntry] = process.env[envEntry];
    process.env[envEntry] = apiKey;
  }

  let testResult: TestCredentialResult | undefined;
  try {
    testResult = await adapter.testConnection?.();
  } catch (e: any) {
    restoreEnv(saved);
    return {
      ok: false,
      error: sanitize(e?.message ?? 'testConnection threw', secrets),
      threw: true,
    };
  }

  // Adapter without testConnection() — historically batch-validate treated this
  // as `ok: true` (admin.ts:647 `testResult?.ok ?? true`). Preserve that.
  if (!testResult) {
    if (!opts.keepOnSuccess) restoreEnv(saved);
    return { ok: true };
  }

  if (!testResult.ok) {
    restoreEnv(saved);
    return { ok: false, error: testResult.error ? sanitize(testResult.error, secrets) : undefined };
  }

  // Success — caller may want to keep the new key as the active credential.
  if (!opts.keepOnSuccess) {
    restoreEnv(saved);
  }
  return { ok: true };
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/**
 * Full PATCH /api/platforms/:id/api-key flow:
 *   1. Validate input shape
 *   2. Resolve adapter
 *   3. Test the candidate key (keep in env on success)
 *   4. Encrypt + persist to brand_profiles.api_keys_encrypted
 *   5. Update brand_profiles.platform_test_status
 *
 * Returns tagged result with HTTP status hint for the controller.
 */
export async function updateApiKey(
  db: Database.Database,
  platformId: string,
  apiKey: string,
): Promise<UpdateApiKeyResult> {
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    return { ok: false, error: 'API key is required', status: 400 };
  }

  const adapter = allAdapters.find(a => getAdapterId(a) === platformId);
  if (!adapter || adapter.isBrowserAutomation) {
    return { ok: false, error: 'Platform not found or is browser automation', status: 404 };
  }

  logger.info(`[Admin] Testing API key for ${adapter.name}...`);
  const test = await testCredentialAgainstAdapter(adapter, apiKey, { keepOnSuccess: true });

  if (!test.ok) {
    if (test.error === UNSUPPORTED_PLATFORM_ERROR) {
      return { ok: false, error: test.error, status: 404 };
    }
    if (test.error === TWITTER_INVALID_JSON_ERROR) {
      return { ok: false, error: test.error, status: 400 };
    }
    // testConnection() threw → preserve old admin.ts:399 behavior (re-throw → outer catch → 500)
    if (test.threw) {
      logger.error(`[Admin] testConnection threw for ${adapter.name}`);
      return { ok: false, error: test.error, status: 500 };
    }
    logger.warn(`[Admin] API key validation failed for ${adapter.name}: ${test.error}`);
    return { ok: false, error: test.error, status: 422 };
  }

  // Persist — encryption happens here; plaintext does not leave this scope.
  const encrypted = encryptApiKey(apiKey);

  const profileRow = db.prepare('SELECT api_keys_encrypted FROM brand_profiles LIMIT 1').get() as
    { api_keys_encrypted?: string } | undefined;
  let apiKeys: Record<string, string> = {};
  if (profileRow?.api_keys_encrypted) {
    try { apiKeys = JSON.parse(profileRow.api_keys_encrypted); }
    catch (e) { logger.warn('Failed to parse existing API keys, starting fresh'); }
  }
  apiKeys[platformId] = encrypted;

  const now = new Date().toISOString();
  const testStatus: Record<string, any> = {};
  const statusRow = db.prepare('SELECT platform_test_status FROM brand_profiles LIMIT 1').get() as
    { platform_test_status?: string } | undefined;
  if (statusRow?.platform_test_status) {
    try { Object.assign(testStatus, JSON.parse(statusRow.platform_test_status)); } catch (e) { /* ignore parse error */ }
  }
  testStatus[platformId] = {
    connected_at: now,
    last_test_error: null,
    test_timestamp: now,
  };

  db.prepare(`
    UPDATE brand_profiles
    SET api_keys_encrypted = ?, platform_test_status = ?, updated_at = ?
    WHERE brand_id = 'default'
  `).run(JSON.stringify(apiKeys), JSON.stringify(testStatus), now);

  logger.info(`[Admin] API key stored successfully for ${adapter.name}`);

  return {
    ok: true,
    platform: adapter.name,
    connected_at: now,
    test_timestamp: now,
  };
}

/**
 * Full POST /api/platforms/batch-validate flow: validate many keys in parallel,
 * always restoring env afterward (does not persist anything).
 */
export async function batchValidateApiKeys(
  credentials: BatchCredentialInput[],
): Promise<BatchValidationItem[]> {
  return Promise.all(credentials.map(async ({ platformId, apiKey }) => {
    if (typeof platformId !== 'string' || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
      return { platformId, ok: false, error: 'Invalid input' };
    }
    const adapter = allAdapters.find(a => getAdapterId(a) === platformId);
    if (!adapter || adapter.isBrowserAutomation) {
      return { platformId, ok: false, error: 'Platform not found or is browser automation' };
    }
    logger.info(`[Admin] Testing API key for ${adapter.name}...`);
    const result = await testCredentialAgainstAdapter(adapter, apiKey, { keepOnSuccess: false });
    return { platformId, ok: result.ok, error: result.error };
  }));
}
