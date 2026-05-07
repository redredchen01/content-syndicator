import express from 'express';
import { logger } from '../utils/logger';
import { syncRoute } from './_helpers';
import {
  db, isBrowserAutomationEnabled,
  updateApiKey, batchValidateApiKeys, getAllPlatformStatuses,
  getBrandProfileWithDispatch, saveBrandProfileFromInput, runPrecheckForDispatch,
  updatePreferredPlatformsForBrand, getPreferredPlatformsForBrand,
  getPlatformHealth, updateRoiConfig,
  prepareBrowserLogin, beginBrowserLoginSession,
  prepareBrowserTest, beginBrowserTestSession, getBrowserSessionStatus,
} from '../services/admin';

export const router = express.Router();

// HTTP precondition: ENABLE_BROWSER_AUTOMATION gate stays in controller (not service) per Plan Unit 2.
const browserGuard = (intent: string) => isBrowserAutomationEnabled() ? null
  : { status: 403, body: { error: `Browser automation is disabled. Set ENABLE_BROWSER_AUTOMATION=true in .env only when you intentionally want to ${intent}.` } };
const okErrorAsync = (label: string, fn: (req: express.Request, res: express.Response) => Promise<unknown>) => async (req: express.Request, res: express.Response) => {
  try { await fn(req, res); } catch (e: any) { logger.error(`[Admin] ${label}`, e); if (!res.headersSent) res.status(500).json({ ok: false, error: e?.message ?? label }); }
};

router.get('/api/platforms', syncRoute((_req, res) => res.json(getAllPlatformStatuses(db))));
router.get('/api/v2/brand-profile', syncRoute((_, res) => res.json(getBrandProfileWithDispatch(db))));
router.put('/api/v2/brand-profile', syncRoute((req, res) => {
  const r = saveBrandProfileFromInput(db, req.body);
  if (!r.ok) return res.status(r.status ?? 422).json(r.status === 400 ? { error: r.errors?.[0]?.message ?? 'Invalid body' } : { errors: r.errors });
  res.json({ profile: r.profile, dispatchReady: r.dispatchReady, dispatchReport: r.dispatchReport });
}));
router.post('/api/v2/precheck', syncRoute((req, res) => {
  const r = runPrecheckForDispatch(db, req.body);
  if (!r.ok) return res.status(r.status ?? 500).json({ error: r.error });
  res.json(r.result);
}));
router.post('/api/auth/browser', okErrorAsync('Failed to start browser login', async (req, res) => {
  const g = browserGuard('open controlled browser login windows'); if (g) return res.status(g.status).json(g.body);
  const r = await prepareBrowserLogin(req.body?.platform); if (!r.ok) return res.status(r.status ?? 500).json({ error: r.error });
  res.json({ success: true, message: r.message });
  beginBrowserLoginSession(r.session!).catch(e => logger.error('beginBrowserLoginSession failed', e));
}));
router.post('/api/auth/test', okErrorAsync('Failed to start browser test', async (req, res) => {
  const g = browserGuard('test saved browser sessions'); if (g) return res.status(g.status).json(g.body);
  const r = await prepareBrowserTest(req.body?.platform); if (!r.ok) return res.status(r.status ?? 500).json({ error: r.error });
  res.json({ success: true, message: r.message });
  beginBrowserTestSession(r.session!).catch(e => logger.error('beginBrowserTestSession failed', e));
}));
router.get('/api/auth/browser/status/:platform', syncRoute((req, res) => res.json(getBrowserSessionStatus(String(req.params.platform)))));
router.patch('/api/platforms/:platformId/api-key', okErrorAsync('Failed to update API key', async (req, res) => {
  const r = await updateApiKey(db, String(req.params.platformId), req.body?.apiKey);
  if (!r.ok) { const s = r.status ?? 500; return res.status(s).json(s === 422 || s === 500 ? { ok: false, error: r.error } : { error: r.error }); }
  res.json({ ok: true, platform: r.platform, connected_at: r.connected_at, test_timestamp: r.test_timestamp });
}));
router.get('/api/v2/platform-health', syncRoute((_req, res) => res.json(getPlatformHealth(db))));
router.patch('/api/v2/roi-config', syncRoute((req, res) => {
  const r = updateRoiConfig(db, req.body);
  if (!r.ok) return res.status(r.status ?? 400).json({ error: r.error });
  res.json({ daTierConfig: r.daTierConfig, threshold: r.threshold });
}));
router.patch('/api/v2/brand-profile/preferred-platforms', okErrorAsync('Failed to update preferred platforms', async (req, res) => {
  const r = updatePreferredPlatformsForBrand(db, req.body);
  if (!r.ok) return res.status(r.status ?? 500).json({ error: r.error });
  res.json({ ok: true, preferredPlatforms: r.preferredPlatforms });
}));
router.get('/api/v2/brand-profile/preferred-platforms', okErrorAsync('Failed to get preferred platforms', async (_req, res) => {
  res.json({ preferredPlatforms: getPreferredPlatformsForBrand(db) });
}));
router.post('/api/platforms/batch-validate', okErrorAsync('Batch validation failed', async (req, res) => {
  const { credentials } = req.body ?? {};
  if (!Array.isArray(credentials)) return res.status(400).json({ error: 'credentials must be an array' });
  res.json({ results: await batchValidateApiKeys(credentials) });
}));
