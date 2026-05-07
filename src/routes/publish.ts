import express from 'express';
import path from 'path';
import multer from 'multer';
import { db } from '../db';
import { asyncRoute, syncRoute } from './_helpers';
import {
  runGenerate, runGenerateManual, runGeneratePromo,
  getBatchStatus, getQueueSnapshot,
  startSinglePublish, startAutoPublish, startBulkPublishFromFile,
  runV2Generate, runV2Dispatch, runV2DispatchOverride, runRegenerateVariant,
} from '../services/publish';

export const router = express.Router();
const upload = multer({ dest: path.join(process.cwd(), '.data', 'uploads') });

router.post('/api/generate', asyncRoute(async (req, res) => {
  const r = await runGenerate(req.body);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  res.json(r.payload);
}));
router.post('/api/generate-manual', asyncRoute(async (req, res) => {
  const r = await runGenerateManual(req.body);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  res.json(r.payload);
}));
router.post('/api/generate-promo', asyncRoute(async (req, res) => {
  const r = await runGeneratePromo(req.body);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  res.json(r.payload);
}));
router.get('/api/batch-status/:batchId', syncRoute((req, res) =>
  res.json(getBatchStatus(db, String(req.params.batchId))),
));

router.post('/api/publish', syncRoute((req, res) => {
  const r = startSinglePublish(db, req.body);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  res.json({ success: true, batchId: r.batchId, message: r.message });
}));

router.post('/api/auto-publish', asyncRoute(async (req, res) => {
  const r = await startAutoPublish(db, req.body);
  if ('ok' in r) return res.status(r.status).json({ error: r.error });
  res.json(r);
}));

router.post('/api/bulk-publish', upload.single('file'), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const r = await startBulkPublishFromFile(db, req.file.path, req.body);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  res.json({ success: true, message: r.message });
}));

router.post('/api/v2/generate', asyncRoute(async (req, res) => {
  const r = await runV2Generate(db, req.body);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  res.json({ batchId: r.batchId, variants: r.variants, lintResult: r.lintResult });
}));
router.post('/api/v2/dispatch', syncRoute((req, res) => {
  const r = runV2Dispatch(db, req.body);
  if (!r.ok) return res.status(r.status).json(r.status === 422 ? { error: r.error, invalid: r.invalid } : { error: r.error });
  const { batchId, jobsCreated, variants, skipped, roiEngineStatus } = r;
  res.json({ batchId, jobsCreated, variants, skipped, roiEngineStatus });
}));
router.post('/api/v2/dispatch/override', syncRoute((req, res) => {
  const r = runV2DispatchOverride(db, req.body);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  res.json({ added: r.added });
}));
router.get('/api/v2/queue', syncRoute((req, res) =>
  res.json(getQueueSnapshot(db, typeof req.query.batchId === 'string' ? req.query.batchId : undefined)),
));
router.post('/api/v2/regenerate-variant', asyncRoute(async (req, res) => {
  const r = await runRegenerateVariant(db, req.body);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  res.json({ variant: r.variant, lintResult: r.lintResult });
}));
