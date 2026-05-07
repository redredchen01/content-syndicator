/**
 * services/admin/platforms.ts (Plan 2026-05-07-002 Unit 1)
 *
 * Platform connectivity / OAuth / browser-session status assembly. Originally
 * inline in routes/admin.ts:42-161 (API_CONNECTED, hasStoredApiKey, isAdapterConnected,
 * isDefaultPublishTarget, getPlatformStatus, getDefaultPublishingPlatforms,
 * resolveTargetPlatforms, plus the /api/platforms response builder).
 *
 * Cross-domain: routes/publish.ts imports resolveTargetPlatforms and
 * getDefaultPublishingPlatforms directly from this service (Unit 7).
 */

import type Database from 'better-sqlite3';
import type { PlatformAdapter } from '../../adapters/base';
import { allAdapters } from '../../adapters/index';
import { logger } from '../../utils/logger';
import {
  isBrowserAutomationEnabled,
  hasSavedBrowserSession,
  getAdapterId,
} from '../browser-session';
import {
  isOAuthSupported,
  getStrategyByAdapter,
  getOAuthProviderLabel,
} from '../auth-strategy';
import { oauthTokens } from '../../db/oauth-tokens';

/**
 * Data-driven environment-variable presence check per adapter. New API platforms
 * register their env-var combination here only — the rest of the connectivity
 * pipeline is generic.
 */
export const API_CONNECTED: Record<string, () => boolean> = {
  'Telegra.ph':  () => true,
  'Dev.to':      () => Boolean(process.env.DEVTO_API_KEY),
  'Medium':      () => Boolean(process.env.MEDIUM_INTEGRATION_TOKEN),
  'Hashnode':    () => Boolean(process.env.HASHNODE_TOKEN && process.env.HASHNODE_PUBLICATION_ID),
  'GitHub':      () => Boolean(process.env.GITHUB_TOKEN),
  'Blogger':     () => Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON && process.env.BLOGGER_BLOG_ID),
  'WordPress':   () => Boolean(process.env.WORDPRESS_SITE_URL && process.env.WORDPRESS_USERNAME && process.env.WORDPRESS_APP_PASSWORD),
  'Twitter':     () => Boolean(process.env.TWITTER_CONSUMER_KEY && process.env.TWITTER_CONSUMER_SECRET && process.env.TWITTER_ACCESS_TOKEN && process.env.TWITTER_ACCESS_TOKEN_SECRET),
  'Instapaper':  () => Boolean(process.env.INSTAPAPER_USERNAME && process.env.INSTAPAPER_PASSWORD),
};

export function hasStoredApiKey(db: Database.Database, platformId: string): boolean {
  try {
    const result = db.prepare('SELECT api_keys_encrypted FROM brand_profiles LIMIT 1').get() as
      { api_keys_encrypted?: string } | undefined;
    if (result?.api_keys_encrypted) {
      const apiKeys = JSON.parse(result.api_keys_encrypted);
      return Boolean(apiKeys[platformId]);
    }
  } catch (e) {
    logger.warn(`Failed to check stored API key for ${platformId}`);
  }
  return false;
}

export function isAdapterConnected(db: Database.Database, adapter: PlatformAdapter): boolean {
  if (adapter.isBrowserAutomation) return isBrowserAutomationEnabled() && hasSavedBrowserSession(adapter);
  const adapterConnected = API_CONNECTED[adapter.name]?.() ?? false;
  if (adapterConnected) return true;
  if (hasStoredApiKey(db, getAdapterId(adapter))) return true;
  // OAuth user-flow: a stored refresh_token in oauth_tokens counts as connected
  if (isOAuthSupported(adapter.name) && oauthTokens.exists(db, getAdapterId(adapter))) {
    return true;
  }
  // Hybrid (Medium): a saved browser session + browser automation enabled
  if (adapter.supportsBrowserFallback && isBrowserAutomationEnabled() && hasSavedBrowserSession(adapter)) {
    return true;
  }
  return false;
}

export function isDefaultPublishTarget(db: Database.Database, adapter: PlatformAdapter): boolean {
  if (!isAdapterConnected(db, adapter)) return false;
  if (adapter.isBrowserAutomation) return Boolean(adapter.canPublishAutomatically);
  return true;
}

export interface PlatformStatus {
  connected: boolean;
  defaultEligible: boolean;
  reason: string;
  connected_at: string | null;
  last_test_error: string | null;
  test_timestamp: string | null;
}

export function getPlatformStatus(db: Database.Database, adapter: PlatformAdapter): PlatformStatus {
  const connected = isAdapterConnected(db, adapter);
  const defaultEligible = isDefaultPublishTarget(db, adapter);

  let reason = '';
  if (!connected) {
    reason = adapter.isBrowserAutomation
      ? (isBrowserAutomationEnabled() ? 'No saved browser session' : 'Browser automation disabled to avoid controlling your desktop browser')
      : 'Missing required API configuration';
  } else if (!defaultEligible && adapter.isBrowserAutomation) {
    reason = 'Login saved, but stable auto-publish selectors are not configured';
  } else {
    reason = 'Ready for default auto-publish';
  }

  // Get test status from database
  let testStatus: { connected_at: string | null; last_test_error: string | null; test_timestamp: string | null } = {
    connected_at: null, last_test_error: null, test_timestamp: null,
  };
  try {
    const result = db.prepare('SELECT platform_test_status FROM brand_profiles LIMIT 1').get() as
      { platform_test_status?: string } | undefined;
    if (result?.platform_test_status) {
      const statusMap = JSON.parse(result.platform_test_status);
      testStatus = statusMap[getAdapterId(adapter)] || testStatus;
    }
  } catch (e) {
    logger.warn(`Failed to read platform test status: ${e}`);
  }

  return { connected, defaultEligible, reason, ...testStatus };
}

export function getDefaultPublishingPlatforms(db: Database.Database): string[] {
  return allAdapters.filter(a => isDefaultPublishTarget(db, a)).map(a => a.name);
}

export function resolveTargetPlatforms(db: Database.Database, platforms?: unknown): string[] {
  if (Array.isArray(platforms) && platforms.length > 0) {
    return platforms.filter((p): p is string => typeof p === 'string' && p.trim() !== '');
  }
  return getDefaultPublishingPlatforms(db);
}

/**
 * Build the full /api/platforms response payload — one entry per adapter
 * with status, OAuth metadata, and browser-session flags. This is the
 * canonical body builder for the GET /api/platforms endpoint.
 */
export function getAllPlatformStatuses(db: Database.Database) {
  const platforms = allAdapters.map(a => {
    const id = getAdapterId(a);
    const strategy = getStrategyByAdapter(a.name);
    const supportsOAuth = strategy != null;
    const oauthConfigured = strategy ? strategy.isConfigured() : false;
    const oauthConnected = supportsOAuth && oauthTokens.exists(db, id);
    return {
      name: a.name,
      id,
      ...getPlatformStatus(db, a),
      browserAutomation: Boolean(a.isBrowserAutomation),
      browserAuthSupported: Boolean(a.isBrowserAutomation || a.supportsBrowserFallback),
      canPublishAutomatically: Boolean(a.canPublishAutomatically || !a.isBrowserAutomation),
      supportsOAuth,
      oauthConfigured,
      oauthConnected,
      oauthProviderId: strategy?.providerId ?? null,
      oauthProviderLabel: getOAuthProviderLabel(a.name),
      supportsBrowserFallback: Boolean(a.supportsBrowserFallback),
      browserSessionExists: hasSavedBrowserSession(a),
      patGenerationUrl: a.patGenerationUrl ? a.patGenerationUrl : null,
    };
  });
  return { platforms, defaults: getDefaultPublishingPlatforms(db) };
}

export { getAdapterId, hasSavedBrowserSession };
