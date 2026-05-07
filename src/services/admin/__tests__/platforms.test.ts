import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applyV2Schema } from '../../../db/schema';
import { encryptApiKey } from '../../../utils/encryption';

// Mocks must be hoisted before SUT import
vi.mock('../../../adapters/index', () => {
  const adapters = [
    { name: 'Dev.to', isBrowserAutomation: false, canPublishAutomatically: true },
    { name: 'Medium', isBrowserAutomation: false, canPublishAutomatically: true, supportsBrowserFallback: true },
    { name: 'GitHub', isBrowserAutomation: false, canPublishAutomatically: true },
    { name: 'BrowserOnly', isBrowserAutomation: true, canPublishAutomatically: true },
    { name: 'BrowserNoAutopub', isBrowserAutomation: true, canPublishAutomatically: false },
  ];
  return { allAdapters: adapters };
});

vi.mock('../../browser-session', () => ({
  isBrowserAutomationEnabled: vi.fn(() => false),
  hasSavedBrowserSession: vi.fn(() => false),
  getAdapterId: (a: { name: string }) =>
    a.name.toLowerCase().replace(/\./g, '').replace(/[^a-z0-9]/g, ''),
}));

vi.mock('../../auth-strategy', () => ({
  isOAuthSupported: vi.fn(() => false),
  getStrategyByAdapter: vi.fn(() => null),
  getOAuthProviderLabel: vi.fn(() => null),
}));

vi.mock('../../../db/oauth-tokens', () => ({
  oauthTokens: {
    exists: vi.fn(() => false),
  },
}));

vi.mock('../../../utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  },
}));

import {
  hasStoredApiKey,
  isAdapterConnected,
  isDefaultPublishTarget,
  getPlatformStatus,
  getDefaultPublishingPlatforms,
  resolveTargetPlatforms,
  getAllPlatformStatuses,
} from '../platforms';
import { allAdapters } from '../../../adapters/index';
import { isBrowserAutomationEnabled, hasSavedBrowserSession } from '../../browser-session';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  applyV2Schema(db);
  db.prepare(
    'INSERT INTO brand_profiles (brand_id, name, name_variants_json, target_urls_json, exposure_blocklist_json, anchor_blocklist_json) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('default', 'Test Brand', '[]', '[]', '[]', '[]');
  return db;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default mock state
  (isBrowserAutomationEnabled as any).mockReturnValue(false);
  (hasSavedBrowserSession as any).mockReturnValue(false);
});

afterEach(() => {
  delete process.env.DEVTO_API_KEY;
  delete process.env.MEDIUM_INTEGRATION_TOKEN;
  delete process.env.GITHUB_TOKEN;
});

describe('hasStoredApiKey', () => {
  it('returns true when api_keys_encrypted contains the platformId', () => {
    const db = freshDb();
    db.prepare('UPDATE brand_profiles SET api_keys_encrypted = ?').run(
      JSON.stringify({ devto: encryptApiKey('K') }),
    );
    expect(hasStoredApiKey(db, 'devto')).toBe(true);
  });

  it('returns false when api_keys_encrypted is null/empty', () => {
    const db = freshDb();
    expect(hasStoredApiKey(db, 'devto')).toBe(false);
  });

  it('returns false on corrupted JSON without throwing', () => {
    const db = freshDb();
    db.prepare('UPDATE brand_profiles SET api_keys_encrypted = ?').run('not-json{');
    expect(hasStoredApiKey(db, 'devto')).toBe(false);
  });
});

describe('isAdapterConnected', () => {
  it('returns true when env var is set for an API adapter', () => {
    process.env.DEVTO_API_KEY = 'present';
    const db = freshDb();
    const devto = (allAdapters as any[]).find(a => a.name === 'Dev.to');
    expect(isAdapterConnected(db, devto)).toBe(true);
  });

  it('returns false for browser-automation adapter when automation disabled', () => {
    (isBrowserAutomationEnabled as any).mockReturnValue(false);
    const db = freshDb();
    const browserAdapter = (allAdapters as any[]).find(a => a.name === 'BrowserOnly');
    expect(isAdapterConnected(db, browserAdapter)).toBe(false);
  });

  it('returns true for browser-automation adapter when automation enabled + session saved', () => {
    (isBrowserAutomationEnabled as any).mockReturnValue(true);
    (hasSavedBrowserSession as any).mockReturnValue(true);
    const db = freshDb();
    const browserAdapter = (allAdapters as any[]).find(a => a.name === 'BrowserOnly');
    expect(isAdapterConnected(db, browserAdapter)).toBe(true);
  });
});

describe('isDefaultPublishTarget', () => {
  it('returns false for browser adapter without canPublishAutomatically even when connected', () => {
    (isBrowserAutomationEnabled as any).mockReturnValue(true);
    (hasSavedBrowserSession as any).mockReturnValue(true);
    const db = freshDb();
    const adapter = (allAdapters as any[]).find(a => a.name === 'BrowserNoAutopub');
    expect(isAdapterConnected(db, adapter)).toBe(true);
    expect(isDefaultPublishTarget(db, adapter)).toBe(false);
  });

  it('returns true for API adapter with env var set', () => {
    process.env.DEVTO_API_KEY = 'present';
    const db = freshDb();
    const devto = (allAdapters as any[]).find(a => a.name === 'Dev.to');
    expect(isDefaultPublishTarget(db, devto)).toBe(true);
  });
});

describe('getPlatformStatus', () => {
  it('reports Ready reason when connected and default-eligible', () => {
    process.env.GITHUB_TOKEN = 'present';
    const db = freshDb();
    const adapter = (allAdapters as any[]).find(a => a.name === 'GitHub');
    const s = getPlatformStatus(db, adapter);
    expect(s.connected).toBe(true);
    expect(s.defaultEligible).toBe(true);
    expect(s.reason).toBe('Ready for default auto-publish');
  });

  it('reports Missing reason when API adapter has no env var', () => {
    const db = freshDb();
    const adapter = (allAdapters as any[]).find(a => a.name === 'Dev.to');
    const s = getPlatformStatus(db, adapter);
    expect(s.connected).toBe(false);
    expect(s.reason).toBe('Missing required API configuration');
  });

  it('merges platform_test_status from DB into result', () => {
    process.env.DEVTO_API_KEY = 'present';
    const db = freshDb();
    const ts = '2026-05-07T12:00:00.000Z';
    db.prepare('UPDATE brand_profiles SET platform_test_status = ?').run(
      JSON.stringify({ devto: { connected_at: ts, last_test_error: null, test_timestamp: ts } }),
    );
    const adapter = (allAdapters as any[]).find(a => a.name === 'Dev.to');
    const s = getPlatformStatus(db, adapter);
    expect(s.connected_at).toBe(ts);
    expect(s.test_timestamp).toBe(ts);
    expect(s.last_test_error).toBeNull();
  });
});

describe('getDefaultPublishingPlatforms / resolveTargetPlatforms', () => {
  it('default list excludes browser adapters when automation disabled', () => {
    process.env.DEVTO_API_KEY = 'x';
    process.env.GITHUB_TOKEN = 'x';
    const db = freshDb();
    const list = getDefaultPublishingPlatforms(db);
    expect(list).toEqual(expect.arrayContaining(['Dev.to', 'GitHub']));
    expect(list).not.toContain('BrowserOnly');
  });

  it('resolveTargetPlatforms returns provided non-empty array as-is (filtered)', () => {
    const db = freshDb();
    expect(resolveTargetPlatforms(db, ['Dev.to', '', 42, 'Medium'])).toEqual(['Dev.to', 'Medium']);
  });

  it('resolveTargetPlatforms falls back to defaults on empty/non-array', () => {
    process.env.DEVTO_API_KEY = 'x';
    const db = freshDb();
    expect(resolveTargetPlatforms(db, undefined)).toEqual(['Dev.to']);
    expect(resolveTargetPlatforms(db, [])).toEqual(['Dev.to']);
  });
});

describe('getAllPlatformStatuses', () => {
  it('returns 14-field status per adapter + defaults array', () => {
    process.env.DEVTO_API_KEY = 'present';
    const db = freshDb();
    const result = getAllPlatformStatuses(db);
    expect(Array.isArray(result.platforms)).toBe(true);
    expect(result.platforms.length).toBe(5); // matches mocked adapters count
    expect(Array.isArray(result.defaults)).toBe(true);

    const devtoEntry = result.platforms.find((p: any) => p.name === 'Dev.to');
    expect(devtoEntry).toBeDefined();
    // Verify required fields are present
    expect(devtoEntry).toEqual(expect.objectContaining({
      name: 'Dev.to',
      id: 'devto',
      connected: true,
      defaultEligible: true,
      browserAutomation: false,
      browserAuthSupported: false,
      canPublishAutomatically: true,
      supportsOAuth: false,
      oauthConfigured: false,
      oauthConnected: false,
      oauthProviderId: null,
      supportsBrowserFallback: false,
      browserSessionExists: false,
    }));
  });
});
