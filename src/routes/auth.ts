import express, { Router, Request, Response } from 'express';
import multer from 'multer';
import { google } from 'googleapis';
import { importSessions } from '../services/browser-session';
import { allAdapters } from '../adapters';
import { logger } from '../utils/logger';
import { db, oauthTokens } from '../db';

const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/blogger'];

function buildOAuth2Client() {
  const base = process.env.APP_BASE_URL?.replace(/\/+$/, '') ?? `http://localhost:${process.env.PORT || 3000}`;
  return new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    `${base}/api/auth/google/callback`,
  );
}

export const router = Router();

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

// GET /api/auth/google/start — redirect user to Google consent page
router.get('/api/auth/google/start', (_req: Request, res: Response) => {
  if (!process.env.GOOGLE_OAUTH_CLIENT_ID || !process.env.GOOGLE_OAUTH_CLIENT_SECRET) {
    return res.status(500).json({ error: 'GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET not configured' });
  }
  const oauth2Client = buildOAuth2Client();
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: GOOGLE_SCOPES,
  });
  logger.info('[Auth] Redirecting to Google OAuth consent page');
  res.redirect(url);
});

// GET /api/auth/google/callback — exchange code, persist tokens
router.get('/api/auth/google/callback', async (req: Request, res: Response) => {
  const { code, error: oauthError } = req.query as Record<string, string>;

  if (oauthError) {
    logger.warn(`[Auth] Google OAuth denied: ${oauthError}`);
    return res.status(400).send(`<h2>Authorization denied</h2><p>${oauthError}</p>`);
  }
  if (!code) {
    return res.status(400).send('<h2>Missing authorization code</h2>');
  }

  try {
    const oauth2Client = buildOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.refresh_token) {
      return res.status(400).send(
        '<h2>No refresh token received.</h2><p>Revoke app access in your Google Account and try again to force a new consent.</p>'
      );
    }

    oauthTokens.upsert(db, 'blogger', {
      access_token: tokens.access_token ?? null,
      refresh_token: tokens.refresh_token,
      expires_at: tokens.expiry_date ?? null,
    });

    logger.info('[Auth] Google OAuth tokens saved for Blogger');
    res.send('<h2>Blogger authorized successfully.</h2><p>You can close this tab and return to the app.</p>');
  } catch (err: any) {
    logger.error('[Auth] Google OAuth callback failed', err);
    res.status(500).send(`<h2>Authorization failed</h2><p>${err.message}</p>`);
  }
});

// GET /api/auth/google/status — check if Blogger OAuth token is stored
router.get('/api/auth/google/status', (_req: Request, res: Response) => {
  const token = oauthTokens.get(db, 'blogger');
  res.json({
    connected: !!token,
    expires_at: token?.expires_at ?? null,
  });
});
