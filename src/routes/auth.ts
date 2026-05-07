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
  OAUTH_PLATFORM_REGISTRY,
} from '../services/google-oauth';
// Import twitter-oauth to trigger self-registration of twitterAuthStrategy.
import '../services/twitter-oauth';
// Import wordpress-oauth to trigger self-registration of wordpressAuthStrategy.
import '../services/wordpress-oauth';
import {
  AuthStrategy,
  getStrategyByProvider,
} from '../services/auth-strategy';
import { loopbackOnly } from '../middleware/loopback-only';

export const router = Router();

// ── OAuth state map (CSRF protection, shared across providers) ─────────────
// Single-process Express, so an in-memory Map is enough. Each entry is
// one-shot (deleted on first lookup) and expires after 5 minutes.
// A periodic sweep + a hard cap keep the Map bounded under bursty traffic
// (e.g. an unauthenticated /start spammer cannot grow it without bound).
//
// `extras` carries provider-specific state-bound data (e.g. PKCE code_verifier
// for Twitter). Google flow leaves it empty.
interface PendingState {
  providerId: string;
  platform: string;
  expiresAt: number;
  extras?: Record<string, unknown>;
}
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

// ── OAuth user-flows (per-provider routes share these helpers) ────────────

function oauthErrorRedirect(res: Res, code: string) {
  return res.redirect(`/admin.html?oauth_error=${encodeURIComponent(code)}`);
}

/** Pure error-code mapper used by the per-provider callback handlers. */
function classifyExchangeError(message: string): 'no_refresh_token' | 'exchange_failed' {
  return /refresh_token/i.test(message) &&
         /(no |did not return|missing)/i.test(message)
    ? 'no_refresh_token'
    : 'exchange_failed';
}

/**
 * Common /start handler. Resolves the strategy + platform, generates state,
 * stores any extras the strategy attaches (e.g. PKCE codeVerifier), and
 * redirects the user to the provider's consent page.
 */
function handleOAuthStart(strategy: AuthStrategy, knownPlatforms: string[]) {
  return asyncRoute(async (req, res) => {
    if (!strategy.isConfigured()) {
      return res.status(503).json({
        error: `${strategy.providerLabel} OAuth not configured. Check the env vars for this provider in .env.`,
      });
    }

    const platform = String(req.query.platform || '').toLowerCase();
    if (!knownPlatforms.includes(platform)) {
      return res.status(400).json({
        error: `Unknown OAuth platform: ${platform}. Supported: ${knownPlatforms.join(', ')}`,
      });
    }

    pruneExpiredStates();
    if (pendingStates.size >= STATE_MAX_ENTRIES) {
      logger.warn(`[OAuth] pendingStates at cap (${STATE_MAX_ENTRIES}); rejecting /start`);
      return res.status(429).json({ error: 'Too many concurrent OAuth flows. Please retry shortly.' });
    }

    const state = crypto.randomBytes(32).toString('hex');
    const extras: Record<string, unknown> = {};
    const url = strategy.generateAuthUrl({
      state,
      attach: (data) => Object.assign(extras, data),
    });
    pendingStates.set(state, {
      providerId: strategy.providerId,
      platform,
      expiresAt: Date.now() + STATE_TTL_MS,
      extras: Object.keys(extras).length ? extras : undefined,
    });

    logger.info(`[OAuth] Starting ${strategy.providerId} flow for ${platform}`);
    res.redirect(url);
  });
}

/**
 * Common /callback handler. Validates state, exchanges code, persists tokens,
 * redirects back to admin.html with a stable error code on any failure.
 */
function handleOAuthCallback(expectedProviderId: string) {
  return asyncRoute(async (req, res) => {
    const { code, state, error: oauthError } = req.query;

    if (oauthError) {
      logger.warn(`[OAuth] User denied or error: ${oauthError}`);
      if (typeof state === 'string') pendingStates.delete(state);
      return oauthErrorRedirect(res, String(oauthError).slice(0, 64));
    }

    if (typeof code !== 'string' || typeof state !== 'string') {
      return oauthErrorRedirect(res, 'missing_code_or_state');
    }

    pruneExpiredStates();
    const pending = pendingStates.get(state);
    if (!pending) return oauthErrorRedirect(res, 'invalid_state');

    // Validate all conditions BEFORE consuming the one-shot token.
    // Original order deleted first then checked expiry — a refactor could
    // accidentally re-use a deleted state. Correct order: check, then delete.
    if (pending.expiresAt < Date.now()) {
      pendingStates.delete(state);
      return oauthErrorRedirect(res, 'state_expired');
    }
    if (pending.providerId !== expectedProviderId) {
      pendingStates.delete(state);
      return oauthErrorRedirect(res, 'invalid_state');
    }
    pendingStates.delete(state); // one-shot — consumed after all guards pass

    const strategy = getStrategyByProvider(pending.providerId);
    if (!strategy) return oauthErrorRedirect(res, 'unknown_provider');

    try {
      const tokens = await strategy.exchangeCodeForTokens(code, pending.extras);
      oauthTokens.save(db, pending.platform, {
        refresh_token: tokens.refresh_token,
        access_token: tokens.access_token ?? null,
        expires_at: tokens.expires_at ?? null,
      });
      logger.info(`[OAuth] ${pending.platform} connected successfully via ${strategy.providerId}`);
      res.redirect(`/admin.html?connected=${encodeURIComponent(pending.platform)}`);
    } catch (e: any) {
      logger.error(`[OAuth] Token exchange failed (${strategy.providerId}): ${e?.message || e}`);
      oauthErrorRedirect(res, classifyExchangeError(e?.message || ''));
    }
  });
}

// ── Google OAuth (Blogger) ──────────────────────────────────────────────────
// loopback-only: ops action that initiates a credential-binding flow.
// /callback stays open (provider must reach it; state Map handles CSRF).
router.get(
  '/api/auth/google/start',
  loopbackOnly,
  handleOAuthStart(getStrategyByProvider('google')!, Object.keys(OAUTH_PLATFORM_REGISTRY)),
);
router.get('/api/auth/google/callback', handleOAuthCallback('google'));

// ── Twitter / X OAuth ───────────────────────────────────────────────────────
const TWITTER_PLATFORMS = ['twitter'];
router.get(
  '/api/auth/twitter/start',
  loopbackOnly,
  handleOAuthStart(getStrategyByProvider('twitter')!, TWITTER_PLATFORMS),
);
router.get('/api/auth/twitter/callback', handleOAuthCallback('twitter'));

// ── WordPress.com OAuth ─────────────────────────────────────────────────────
const WORDPRESS_PLATFORMS = ['wordpress'];
router.get(
  '/api/auth/wordpress/start',
  loopbackOnly,
  handleOAuthStart(getStrategyByProvider('wordpress')!, WORDPRESS_PLATFORMS),
);
router.get('/api/auth/wordpress/callback', handleOAuthCallback('wordpress'));

// ── DELETE /api/auth/oauth/:platform — disconnect (clear stored tokens) ────
// Loopback-only: anyone able to hit this can break a connected operator's
// publishing pipeline by revoking their OAuth row.
const KNOWN_PLATFORMS = new Set([
  ...Object.keys(OAUTH_PLATFORM_REGISTRY),
  ...TWITTER_PLATFORMS,
  ...WORDPRESS_PLATFORMS,
]);
router.delete('/api/auth/oauth/:platform', loopbackOnly, asyncRoute(async (req, res) => {
  const platform = String(req.params.platform).toLowerCase();
  if (!KNOWN_PLATFORMS.has(platform)) {
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

// GET /api/auth/google/status?platform=blogger — lightweight connection probe
// (additive endpoint kept from the upstream branch's parallel work; complements
// /api/platforms by exposing only the OAuth-status fields).
router.get('/api/auth/google/status', (req, res) => {
  const platform = String(req.query.platform || 'blogger').toLowerCase();
  const token = oauthTokens.get(db, platform);
  res.json({
    platform,
    connected: !!token,
    expires_at: token?.expires_at ?? null,
  });
});
