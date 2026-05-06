import express from 'express';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import { PlatformAdapter } from '../adapters/base';
import { allAdapters } from '../adapters/index';
import { db } from '../db';
import { getProfile, saveProfile, isReadyForDispatch, updatePreferredPlatforms, getPreferredPlatforms } from '../services/brand-profile';
import { runPrecheck } from '../services/anchor-monitor';
import { acquirePage, releasePage } from '../utils/browserManager';
import { syncRoute } from './_helpers';
import { encryptApiKey, decryptApiKey } from '../utils/encryption';
import {
  AUTH_DIR,
  getBrowserAuthMode,
  isBrowserAutomationEnabled,
  hasSavedBrowserSession,
  getAdapterId,
  createBrowserAuthContext,
} from '../services/browser-session';

export { getAdapterId, hasSavedBrowserSession };

export const router = express.Router();

// Data-driven connectivity check — add new platforms here only
const API_CONNECTED: Record<string, () => boolean> = {
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

function hasStoredApiKey(platformId: string): boolean {
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

function isAdapterConnected(adapter: PlatformAdapter): boolean {
  if (adapter.isBrowserAutomation) return isBrowserAutomationEnabled() && hasSavedBrowserSession(adapter);
  const adapterConnected = API_CONNECTED[adapter.name]?.() ?? false;
  // Also check if there's a stored API key
  return adapterConnected || hasStoredApiKey(getAdapterId(adapter));
}

function isDefaultPublishTarget(adapter: PlatformAdapter) {
  if (!isAdapterConnected(adapter)) return false;
  if (adapter.isBrowserAutomation) return Boolean(adapter.canPublishAutomatically);
  return true;
}

function getPlatformStatus(adapter: PlatformAdapter) {
  const connected = isAdapterConnected(adapter);
  const defaultEligible = isDefaultPublishTarget(adapter);

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
  let testStatus: any = { connected_at: null, last_test_error: null, test_timestamp: null };
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

export function getDefaultPublishingPlatforms() {
  return allAdapters.filter(isDefaultPublishTarget).map(a => a.name);
}

export function resolveTargetPlatforms(platforms?: unknown) {
  if (Array.isArray(platforms) && platforms.length > 0) {
    return platforms.filter((p): p is string => typeof p === 'string' && p.trim() !== '');
  }
  return getDefaultPublishingPlatforms();
}

router.get('/api/platforms', syncRoute((req, res) => {
  const platforms = allAdapters.map(a => ({
    name: a.name,
    id: getAdapterId(a),
    ...getPlatformStatus(a),
    browserAutomation: Boolean(a.isBrowserAutomation),
    browserAuthSupported: Boolean(a.isBrowserAutomation),
    canPublishAutomatically: Boolean(a.canPublishAutomatically || !a.isBrowserAutomation),
  }));
  res.json({ platforms, defaults: getDefaultPublishingPlatforms() });
}));

router.get('/api/v2/brand-profile', syncRoute((_, res) => {
  const profile = getProfile(db);
  const dispatch = isReadyForDispatch(db);
  res.json({ profile, dispatchReady: dispatch.ready, dispatchReport: dispatch.report });
}));

router.put('/api/v2/brand-profile', syncRoute((req, res) => {
  const body = req.body ?? {};
  if (typeof body !== 'object' || body === null) return res.status(400).json({ error: 'JSON body required' });
  if (typeof body.name !== 'string' || body.name.trim().length === 0) {
    return res.status(422).json({ errors: [{ field: 'name', message: '品牌主名不能为空' }] });
  }
  const result = saveProfile(db, body);
  if (!result.ok) return res.status(422).json({ errors: result.errors });
  const dispatch = isReadyForDispatch(db);
  res.json({ profile: result.profile, dispatchReady: dispatch.ready, dispatchReport: dispatch.report });
}));

router.post('/api/v2/precheck', syncRoute((req, res) => {
  const profile = getProfile(db);
  if (!profile) return res.status(412).json({ error: '品牌资料库未配置，请先访问 /admin.html 填写。' });
  const { target_urls } = req.body ?? {};
  const urls: string[] = Array.isArray(target_urls)
    ? target_urls.filter((u: unknown) => typeof u === 'string')
    : [];
  res.json(runPrecheck(db, urls, profile));
}));

router.post('/api/auth/browser', async (req, res) => {
  if (!isBrowserAutomationEnabled()) {
    return res.status(403).json({
      error: 'Browser automation is disabled. Set ENABLE_BROWSER_AUTOMATION=true in .env only when you intentionally want to open controlled browser login windows.'
    });
  }

  const { platform } = req.body;
  const adapter: any = allAdapters.find(a => a.name.toLowerCase().replace(/[^a-z0-9]/g, '') === platform);

  const loginUrlMap: Record<string, string> = {
    'medium':           'https://medium.com/m/signin',
    'devto':            'https://dev.to/enter',
    'google':           'https://accounts.google.com/',
    'blogger':          'https://accounts.google.com/',
    'substack':         'https://substack.com/sign-in',
    'indiehackers':     'https://www.indiehackers.com/sign-in',
    'quora':            'https://www.quora.com/',
    'producthunt':      'https://www.producthunt.com/login',
    'ztndz':            'https://ztndz.com/login',
    'yoursocialpeople': 'https://yoursocialpeople.com/login',
    'zopedirectory':    'https://www.zopedirectory.com/login',
    'zeddirectory':     'https://www.zed-directory.com/login',
    'youslade':         'https://youslade.com/login',
  };

  const loginUrl = loginUrlMap[platform] ?? (adapter?.config?.composeUrl ?? '');
  if (!loginUrl) {
    const platformName = adapter?.name || platform;
    return res.status(400).json({
      error: `${platformName} does not support browser OAuth in this app. Configure it in Publishing Platforms with its API token/application password instead.`
    });
  }

  try {
    const authSession = await createBrowserAuthContext(platform);
    const context = authSession.context;
    const page = await acquirePage(context);

    res.json({ success: true, message: `Opened ${authSession.mode} for ${platform}. Please log in and close the window to save your session.` });

    await page.goto(loginUrl);

    const authFilePath = path.join(AUTH_DIR, `${platform}.json`);
    const saveInterval = setInterval(async () => {
      try {
        if (context && authSession.isConnected()) {
          await context.storageState({ path: authFilePath });
        } else {
          clearInterval(saveInterval);
        }
      } catch(e) {
        clearInterval(saveInterval);
      }
    }, 2000);

    context.on('close', () => {
      clearInterval(saveInterval);
      logger.success(`Browser closed for ${platform}. Cookies were saved periodically.`);
    });

  } catch (error: any) {
    logger.error('Browser Auth Error', error);
    const message = error?.message || 'Browser auth failed';
    const profileHint = getBrowserAuthMode() === 'chrome-profile'
      ? ' If you selected common Chrome profile mode, close all Chrome windows first or switch to Installed Chrome, separate profile.'
      : '';
    if (!res.headersSent) res.status(500).json({ error: `${message}${profileHint}` });
  }
});

router.post('/api/auth/test', async (req, res) => {
  if (!isBrowserAutomationEnabled()) {
    return res.status(403).json({
      error: 'Browser automation is disabled. Set ENABLE_BROWSER_AUTOMATION=true in .env only when you intentionally want to test saved browser sessions.'
    });
  }

  const { platform } = req.body;
  const authFile = path.join(AUTH_DIR, `${platform}.json`);

  if (!fs.existsSync(authFile)) {
    return res.status(400).json({ error: `No saved session found for ${platform}. Please Connect first.` });
  }

  const adapter: any = allAdapters.find(a => a.name.toLowerCase().replace(/[^a-z0-9]/g, '') === platform);
  const testUrl = adapter?.config?.composeUrl || 'https://google.com';

  try {
    const authSession = await createBrowserAuthContext(platform);
    const context = authSession.context;
    const page = await acquirePage(context);

    res.json({ success: true, message: `Testing ${platform} session in ${authSession.mode}. If you see the editor/dashboard, your cookies are valid!` });

    await page.goto(testUrl);

    page.on('close', async () => {
      releasePage(page).catch(() => {});
      try {
        await context.storageState({ path: authFile });
      } catch(e) {}
      await authSession.close();
    });
  } catch (error: any) {
    logger.error('Browser Test Auth Error', error);
    const message = error?.message || 'Browser test failed';
    const profileHint = getBrowserAuthMode() === 'chrome-profile'
      ? ' If you selected common Chrome profile mode, close all Chrome windows first or switch to Installed Chrome, separate profile.'
      : '';
    if (!res.headersSent) res.status(500).json({ error: `${message}${profileHint}` });
  }
});

// GET /api/auth/browser/status/:platform — lightweight poll for login completion
// Returns { exists, cookieCount, mtime } without launching a browser.
// Frontend uses cookieCount >= MIN_AUTH_COOKIES as the "logged-in" signal.
const MIN_AUTH_COOKIES = 5;

router.get('/api/auth/browser/status/:platform', syncRoute((req, res) => {
  const cleanId = String(req.params.platform).toLowerCase().replace(/[^a-z0-9]/g, '');
  const authFile = path.join(AUTH_DIR, `${cleanId}.json`);

  try {
    const stat = fs.statSync(authFile);
    const raw = fs.readFileSync(authFile, 'utf-8');
    let cookieCount = 0;
    try {
      const parsed = JSON.parse(raw);
      cookieCount = Array.isArray(parsed.cookies) ? parsed.cookies.length : 0;
    } catch { /* malformed JSON, cookieCount stays 0 */ }

    res.json({
      exists: true,
      cookieCount,
      minAuthCookies: MIN_AUTH_COOKIES,
      mtime: stat.mtimeMs,
      platform: cleanId,
    });
  } catch {
    res.json({ exists: false, cookieCount: 0, minAuthCookies: MIN_AUTH_COOKIES, mtime: null, platform: cleanId });
  }
}));

// PATCH /api/platforms/:platformId/api-key — update and validate API key
router.patch('/api/platforms/:platformId/api-key', async (req, res) => {
  try {
    const { platformId } = req.params;
    const { apiKey } = req.body ?? {};

    if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
      return res.status(400).json({ error: 'API key is required' });
    }

    // Find adapter
    const adapter = allAdapters.find(a => getAdapterId(a) === platformId);
    if (!adapter || adapter.isBrowserAutomation) {
      return res.status(404).json({ error: 'Platform not found or is browser automation' });
    }

    logger.info(`[Admin] Testing API key for ${adapter.name}...`);

    // Validate API key by calling testConnection() with the new key.
    // Map platformId to the environment variable it reads from.
    // Twitter uses 4 env vars — apiKey must be JSON: {"ck":...,"cs":...,"at":...,"as":...}
    const envKeyMap: Record<string, string | string[]> = {
      'devto':       'DEVTO_API_KEY',
      'medium':      'MEDIUM_INTEGRATION_TOKEN',
      'hashnode':    'HASHNODE_TOKEN',
      'github':      'GITHUB_TOKEN',
      'blogger':     'GOOGLE_APPLICATION_CREDENTIALS_JSON',
      'wordpress':   'WORDPRESS_SITE_URL',
      'telegraph':   'TELEGRA_PH_TOKEN',
      'twitter':     ['TWITTER_CONSUMER_KEY','TWITTER_CONSUMER_SECRET','TWITTER_ACCESS_TOKEN','TWITTER_ACCESS_TOKEN_SECRET'],
      'instapaper':  'INSTAPAPER_USERNAME',
    };

    const envVar = envKeyMap[platformId];
    if (!envVar) {
      return res.status(404).json({ error: 'Cannot validate this platform type' });
    }

    // For multi-key platforms (Twitter), apiKey is a JSON object string
    const prevValues: Record<string, string | undefined> = {};
    if (Array.isArray(envVar)) {
      let parsed: Record<string, string>;
      try { parsed = JSON.parse(apiKey); } catch {
        return res.status(400).json({ error: 'Twitter requires a JSON object with ck, cs, at, as keys' });
      }
      const [ck, cs, at, as_] = envVar;
      prevValues[ck] = process.env[ck]; prevValues[cs] = process.env[cs];
      prevValues[at] = process.env[at]; prevValues[as_] = process.env[as_];
      process.env[ck] = parsed.ck; process.env[cs] = parsed.cs;
      process.env[at] = parsed.at; process.env[as_] = parsed.as;
    } else {
      prevValues[envVar] = process.env[envVar];
      process.env[envVar] = apiKey;
    }

    const restoreEnv = () => {
      for (const [k, v] of Object.entries(prevValues)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    };

    let testResult: Awaited<ReturnType<NonNullable<typeof adapter.testConnection>>> | undefined;
    try {
      testResult = await adapter.testConnection?.();
    } catch (e: any) {
      restoreEnv();
      throw e;
    }

    if (testResult && !testResult.ok) {
      restoreEnv();
      logger.warn(`[Admin] API key validation failed for ${adapter.name}: ${testResult.error}`);
      return res.status(422).json({ ok: false, error: testResult.error });
    }
    // Success: keep the new key in process.env (it is now the active credential)

    // Encrypt and store API key
    const encrypted = encryptApiKey(apiKey);

    // Get existing API keys
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
      try { Object.assign(testStatus, JSON.parse(statusRow.platform_test_status)); } catch (e) {}
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

    res.json({
      ok: true,
      platform: adapter.name,
      connected_at: now,
      test_timestamp: now,
    });
  } catch (error: any) {
    logger.error('[Admin] Failed to update API key', error);
    res.status(500).json({
      ok: false,
      error: error?.message ?? 'Failed to update API key',
    });
  }
});

// PATCH /api/v2/brand-profile/preferred-platforms — update preferred publishing platforms
router.patch('/api/v2/brand-profile/preferred-platforms', syncRoute((req, res) => {
  try {
    const { platforms } = req.body ?? {};

    if (!Array.isArray(platforms)) {
      return res.status(400).json({ error: 'platforms must be an array' });
    }

    const result = updatePreferredPlatforms(db, platforms);
    if (!result.ok) {
      return res.status(422).json({ error: result.error });
    }

    const preferred = getPreferredPlatforms(db);
    logger.info(`[Admin] Updated preferred platforms: ${preferred.join(', ')}`);

    res.json({
      ok: true,
      preferredPlatforms: preferred,
    });
  } catch (error: any) {
    logger.error('[Admin] Failed to update preferred platforms', error);
    res.status(500).json({
      ok: false,
      error: error?.message ?? 'Failed to update preferred platforms',
    });
  }
}));

// GET /api/v2/brand-profile/preferred-platforms — get current preferred platforms
router.get('/api/v2/brand-profile/preferred-platforms', syncRoute((req, res) => {
  try {
    const preferred = getPreferredPlatforms(db);
    res.json({ preferredPlatforms: preferred });
  } catch (error: any) {
    logger.error('[Admin] Failed to get preferred platforms', error);
    res.status(500).json({
      ok: false,
      error: error?.message ?? 'Failed to get preferred platforms',
    });
  }
}));

// POST /api/platforms/batch-validate — validate multiple API keys in parallel
router.post('/api/platforms/batch-validate', async (req, res) => {
  try {
    const { credentials } = req.body ?? {};
    if (!Array.isArray(credentials)) {
      return res.status(400).json({ error: 'credentials must be an array' });
    }

    const results = await Promise.all(
      credentials.map(async (cred: any) => {
        const platformId = cred.platformId as string;
        const apiKey = cred.apiKey as string;

        if (typeof platformId !== 'string' || typeof apiKey !== 'string') {
          return { platformId, ok: false, error: 'Invalid input' };
        }

        const adapter = allAdapters.find(a => getAdapterId(a) === platformId);
        if (!adapter || adapter.isBrowserAutomation) {
          return { platformId, ok: false, error: 'Platform not found or is browser automation' };
        }

        logger.info(`[Admin] Testing API key for ${adapter.name}...`);

        const envKeyMap: Record<string, string | string[]> = {
          'devto':      'DEVTO_API_KEY',
          'medium':     'MEDIUM_INTEGRATION_TOKEN',
          'hashnode':   'HASHNODE_TOKEN',
          'github':     'GITHUB_TOKEN',
          'blogger':    'GOOGLE_APPLICATION_CREDENTIALS_JSON',
          'wordpress':  'WORDPRESS_SITE_URL',
          'telegraph':  'TELEGRA_PH_TOKEN',
          'twitter':    ['TWITTER_CONSUMER_KEY','TWITTER_CONSUMER_SECRET','TWITTER_ACCESS_TOKEN','TWITTER_ACCESS_TOKEN_SECRET'],
          'instapaper': 'INSTAPAPER_USERNAME',
        };

        const envVar = envKeyMap[platformId];
        if (!envVar) {
          return { platformId, ok: false, error: 'Cannot validate this platform type' };
        }

        // Batch-validate only tests — always restore the original values afterward.
        const saved: Record<string, string | undefined> = {};
        const restore = () => {
          for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
          }
        };

        if (Array.isArray(envVar)) {
          let parsed: Record<string, string>;
          try { parsed = JSON.parse(apiKey); } catch {
            return { platformId, ok: false, error: 'Twitter requires JSON with ck, cs, at, as' };
          }
          const [ck, cs, at, as_] = envVar;
          saved[ck] = process.env[ck]; saved[cs] = process.env[cs];
          saved[at] = process.env[at]; saved[as_] = process.env[as_];
          process.env[ck] = parsed.ck; process.env[cs] = parsed.cs;
          process.env[at] = parsed.at; process.env[as_] = parsed.as;
        } else {
          saved[envVar] = process.env[envVar];
          process.env[envVar] = apiKey;
        }

        try {
          const testResult = await adapter.testConnection?.();
          return { platformId, ok: testResult?.ok ?? true, error: testResult?.error };
        } finally {
          restore();
        }
      }),
    );

    res.json({ results });
  } catch (error: any) {
    logger.error('[Admin] Batch validation failed', error);
    res.status(500).json({
      ok: false,
      error: error?.message ?? 'Batch validation failed',
    });
  }
});
