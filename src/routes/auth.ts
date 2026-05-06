import express, { Router, Request, Response } from 'express';
import multer from 'multer';
import crypto from 'crypto';
import { importSessions } from '../services/browser-session';
import { allAdapters } from '../adapters';
import { logger } from '../utils/logger';
import { asyncRoute, type Res } from './_helpers';
import { db } from '../db';
import { oauthTokens } from '../db/oauth-tokens';
import {
  isOAuthConfigured,
  generateAuthUrl,
  exchangeCodeForTokens,
  OAUTH_PLATFORM_REGISTRY,
} from '../services/google-oauth';

export const router = Router();

// ── Google OAuth state map (CSRF protection) ───────────────────────────────
// Single-process Express, so an in-memory Map is enough. Each entry is
// one-shot (deleted on first lookup) and expires after 5 minutes.
// A periodic sweep + a hard cap keep the Map bounded under bursty traffic
// (e.g. an unauthenticated /start spammer cannot grow it without bound).
interface PendingState { platform: string; expiresAt: number }
const pendingStates = new Map<string, PendingState>();
const STATE_TTL_MS = 5 * 60 * 1000;
const STATE_MAX_ENTRIES = 1000;

function pruneExpiredStates() {
  const now = Date.now();
  for (const [k, v] of pendingStates) {
    if (v.expiresAt < now) pendingStates.delete(k);
  }
}

// Periodic sweep so the Map cleans up even when no callback traffic arrives.
// Skipped under tests/build-time imports — long-running timers prevent vitest
// from exiting cleanly.
if (process.env.NODE_ENV !== 'test') {
  setInterval(pruneExpiredStates, 60_000).unref();
}


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
  const config = OAUTH_PLATFORM_REGISTRY[platform];
  if (!config) {
    return res.status(400).json({
      error: `Unknown OAuth platform: ${platform}. Supported: ${Object.keys(OAUTH_PLATFORM_REGISTRY).join(', ')}`,
    });
  }
  const scopes = config.scopes;

  pruneExpiredStates();
  if (pendingStates.size >= STATE_MAX_ENTRIES) {
    logger.warn(`[OAuth] pendingStates at cap (${STATE_MAX_ENTRIES}); rejecting /start`);
    return res.status(429).json({
      error: 'Too many concurrent OAuth flows. Please retry shortly.',
    });
  }
  const state = crypto.randomBytes(32).toString('hex');
  pendingStates.set(state, { platform, expiresAt: Date.now() + STATE_TTL_MS });

  const url = generateAuthUrl(state, scopes);
  logger.info(`[OAuth] Starting flow for ${platform}, redirecting to Google`);
  res.redirect(url);
}));

// GET /api/auth/google/callback — Google redirects here after consent.
// Every terminal outcome redirects to /admin.html so the user lands back in
// the UI rather than on a raw JSON page. Failure modes carry a stable
// short error code as ?oauth_error= (full message goes to logs only).
function oauthErrorRedirect(res: Res, code: string) {
  return res.redirect(`/admin.html?oauth_error=${encodeURIComponent(code)}`);
}

router.get('/api/auth/google/callback', asyncRoute(async (req, res) => {
  const { code, state, error: oauthError } = req.query;

  if (oauthError) {
    logger.warn(`[OAuth] User denied or error: ${oauthError}`);
    // If state was sent alongside an error, clean it up so the Map doesn't
    // hold dead entries until TTL.
    if (typeof state === 'string') pendingStates.delete(state);
    return oauthErrorRedirect(res, String(oauthError).slice(0, 64));
  }

  if (typeof code !== 'string' || typeof state !== 'string') {
    return oauthErrorRedirect(res, 'missing_code_or_state');
  }

  pruneExpiredStates();
  const pending = pendingStates.get(state);
  if (!pending) {
    return oauthErrorRedirect(res, 'invalid_state');
  }
  // One-shot: delete immediately to prevent replay
  pendingStates.delete(state);

  if (pending.expiresAt < Date.now()) {
    return oauthErrorRedirect(res, 'state_expired');
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    oauthTokens.save(db, pending.platform, {
      refresh_token: tokens.refresh_token,
      access_token: tokens.access_token ?? null,
      expires_at: tokens.expires_at ?? null,
    });
    logger.info(`[OAuth] ${pending.platform} connected successfully`);
    res.redirect(`/admin.html?connected=${encodeURIComponent(pending.platform)}`);
  } catch (e: any) {
    // Log full message server-side; surface only a short stable code in URL
    // so error.message never leaks into URL/history/referrer logs.
    logger.error(`[OAuth] Token exchange failed: ${e?.message || e}`);
    const code = /refresh_token/i.test(e?.message || '') &&
                 /(no |did not return|missing)/i.test(e?.message || '')
      ? 'no_refresh_token'
      : 'exchange_failed';
    oauthErrorRedirect(res, code);
  }
}));

// DELETE /api/auth/oauth/:platform — disconnect (clear stored tokens)
router.delete('/api/auth/oauth/:platform', asyncRoute(async (req, res) => {
  const platform = String(req.params.platform).toLowerCase();
  if (!OAUTH_PLATFORM_REGISTRY[platform]) {
    return res.status(400).json({ ok: false, error: `Unknown OAuth platform: ${platform}` });
  }
  oauthTokens.delete(db, platform);
  logger.info(`[OAuth] Disconnected ${platform}`);
  res.json({ ok: true, platform });
}));

// Test-only state inspection helpers. Exported unconditionally because the
// production server already trusts in-process imports — these only clear the
// CSRF state Map (equivalent to a process restart for the OAuth flow).
export const __test = {
  clearPendingStates: () => pendingStates.clear(),
  pendingStatesSize: () => pendingStates.size,
};
