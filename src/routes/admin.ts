import express from 'express';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import { allAdapters } from '../adapters/index';
import { db } from '../db';
import { acquirePage, releasePage } from '../utils/browserManager';
import { syncRoute } from './_helpers';
import {
  // credential-store (PR #19)
  updateApiKey,
  batchValidateApiKeys,
  // platforms (Unit 1)
  getAllPlatformStatuses,
  getDefaultPublishingPlatforms as getDefaultPublishingPlatformsService,
  resolveTargetPlatforms as resolveTargetPlatformsService,
  // brand (Unit 1)
  getBrandProfileWithDispatch,
  saveBrandProfileFromInput,
  runPrecheckForDispatch,
  updatePreferredPlatformsForBrand,
  getPreferredPlatformsForBrand,
  // roi-config (Unit 1)
  getPlatformHealth,
  updateRoiConfig,
} from '../services/admin';
import {
  AUTH_DIR,
  getBrowserAuthMode,
  isBrowserAutomationEnabled,
  hasSavedBrowserSession,
  getAdapterId,
  createBrowserAuthContext,
} from '../services/browser-session';
import { isOAuthConfigured } from '../services/google-oauth';
// Importing twitter-oauth registers twitterAuthStrategy for the platform
// status endpoint to see Twitter as OAuth-supported even when admin.ts is
// loaded before any route file imports twitter-oauth.
import '../services/twitter-oauth';

// Re-exports for routes/publish.ts compat (Unit 7 will remove these — publish
// will then import directly from services/admin/platforms.ts).
export { getAdapterId, hasSavedBrowserSession };

/** @deprecated import from '../services/admin/platforms' instead. Kept for publish.ts compat until Unit 7. */
export function getDefaultPublishingPlatforms(): string[] {
  return getDefaultPublishingPlatformsService(db);
}

/** @deprecated import from '../services/admin/platforms' instead. Kept for publish.ts compat until Unit 7. */
export function resolveTargetPlatforms(platforms?: unknown): string[] {
  return resolveTargetPlatformsService(db, platforms);
}

export const router = express.Router();

router.get('/api/platforms', syncRoute((_req, res) => {
  res.json(getAllPlatformStatuses(db));
}));

router.get('/api/v2/brand-profile', syncRoute((_, res) => {
  res.json(getBrandProfileWithDispatch(db));
}));

router.put('/api/v2/brand-profile', syncRoute((req, res) => {
  const result = saveBrandProfileFromInput(db, req.body);
  if (!result.ok) {
    const status = result.status ?? 422;
    // 400 historically returns { error: <message> }; 422 returns { errors: [...] }
    if (status === 400) return res.status(400).json({ error: result.errors?.[0]?.message ?? 'Invalid body' });
    return res.status(status).json({ errors: result.errors });
  }
  res.json({
    profile: result.profile,
    dispatchReady: result.dispatchReady,
    dispatchReport: result.dispatchReport,
  });
}));

router.post('/api/v2/precheck', syncRoute((req, res) => {
  const result = runPrecheckForDispatch(db, req.body);
  if (!result.ok) return res.status(result.status ?? 500).json({ error: result.error });
  res.json(result.result);
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
    const result = await updateApiKey(db, platformId, apiKey);
    if (!result.ok) {
      const status = result.status ?? 500;
      // 422 / 500 historically use { ok: false, error } shape; 400 / 404 use { error }.
      if (status === 422 || status === 500) return res.status(status).json({ ok: false, error: result.error });
      return res.status(status).json({ error: result.error });
    }
    res.json({
      ok: true,
      platform: result.platform,
      connected_at: result.connected_at,
      test_timestamp: result.test_timestamp,
    });
  } catch (error: any) {
    logger.error('[Admin] Failed to update API key', error);
    res.status(500).json({ ok: false, error: error?.message ?? 'Failed to update API key' });
  }
});

router.get('/api/v2/platform-health', syncRoute((_req, res) => {
  res.json(getPlatformHealth(db));
}));

router.patch('/api/v2/roi-config', syncRoute((req, res) => {
  const result = updateRoiConfig(db, req.body);
  if (!result.ok) return res.status(result.status ?? 400).json({ error: result.error });
  res.json({ daTierConfig: result.daTierConfig, threshold: result.threshold });
}));

router.patch('/api/v2/brand-profile/preferred-platforms', syncRoute((req, res) => {
  try {
    const result = updatePreferredPlatformsForBrand(db, req.body);
    if (!result.ok) return res.status(result.status ?? 500).json({ error: result.error });
    res.json({ ok: true, preferredPlatforms: result.preferredPlatforms });
  } catch (error: any) {
    logger.error('[Admin] Failed to update preferred platforms', error);
    res.status(500).json({ ok: false, error: error?.message ?? 'Failed to update preferred platforms' });
  }
}));

router.get('/api/v2/brand-profile/preferred-platforms', syncRoute((_req, res) => {
  try {
    res.json({ preferredPlatforms: getPreferredPlatformsForBrand(db) });
  } catch (error: any) {
    logger.error('[Admin] Failed to get preferred platforms', error);
    res.status(500).json({ ok: false, error: error?.message ?? 'Failed to get preferred platforms' });
  }
}));

// POST /api/platforms/batch-validate — validate multiple API keys in parallel
router.post('/api/platforms/batch-validate', async (req, res) => {
  try {
    const { credentials } = req.body ?? {};
    if (!Array.isArray(credentials)) {
      return res.status(400).json({ error: 'credentials must be an array' });
    }
    const results = await batchValidateApiKeys(credentials);
    res.json({ results });
  } catch (error: any) {
    logger.error('[Admin] Batch validation failed', error);
    res.status(500).json({ ok: false, error: error?.message ?? 'Batch validation failed' });
  }
});
