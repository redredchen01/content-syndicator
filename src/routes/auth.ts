import express, { Router, Request, Response } from 'express';
import multer from 'multer';
import { importSessions } from '../services/browser-session';
import { allAdapters } from '../adapters';
import { logger } from '../utils/logger';

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
    const result = await adapter.testConnection();

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
