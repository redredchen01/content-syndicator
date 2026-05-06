import express from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import csv from 'csv-parser';
import { logger, randomSleep } from '../utils/logger';
import { scrapeUrl } from '../scraper';
import { generateMarkdown, generatePromoMarkdown } from '../llm';
import { allAdapters } from '../adapters/index';
import { appendToSheet } from '../sheets';
import { db, savePost } from '../db';
import { publishJobs } from '../db/repositories';
import { asyncRoute, syncRoute } from './_helpers';
import { resolveTargetPlatforms } from './admin';
import { getPreferredPlatforms } from '../services/brand-profile';
import { publishToPlatforms as publishService } from '../services/publish-service';

export const router = express.Router();

const upload = multer({ dest: path.join(process.cwd(), '.data', 'uploads') });


async function runPublishingTask(batchId: string, options: any) {
  const jobs = db.prepare(
    `SELECT id, platform FROM publish_jobs WHERE batch_id = ? AND status = 'scheduled'`,
  ).all(batchId);

  for (const job of jobs as any[]) {
    publishJobs.markRunning(db, job.id);

    const adapter = allAdapters.find(a => a.name === job.platform);
    if (!adapter) {
      publishJobs.markFailed(db, job.id, 'Adapter not found', null, 2);
      continue;
    }

    try {
      logger.info(`[Async Worker] Publishing ${batchId} to ${job.platform}...`);
      const result = await adapter.publish({
        title: options.title,
        markdownContent: options.content,
        tags: options.tags,
        excerpt: options.excerpt,
        originalUrl: options.sourceUrl,
        publishStatus: options.publishStatus,
      });

      if (result.success) {
        publishJobs.markSucceededWithUrl(db, job.id, result.publishedUrl || '');
      } else {
        publishJobs.markFailed(db, job.id, result.error || 'Unknown error', null, 2);
      }
    } catch (err: any) {
      publishJobs.markFailed(db, job.id, err.message, null, 2);
    }

    await new Promise(resolve => setTimeout(resolve, 5000 + Math.random() * 5000));
  }

  const finalJobs = publishJobs.byBatch(db, batchId);
  const formattedResults = finalJobs.map(r => ({
    platform: r.platform,
    success: r.status === 'succeeded',
    error: r.last_error ?? undefined,
    publishedUrl: r.status === 'succeeded' ? JSON.parse(r.metadata_json || '{}').publishedUrl : undefined
  }));

  appendToSheet(options.sourceUrl, options.title, formattedResults).catch(e => logger.error('Sheets sync error', e));
  savePost(options.sourceUrl, options.title, options.content, formattedResults, batchId);
}

async function processBulkQueue(urls: string[], targetPlatforms: string[], publishStatus: 'draft' | 'public') {
  logger.info(`Starting bulk queue processing for ${urls.length} URLs...`);
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    logger.info(`[Bulk ${i+1}/${urls.length}] Processing URL: ${url}`);

    try {
      logger.info(`[Bulk ${i+1}/${urls.length}] Scraping...`);
      const scrapedData = await scrapeUrl(url);

      logger.info(`[Bulk ${i+1}/${urls.length}] Generating markdown...`);
      const { title, content, tags, excerpt } = await generateMarkdown(scrapedData);

      logger.info(`[Bulk ${i+1}/${urls.length}] Publishing and saving results...`);
      await publishService({
        sourceUrl: url,
        title,
        content,
        tags,
        excerpt,
        platforms: targetPlatforms,
        publishStatus
      });

      logger.success(`[Bulk ${i+1}/${urls.length}] Finished processing URL.`);
    } catch(err: any) {
      logger.error(`[Bulk ${i+1}/${urls.length}] Failed processing URL ${url}`, err);
    }

    if (i < urls.length - 1) {
      const sleepTime = Math.floor(Math.random() * (60000 - 30000 + 1)) + 30000;
      logger.info(`[Bulk] Sleeping for ${sleepTime/1000}s before next article...`);
      await randomSleep(sleepTime, sleepTime);
    }
  }
  logger.success('Bulk queue processing completed entirely.');
}

router.post('/api/generate', asyncRoute(async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  logger.info(`API: Starting scrape for URL: ${url}`);
  const scrapedData = await scrapeUrl(url);
  logger.info('API: Calling LLM to generate Markdown content...');
  const { title, content, tags, excerpt } = await generateMarkdown(scrapedData);
  res.json({ title, content, originalUrl: url, tags, excerpt });
}));

router.post('/api/generate-manual', asyncRoute(async (req, res) => {
  const { rawContent, originalUrl } = req.body;
  if (!rawContent) return res.status(400).json({ error: 'rawContent is required' });

  logger.info('API: Rewriting manual content via LLM...');
  const { title, content, tags, excerpt } = await generateMarkdown({
    title: 'Manual Content',
    content: rawContent,
    originalUrl: originalUrl || '',
  });
  res.json({ title, content, originalUrl, tags, excerpt });
}));

router.post('/api/generate-promo', asyncRoute(async (req, res) => {
  const { title, content, urls } = req.body;
  if (!title || !content || !Array.isArray(urls)) {
    return res.status(400).json({ error: 'Missing required fields: title, content, urls' });
  }
  logger.info('API: Generating promotional Markdown via LLM...');
  const promo = await generatePromoMarkdown(title, content, urls);
  res.json({ title: promo.title, content: promo.content, tags: promo.tags, excerpt: promo.excerpt });
}));

router.get('/api/batch-status/:batchId', syncRoute((req, res) => {
  const batchId = req.params.batchId as string;
  const jobs = publishJobs.byBatch(db, batchId);
  const total = jobs.length;
  const completed = jobs.filter(j =>
    ['succeeded', 'failed_terminal', 'skipped'].includes(j.status),
  ).length;
  res.json({
    batchId,
    percent: total > 0 ? Math.round((completed / total) * 100) : 0,
    total,
    completed,
    jobs,
    isFinished: completed === total && total > 0,
  });
}));

router.post('/api/publish', asyncRoute(async (req, res) => {
  const { url, title, content, tags, excerpt, platforms, publishStatus } = req.body;
  logger.info(`API Request: /api/publish - Title: ${title}, Platforms: ${JSON.stringify(platforms)}`);

  if (!title || !content) return res.status(400).json({ error: 'Missing required fields: title or content' });

  const sourceUrl = url || 'manual-content';

  // Use preferred platforms if available and no explicit platforms specified
  let targetPlatforms: string[];
  if (!platforms || (Array.isArray(platforms) && platforms.length === 0)) {
    const preferred = getPreferredPlatforms(db);
    targetPlatforms = preferred.length > 0 ? preferred : resolveTargetPlatforms(platforms);
  } else {
    targetPlatforms = resolveTargetPlatforms(platforms);
  }

  if (targetPlatforms.length === 0) return res.status(400).json({ error: 'No connected or valid platforms available.' });

  const batchId = `batch_${Date.now()}`;
  logger.info(`Creating batch ${batchId} for ${targetPlatforms.length} platforms...`);

  const insertJob = db.prepare(`
    INSERT INTO publish_jobs (batch_id, variant_id, platform, job_type, status, scheduled_at, payload_json)
    VALUES (?, 'v1', ?, 'publish', 'scheduled', CURRENT_TIMESTAMP, '{}')
  `);
  try {
    db.transaction((pforms: string[]) => { for (const p of pforms) insertJob.run(batchId, p); })(targetPlatforms);
  } catch (dbErr: any) {
    return res.status(500).json({ error: `Database Error: ${dbErr.message}` });
  }

  runPublishingTask(batchId, { sourceUrl, title, content, tags, excerpt, publishStatus: publishStatus || 'draft' })
    .catch(e => logger.error(`Background task for ${batchId} failed early`, e));

  logger.success(`Batch ${batchId} started.`);
  res.json({ success: true, batchId, message: 'Publishing task started in background' });
}));

router.post('/api/auto-publish', asyncRoute(async (req, res) => {
  const { mode, url, rawContent, originalUrl, platforms, publishStatus } = req.body;
  const normalizedStatus: 'draft' | 'public' = publishStatus === 'public' ? 'public' : 'draft';

  let sourceUrl: string;
  let generated;

  if (mode === 'manual') {
    if (!rawContent) return res.status(400).json({ error: 'rawContent is required for manual auto-publish' });
    sourceUrl = originalUrl || 'manual-content';
    logger.info('API: Auto-publish manual content. Generating markdown...');
    generated = await generateMarkdown({ title: 'Manual Content', content: rawContent, originalUrl: sourceUrl });
  } else {
    if (!url) return res.status(400).json({ error: 'url is required for URL auto-publish' });
    sourceUrl = url;
    logger.info(`API: Auto-publish URL. Scraping: ${url}`);
    generated = await generateMarkdown(await scrapeUrl(url));
  }

  // Resolve target platforms before ROI filter (mirrors publishService internal logic)
  let targetPlatforms: string[];
  if (Array.isArray(platforms) && platforms.length > 0) {
    targetPlatforms = (platforms as unknown[]).filter((p): p is string => typeof p === 'string' && p.trim() !== '');
  } else {
    targetPlatforms = allAdapters
      .filter(a => !a.isBrowserAutomation || Boolean(a.canPublishAutomatically))
      .map(a => a.name);
  }

  // ROI filter: build mock variants (one per platform) and filter low-ROI platforms
  const mockVariants = targetPlatforms.map(platform => ({
    variant_id: `auto_${platform}`,
    platform,
    persona_group: 'tech_blogger' as const,
    title: generated.title,
    body_markdown: generated.content,
    anchor_words: [] as string[],
    target_url: sourceUrl,
    generation_status: 'ok' as const,
  }));
  const roiResult = filterByRoi(mockVariants, db);
  if (roiResult.skipped.length > 0) {
    logger.info(`[auto-publish] ROI filter skipped platforms: ${roiResult.skipped.map(s => `${s.platform}(${s.score.toFixed(2)})`).join(', ')}`);
  }
  const eligiblePlatforms = roiResult.eligible.map(v => v.platform);

  const { targetPlatforms: usedPlatforms, results } = await publishService({
    sourceUrl, title: generated.title, content: generated.content,
    tags: generated.tags, excerpt: generated.excerpt,
    platforms: eligiblePlatforms, publishStatus: normalizedStatus,
  });

  res.json({
    success: true, mode: mode === 'manual' ? 'manual' : 'url',
    platforms: usedPlatforms, originalUrl: sourceUrl,
    title: generated.title, content: generated.content,
    tags: generated.tags, excerpt: generated.excerpt, results,
  });
}));

router.post('/api/bulk-publish', upload.single('file'), (req, res) => {
  try {
    const { platforms, publishStatus } = req.body;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    let parsedPlatforms = platforms;
    try {
      if (typeof platforms === 'string') parsedPlatforms = JSON.parse(platforms);
    } catch(e) {}

    let targetPlatforms: string[];
    if (!parsedPlatforms || (Array.isArray(parsedPlatforms) && parsedPlatforms.length === 0)) {
      const preferred = getPreferredPlatforms(db);
      targetPlatforms = preferred.length > 0 ? preferred : resolveTargetPlatforms(parsedPlatforms);
    } else {
      targetPlatforms = resolveTargetPlatforms(parsedPlatforms);
    }
    if (targetPlatforms.length === 0) {
      return res.status(400).json({ error: 'No connected platforms available. Connect at least one channel in Settings first.' });
    }

    const urls: string[] = [];

    fs.createReadStream(req.file.path)
      .pipe(csv(['url']))
      .on('data', (data) => {
        const url = data.url || data[Object.keys(data)[0]];
        if (url && typeof url === 'string' && url.startsWith('http')) {
          urls.push(url.trim());
        }
      })
      .on('end', () => {
        try { fs.unlinkSync(req.file!.path); } catch(e) {}

        if (urls.length === 0) {
          return res.status(400).json({ error: 'No valid URLs found in the CSV file.' });
        }

        processBulkQueue(urls, targetPlatforms, publishStatus === 'public' ? 'public' : 'draft');

        res.json({ success: true, message: `Bulk process started for ${urls.length} URLs in the background. You can safely close this page.` });
      });

  } catch (error: any) {
    logger.error('API /api/bulk-publish Error', error);
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// v0.2 API: generate variants + dispatch publish_jobs
// ---------------------------------------------------------------------------

import { generateVariants, generateSingleVariant } from '../services/variant-generator';
import { attachAnchors } from '../services/anchor-generator';
import { runLint } from '../services/lint';
import { getProfile } from '../services/brand-profile';
import { anchorHistory } from '../db/repositories';
import { dispatchVariantJobs } from '../services/queue/publish-worker';
import { filterByRoi } from '../services/roi-scorer';

router.post('/api/v2/generate', asyncRoute(async (req, res) => {
  const { draft, title, target_url_override } = req.body;
  if (!draft) return res.status(400).json({ error: 'draft is required' });

  const brand = getProfile(db);
  if (!brand) return res.status(400).json({ error: 'Brand profile not configured' });

  // Step 1: Generate 7 variant bodies (concurrency=3)
  const { batchId, variants } = await generateVariants({ draft, title, target_url_override, brand }, db);

  // Step 2: Attach anchor words (concurrency=3)
  const recentTopAnchors = anchorHistory.topInRecentBatches(db, 30, 10).map(r => r.anchor);
  const withAnchors = await attachAnchors(variants, brand, recentTopAnchors, db);

  // Step 3: Run lint gate
  const lintResult = runLint(withAnchors, brand);

  res.json({ batchId, variants: withAnchors, lintResult });
}));

router.post('/api/v2/dispatch', asyncRoute(async (req, res) => {
  const { batchId, variants } = req.body;
  if (!batchId || !Array.isArray(variants)) {
    return res.status(400).json({ error: 'batchId and variants[] are required' });
  }

  // Server-side guard — the frontend should already block these, but defence-in-depth
  // prevents a bypassed UI from enqueuing unusable jobs.
  type DispatchVariant = { platform: string; anchor_words?: string[]; body_markdown?: string };
  const MIN_BODY_CHARS = 100;
  const invalid = (variants as DispatchVariant[]).filter(v => {
    if (v.anchor_words?.includes('__naked_url__')) return true; // anchor generation failed completely
    if (!v.body_markdown || v.body_markdown.trim().length < MIN_BODY_CHARS) return true;
    return false;
  });
  if (invalid.length > 0) {
    return res.status(422).json({
      error: 'Some variants are not ready to dispatch',
      invalid: invalid.map(v => ({
        platform: v.platform,
        reason: v.anchor_words?.includes('__naked_url__') ? 'naked_url_fallback' : 'body_too_short',
      })),
    });
  }

  // ROI filter — only enqueue variants that pass the ROI threshold
  const roiResult = filterByRoi(variants as import('../types').Variant[], db);

  dispatchVariantJobs(roiResult.eligible, batchId, db, roiResult.roiScores);

  const jobs = publishJobs.byBatch(db, batchId);
  res.json({
    batchId,
    jobsCreated: jobs.length,
    variants: roiResult.eligible,
    skipped: roiResult.skipped,
    roiEngineStatus: roiResult.engineStatus,
  });
}));

// POST /api/v2/dispatch/override — force-enqueue skipped variants for selected platforms
router.post('/api/v2/dispatch/override', asyncRoute(async (req, res) => {
  const { batchId, platforms, variants } = req.body;
  if (!batchId || !Array.isArray(platforms) || platforms.length === 0) {
    return res.status(400).json({ error: 'batchId and platforms[] are required' });
  }
  if (!Array.isArray(variants) || variants.length === 0) {
    return res.status(400).json({ error: 'variants[] are required' });
  }

  const overrideScore = 0.5;
  const added: string[] = [];

  for (const platform of platforms as string[]) {
    const variant = (variants as import('../types').Variant[]).find(v => v.platform === platform);
    if (!variant) continue;

    const roiScores = new Map<string, number>([[platform, overrideScore]]);
    dispatchVariantJobs([variant], batchId, db, roiScores);
    added.push(platform);
  }

  res.json({ added });
}));

// GET /api/v2/queue — for queue status page (polled every 5s)
router.get('/api/v2/queue', syncRoute((req, res) => {
  const { batchId } = req.query;
  const jobs = batchId
    ? publishJobs.byBatch(db, String(batchId))
    : (db.prepare(
        `SELECT * FROM publish_jobs ORDER BY created_at DESC LIMIT 200`,
      ).all() as import('../db/repositories').PublishJob[]);
  res.json({ jobs });
}));

// POST /api/v2/regenerate-variant — single-tab regeneration
//
// Accepts `siblings` (the other variants already on screen) so the endpoint
// can merge them with the newly generated variant and re-run the full lint
// pipeline (including pairwise Jaccard).  Without siblings the frontend
// only clears the per-platform violation and silently skips Jaccard — a
// user could regenerate to escape a similarity violation without it being
// re-checked against the rest of the batch.
router.post('/api/v2/regenerate-variant', asyncRoute(async (req, res) => {
  const { batchId, platform, draft, siblings = [] } = req.body;
  if (!batchId || !platform || !draft) {
    return res.status(400).json({ error: 'batchId, platform, and draft are required' });
  }

  const brand = getProfile(db);
  if (!brand) return res.status(400).json({ error: 'Brand profile not configured' });

  // Generate only the requested platform (1 LLM call instead of 7).
  const newVariant = await generateSingleVariant(platform, { draft, brand }, batchId, db);

  // Attach anchors for just this variant.
  const recentTopAnchors = anchorHistory.topInRecentBatches(db, 30, 10).map(r => r.anchor);
  const [withAnchor] = await attachAnchors([newVariant], brand, recentTopAnchors, db);

  // Merge with siblings (exclude any stale entry for this platform).
  const otherVariants = (siblings as import('../types').Variant[]).filter(
    v => v.platform !== platform,
  );
  const allVariants = [...otherVariants, withAnchor];

  // Re-run full lint so Jaccard is checked against the whole batch.
  const lintResult = runLint(allVariants, brand);

  res.json({ variant: withAnchor, lintResult });
}));
