import express from 'express';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import { PlatformAdapter } from '../adapters/base';
import { allAdapters } from '../adapters/index';
import { db } from '../db';
import { getProfile, saveProfile, isReadyForDispatch } from '../services/brand-profile';
import { autoConfigureFromUrl } from '../services/brand-auto-configure';
import { runPrecheck } from '../services/anchor-monitor';
import { acquirePage, releasePage } from '../utils/browserManager';
import { asyncRoute, syncRoute } from './_helpers';
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
  'Telegra.ph': () => true,
  'Dev.to':     () => Boolean(process.env.DEVTO_API_KEY),
  'Medium':     () => Boolean(process.env.MEDIUM_INTEGRATION_TOKEN),
  'Hashnode':   () => Boolean(process.env.HASHNODE_TOKEN && process.env.HASHNODE_PUBLICATION_ID),
  'GitHub':     () => Boolean(process.env.GITHUB_TOKEN),
  'Blogger':    () => Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON && process.env.BLOGGER_BLOG_ID),
  'WordPress':  () => Boolean(process.env.WORDPRESS_SITE_URL && process.env.WORDPRESS_USERNAME && process.env.WORDPRESS_APP_PASSWORD),
};

function isAdapterConnected(adapter: PlatformAdapter): boolean {
  if (adapter.isBrowserAutomation) return isBrowserAutomationEnabled() && hasSavedBrowserSession(adapter);
  return API_CONNECTED[adapter.name]?.() ?? false;
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

  return { connected, defaultEligible, reason };
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

router.post('/api/v2/brand-profile/auto-configure', asyncRoute(async (req, res) => {
  const { url } = req.body ?? {};
  if (!url || !/^https?:\/\//.test(url)) {
    return res.status(400).json({ error: '请提供有效的品牌网址（http/https）' });
  }
  const result = await autoConfigureFromUrl(url);
  res.json(result);
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

  let loginUrl = '';
  if (platform === 'medium') loginUrl = 'https://medium.com/m/signin';
  else if (platform === 'devto') loginUrl = 'https://dev.to/enter';
  else if (platform === 'google' || platform === 'blogger') loginUrl = 'https://accounts.google.com/';
  else if (adapter && adapter.config && adapter.config.composeUrl) {
    loginUrl = adapter.config.composeUrl;
  } else {
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
