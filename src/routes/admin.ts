import express from 'express';
import { logger } from '../utils/logger';
import { db } from '../db';
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
  // browser-auth (Unit 2)
  prepareBrowserLogin,
  beginBrowserLoginSession,
  prepareBrowserTest,
  beginBrowserTestSession,
  getBrowserSessionStatus,
} from '../services/admin';
import {
  isBrowserAutomationEnabled,
  hasSavedBrowserSession,
  getAdapterId,
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

// Security gate: ENABLE_BROWSER_AUTOMATION must be true. The 403 lives in the
// controller (HTTP precondition, not business) per Plan Unit 2 invariant.
function browserAutomationGuard(intent: string): { ok: true } | { ok: false; status: 403; error: string } {
  if (isBrowserAutomationEnabled()) return { ok: true };
  return {
    ok: false,
    status: 403,
    error: `Browser automation is disabled. Set ENABLE_BROWSER_AUTOMATION=true in .env only when you intentionally want to ${intent}.`,
  };
}

router.post('/api/auth/browser', async (req, res) => {
  const guard = browserAutomationGuard('open controlled browser login windows');
  if (!guard.ok) return res.status(guard.status).json({ error: guard.error });

  const result = await prepareBrowserLogin(req.body?.platform);
  if (!result.ok) return res.status(result.status ?? 500).json({ error: result.error });

  res.json({ success: true, message: result.message });
  // Fire-and-forget: response already sent. Errors only go to logger.
  beginBrowserLoginSession(result.session!).catch(e => logger.error('beginBrowserLoginSession failed', e));
});

router.post('/api/auth/test', async (req, res) => {
  const guard = browserAutomationGuard('test saved browser sessions');
  if (!guard.ok) return res.status(guard.status).json({ error: guard.error });

  const result = await prepareBrowserTest(req.body?.platform);
  if (!result.ok) return res.status(result.status ?? 500).json({ error: result.error });

  res.json({ success: true, message: result.message });
  beginBrowserTestSession(result.session!).catch(e => logger.error('beginBrowserTestSession failed', e));
});

router.get('/api/auth/browser/status/:platform', syncRoute((req, res) => {
  res.json(getBrowserSessionStatus(String(req.params.platform)));
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
