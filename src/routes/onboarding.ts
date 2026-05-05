import express from 'express';
import { logger } from '../utils/logger';
import { db } from '../db';
import { getProfile, saveProfile, isReadyForDispatch } from '../services/brand-profile';
import { syncRoute } from './_helpers';
import { allAdapters } from '../adapters';
import { getAdapterId } from '../services/browser-session';

export const router = express.Router();

// Check if user is initialized (brand profile exists + at least one platform connected)
export function isInitialized(): boolean {
  const profile = getProfile(db);
  if (!profile) return false;

  // Check if at least one platform is connected
  return allAdapters.some(adapter => {
    if (adapter.isBrowserAutomation) return false; // Only count API platforms for MVP

    try {
      const result = db.prepare('SELECT api_keys_encrypted FROM brand_profiles LIMIT 1').get();
      if (result && typeof result.api_keys_encrypted === 'string') {
        const apiKeys = JSON.parse(result.api_keys_encrypted);
        return Boolean(apiKeys[getAdapterId(adapter)]);
      }
    } catch (e) {}

    // Check env vars as fallback
    const isConnected = Boolean(
      adapter.name === 'Telegra.ph' ||
      (adapter.name === 'Dev.to' && process.env.DEVTO_API_KEY) ||
      (adapter.name === 'Medium' && process.env.MEDIUM_INTEGRATION_TOKEN) ||
      (adapter.name === 'Hashnode' && process.env.HASHNODE_TOKEN) ||
      (adapter.name === 'GitHub' && process.env.GITHUB_TOKEN) ||
      (adapter.name === 'Blogger' && process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) ||
      (adapter.name === 'WordPress' && process.env.WORDPRESS_SITE_URL)
    );
    return isConnected;
  });
}

// GET /onboarding — check initialization status and return onboarding state
router.get('/onboarding', syncRoute((req, res) => {
  if (isInitialized()) {
    // User is already initialized, redirect to main page
    return res.json({ initialized: true });
  }

  const profile = getProfile(db);
  const dispatch = isReadyForDispatch(db);

  res.json({
    initialized: false,
    profile,
    dispatchReady: dispatch.ready,
  });
}));

// POST /api/onboarding/complete — mark onboarding as complete
router.post('/api/onboarding/complete', syncRoute((req, res) => {
  try {
    const profile = getProfile(db);
    if (!profile) {
      return res.status(412).json({ error: 'Brand profile not found' });
    }

    if (!isInitialized()) {
      return res.status(422).json({
        error: 'Cannot complete onboarding: brand profile + at least one platform required',
      });
    }

    // Update brand profile with onboarding completion timestamp
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE brand_profiles
      SET onboarding_completed_at = ?, updated_at = ?
      WHERE brand_id = 'default'
    `).run(now, now);

    logger.info('[Onboarding] Completed for brand profile');

    res.json({
      success: true,
      completed_at: now,
    });
  } catch (error: any) {
    logger.error('[Onboarding] Failed to complete onboarding', error);
    res.status(500).json({
      success: false,
      error: error?.message ?? 'Failed to complete onboarding',
    });
  }
}));

// POST /api/onboarding/check-brand-name — validate brand name
router.post('/api/onboarding/check-brand-name', syncRoute((req, res) => {
  try {
    const { name } = req.body ?? {};

    if (typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: '品牌名不能为空' });
    }

    if (name.length > 100) {
      return res.status(400).json({ error: '品牌名不能超过 100 个字符' });
    }

    // Check if name contains invalid characters
    if (!/^[\w\s\-·（）()]+$/u.test(name)) {
      return res.status(400).json({ error: '品牌名包含无效字符' });
    }

    res.json({ valid: true });
  } catch (error: any) {
    logger.error('[Onboarding] Failed to validate brand name', error);
    res.status(500).json({ error: 'Validation error' });
  }
}));

// POST /api/onboarding/check-url — validate URL
router.post('/api/onboarding/check-url', syncRoute((req, res) => {
  try {
    const { url } = req.body ?? {};

    if (typeof url !== 'string' || url.trim().length === 0) {
      return res.status(400).json({ error: 'URL 不能为空' });
    }

    // Basic URL validation
    try {
      new URL(url);
      res.json({ valid: true });
    } catch (e) {
      res.status(400).json({ error: '请输入有效的 URL' });
    }
  } catch (error: any) {
    logger.error('[Onboarding] Failed to validate URL', error);
    res.status(500).json({ error: 'Validation error' });
  }
}));

// POST /api/onboarding/save-progress — save onboarding progress to IndexedDB
// This endpoint just returns success; actual storage happens in browser
router.post('/api/onboarding/save-progress', syncRoute((req, res) => {
  res.json({ success: true });
}));
