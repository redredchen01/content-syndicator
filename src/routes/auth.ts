import express, { Router, Request, Response } from 'express';
import multer from 'multer';
import crypto from 'crypto';
import { importSessions } from '../services/browser-session';
import { allAdapters } from '../adapters';
import { logger } from '../utils/logger';
import { asyncRoute } from './_helpers';
import { db } from '../db';
import { oauthTokens } from '../db/oauth-tokens';
import {
  isOAuthConfigured,
  generateAuthUrl,
  exchangeCodeForTokens,
  BLOGGER_OAUTH_SCOPES,
} from '../services/google-oauth';

export const router = Router();

// ── Google OAuth state map (CSRF protection) ───────────────────────────────
// Single-process Express, so an in-memory Map is enough. Each entry is
// one-shot (deleted on first lookup) and expires after 5 minutes.
interface PendingState { platform: string; expiresAt: number }
const pendingStates = new Map<string, PendingState>();
const STATE_TTL_MS = 5 * 60 * 1000;

function pruneExpiredStates() {
  const now = Date.now();
  for (const [k, v] of pendingStates) {
    if (v.expiresAt < now) pendingStates.delete(k);
  }
}

const OAUTH_PLATFORMS: Record<string, string[]> = {
  blogger: BLOGGER_OAUTH_SCOPES,
};

// Configure multer for ZIP file uploads
const upload = multer({
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/zip' || file.originalname.endsWith('.zip')) {
      cb(null, true);
    } else {
      cb(new Error('Only ZIP files are allowed'));
    }
  }
});

// POST /api/auth/import-sessions — batch import browser sessions from ZIP
router.post('/api/auth/import-sessions', upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    logger.info('[Auth] Importing sessions from ZIP file...');
    const result = await importSessions(req.file.buffer);

    res.json({
      success: true,
      imported: result.imported,
      failed: result.failed,
      tested: result.tested,
    });

    if (result.imported.length > 0) {
      logger.info(`[Auth] Successfully imported sessions: ${result.imported.join(', ')}`);
    }
    if (result.failed.length > 0) {
      logger.warn(`[Auth] Failed to import some sessions: ${JSON.stringify(result.failed)}`);
    }
  } catch (error: any) {
    logger.error('[Auth] Failed to import sessions', error);
    res.status(500).json({
      success: false,
      error: error?.message ?? 'Failed to import sessions',
    });
  }
});

// POST /api/auth/test-connection/:platformId — test single platform connection
router.post('/api/auth/test-connection/:platformId', async (req: Request, res: Response) => {
  try {
    const { platformId } = req.params;

    // Find adapter by ID or name
    const adapter = allAdapters.find(a =>
      a.name.toLowerCase().replace(/[^a-z0-9]/g, '') === platformId ||
      a.name.toLowerCase() === platformId
    );

    if (!adapter) {
      return res.status(404).json({ error: `Platform not found: ${platformId}` });
    }

    logger.info(`[Auth] Testing connection for ${adapter.name}...`);
    const result = await adapter.testConnection?.() ?? { ok: true };

    if (result.ok) {
      res.json({ ok: true, platform: adapter.name });
      logger.info(`[Auth] Connection test successful for ${adapter.name}`);
    } else {
      res.status(401).json({ ok: false, platform: adapter.name, error: result.error });
      logger.warn(`[Auth] Connection test failed for ${adapter.name}: ${result.error}`);
    }
  } catch (error: any) {
    logger.error('[Auth] Failed to test connection', error);
    res.status(500).json({
      ok: false,
      error: error?.message ?? 'Failed to test connection',
    });
  }
});

// ── Google OAuth user-flow ─────────────────────────────────────────────────

// GET /api/auth/google/start?platform=blogger — kick off OAuth consent flow
router.get('/api/auth/google/start', asyncRoute(async (req, res) => {
  if (!isOAuthConfigured()) {
    return res.status(503).json({
      error: 'Google OAuth not configured. Set GOOGLE_OAUTH_CLIENT_ID, ' +
        'GOOGLE_OAUTH_CLIENT_SECRET, and OAUTH_REDIRECT_URI in .env.',
    });
  }

  const platform = String(req.query.platform || '').toLowerCase();
  const scopes = OAUTH_PLATFORMS[platform];
  if (!scopes) {
    return res.status(400).json({
      error: `Unknown OAuth platform: ${platform}. Supported: ${Object.keys(OAUTH_PLATFORMS).join(', ')}`,
    });
  }

  pruneExpiredStates();
  const state = crypto.randomBytes(32).toString('hex');
  pendingStates.set(state, { platform, expiresAt: Date.now() + STATE_TTL_MS });

  const url = generateAuthUrl(state, scopes);
  logger.info(`[OAuth] Starting flow for ${platform}, redirecting to Google`);
  res.redirect(url);
}));

// GET /api/auth/google/callback — Google redirects here after consent
router.get('/api/auth/google/callback', asyncRoute(async (req, res) => {
  const { code, state, error: oauthError } = req.query;

  if (oauthError) {
    logger.warn(`[OAuth] User denied or error: ${oauthError}`);
    return res.redirect(`/admin.html?oauth_error=${encodeURIComponent(String(oauthError))}`);
  }

  if (!code || !state) {
    return res.status(400).json({ error: 'Missing code or state' });
  }

  pruneExpiredStates();
  const pending = pendingStates.get(String(state));
  if (!pending) {
    return res.status(400).json({ error: 'Invalid or expired state — possible CSRF or stale link' });
  }
  // One-shot: delete immediately to prevent replay
  pendingStates.delete(String(state));

  if (pending.expiresAt < Date.now()) {
    return res.status(400).json({ error: 'State expired — please reconnect' });
  }

  try {
    const tokens = await exchangeCodeForTokens(String(code));
    oauthTokens.save(db, pending.platform, {
      refresh_token: tokens.refresh_token,
      access_token: tokens.access_token ?? null,
      expires_at: tokens.expires_at ?? null,
    });
    logger.info(`[OAuth] ${pending.platform} connected successfully`);
    res.redirect(`/admin.html?connected=${encodeURIComponent(pending.platform)}`);
  } catch (e: any) {
    logger.error('[OAuth] Token exchange failed', e);
    const msg = e?.message || 'Token exchange failed';
    res.redirect(`/admin.html?oauth_error=${encodeURIComponent(msg)}`);
  }
}));

// DELETE /api/auth/oauth/:platform — disconnect (clear stored tokens)
router.delete('/api/auth/oauth/:platform', asyncRoute(async (req, res) => {
  const platform = String(req.params.platform).toLowerCase();
  if (!OAUTH_PLATFORMS[platform]) {
    return res.status(400).json({ error: `Unknown OAuth platform: ${platform}` });
  }
  oauthTokens.delete(db, platform);
  logger.info(`[OAuth] Disconnected ${platform}`);
  res.json({ ok: true, platform });
}));

// Test-only: expose pendingStates clearing — guarded so prod imports never see it
export const __test = {
  clearPendingStates: () => pendingStates.clear(),
  pendingStatesSize: () => pendingStates.size,
};
