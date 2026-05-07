/**
 * services/publish/dispatch.ts (Plan 2026-05-07-002 Unit 6)
 *
 * v0.1 publish dispatch:
 *   POST /api/publish       → startSinglePublish (uses runPublishingTask worker)
 *   POST /api/auto-publish  → startAutoPublish   (delegates to publishToPlatforms)
 *
 * runPublishingTask side-effect contract (preserved verbatim from the legacy
 * route handler): markRunning → adapter.publish → markSucceededWithUrl |
 * markFailed → randomSleep(5–10s); on completion appendToSheet + savePost.
 */

import type Database from 'better-sqlite3';
import { logger, randomSleep } from '../../utils/logger';
import { scrapeUrl } from '../../scraper';
import { generateMarkdown } from '../../llm';
import { allAdapters } from '../../adapters/index';
import { appendToSheet } from '../../sheets';
import { savePost } from '../../db';
import { publishJobs } from '../../db/repositories';
import { resolveTargetPlatforms } from '../admin/platforms';
import { getPreferredPlatforms } from '../brand-profile';
import { publishToPlatforms } from '../publish-service';
import { filterByRoi } from '../roi-scorer';
import type { Variant } from '../../types';

// runPublishingTask — async background worker

export interface PublishingTaskOptions {
  sourceUrl: string;
  title: string;
  content: string;
  tags?: string[];
  excerpt?: string;
  publishStatus?: 'draft' | 'public';
}

const PUBLISH_DELAY_MIN_MS = 5000;
const PUBLISH_DELAY_MAX_MS = 10000;

/** Per-job adapter errors are isolated — one throw does NOT abort the loop. */
export async function runPublishingTask(
  db: Database.Database,
  batchId: string,
  options: PublishingTaskOptions,
): Promise<void> {
  const jobs = db
    .prepare(`SELECT id, platform FROM publish_jobs WHERE batch_id = ? AND status = 'scheduled'`)
    .all(batchId) as Array<{ id: number; platform: string }>;

  for (const job of jobs) {
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
    } catch (err) {
      publishJobs.markFailed(db, job.id, (err as Error).message, null, 2);
    }

    await randomSleep(PUBLISH_DELAY_MIN_MS, PUBLISH_DELAY_MAX_MS);
  }

  const finalJobs = publishJobs.byBatch(db, batchId);
  const formattedResults = finalJobs.map(r => ({
    platform: r.platform,
    success: r.status === 'succeeded',
    error: r.last_error ?? undefined,
    publishedUrl:
      r.status === 'succeeded'
        ? (JSON.parse(r.metadata_json || '{}') as { publishedUrl?: string }).publishedUrl
        : undefined,
  }));

  appendToSheet(options.sourceUrl, options.title, formattedResults).catch(e =>
    logger.error('Sheets sync error', e),
  );
  savePost(options.sourceUrl, options.title, options.content, formattedResults, batchId);
}

// startSinglePublish (POST /api/publish)

export interface StartSinglePublishInput {
  url?: unknown;
  title?: unknown;
  content?: unknown;
  tags?: unknown;
  excerpt?: unknown;
  platforms?: unknown;
  publishStatus?: unknown;
}

export type StartSinglePublishResult =
  | { ok: true; batchId: string; message: string }
  | { ok: false; error: string; status: 400 | 500 };

/** Returns immediately — progress observed via GET /api/batch-status/:batchId. */
export function startSinglePublish(
  db: Database.Database,
  body: StartSinglePublishInput,
): StartSinglePublishResult {
  const title = typeof body.title === 'string' ? body.title : null;
  const content = typeof body.content === 'string' ? body.content : null;
  if (!title || !content) {
    return { ok: false, error: 'Missing required fields: title or content', status: 400 };
  }

  const sourceUrl = typeof body.url === 'string' && body.url.length > 0 ? body.url : 'manual-content';

  let targetPlatforms: string[];
  const platformsInput = body.platforms;
  if (!platformsInput || (Array.isArray(platformsInput) && platformsInput.length === 0)) {
    const preferred = getPreferredPlatforms(db);
    targetPlatforms = preferred.length > 0 ? preferred : resolveTargetPlatforms(db, platformsInput);
  } else {
    targetPlatforms = resolveTargetPlatforms(db, platformsInput);
  }

  if (targetPlatforms.length === 0) {
    return { ok: false, error: 'No connected or valid platforms available.', status: 400 };
  }

  const batchId = `batch_${Date.now()}`;
  logger.info(`Creating batch ${batchId} for ${targetPlatforms.length} platforms...`);

  const insertJob = db.prepare(`
    INSERT INTO publish_jobs (batch_id, variant_id, platform, job_type, status, scheduled_at, payload_json)
    VALUES (?, 'v1', ?, 'publish', 'scheduled', CURRENT_TIMESTAMP, '{}')
  `);
  try {
    db.transaction((pforms: string[]) => {
      for (const p of pforms) insertJob.run(batchId, p);
    })(targetPlatforms);
  } catch (dbErr) {
    return { ok: false, error: `Database Error: ${(dbErr as Error).message}`, status: 500 };
  }

  const tags = Array.isArray(body.tags) ? (body.tags as string[]) : undefined;
  const excerpt = typeof body.excerpt === 'string' ? body.excerpt : undefined;
  const publishStatus = body.publishStatus === 'public' ? 'public' : 'draft';

  runPublishingTask(db, batchId, {
    sourceUrl,
    title,
    content,
    tags,
    excerpt,
    publishStatus,
  }).catch(e => logger.error(`Background task for ${batchId} failed early`, e));

  logger.success(`Batch ${batchId} started.`);
  return { ok: true, batchId, message: 'Publishing task started in background' };
}

// startAutoPublish (POST /api/auto-publish)

export interface StartAutoPublishInput {
  mode?: unknown;
  url?: unknown;
  rawContent?: unknown;
  originalUrl?: unknown;
  platforms?: unknown;
  publishStatus?: unknown;
}

export interface AutoPublishResult {
  success: true;
  mode: 'manual' | 'url';
  platforms: string[];
  originalUrl: string;
  title: string;
  content: string;
  tags?: string[];
  excerpt?: string;
  results: Awaited<ReturnType<typeof publishToPlatforms>>['results'];
}

export type StartAutoPublishResult =
  | AutoPublishResult
  | { ok: false; error: string; status: 400 };

/** scrape → generate → ROI filter → publishToPlatforms (skips publish_jobs). */
export async function startAutoPublish(
  db: Database.Database,
  body: StartAutoPublishInput,
): Promise<StartAutoPublishResult> {
  const mode = body.mode === 'manual' ? 'manual' : 'url';
  const normalizedStatus: 'draft' | 'public' = body.publishStatus === 'public' ? 'public' : 'draft';

  let sourceUrl: string;
  let generated: { title: string; content: string; tags?: string[]; excerpt?: string };

  if (mode === 'manual') {
    const rawContent = typeof body.rawContent === 'string' ? body.rawContent : null;
    if (!rawContent) {
      return { ok: false, error: 'rawContent is required for manual auto-publish', status: 400 };
    }
    sourceUrl =
      typeof body.originalUrl === 'string' && body.originalUrl.length > 0
        ? body.originalUrl
        : 'manual-content';
    logger.info('API: Auto-publish manual content. Generating markdown...');
    generated = await generateMarkdown({
      title: 'Manual Content',
      content: rawContent,
      originalUrl: sourceUrl,
    });
  } else {
    const url = typeof body.url === 'string' ? body.url : null;
    if (!url) {
      return { ok: false, error: 'url is required for URL auto-publish', status: 400 };
    }
    sourceUrl = url;
    logger.info(`API: Auto-publish URL. Scraping: ${url}`);
    generated = await generateMarkdown(await scrapeUrl(url));
  }

  // Resolve target platforms before ROI filter (mirrors publishService internal logic).
  let targetPlatforms: string[];
  const platformsInput = body.platforms;
  if (Array.isArray(platformsInput) && platformsInput.length > 0) {
    targetPlatforms = (platformsInput as unknown[]).filter(
      (p): p is string => typeof p === 'string' && p.trim() !== '',
    );
  } else {
    targetPlatforms = allAdapters
      .filter(a => !a.isBrowserAutomation || Boolean(a.canPublishAutomatically))
      .map(a => a.name);
  }

  // ROI filter: build mock variants (one per platform) and filter low-ROI platforms.
  const mockVariants: Variant[] = targetPlatforms.map(platform => ({
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
    logger.info(
      `[auto-publish] ROI filter skipped platforms: ${roiResult.skipped
        .map(s => `${s.platform}(${s.score.toFixed(2)})`)
        .join(', ')}`,
    );
  }
  const eligiblePlatforms = roiResult.eligible.map(v => v.platform);

  const { targetPlatforms: usedPlatforms, results } = await publishToPlatforms({
    sourceUrl,
    title: generated.title,
    content: generated.content,
    tags: generated.tags,
    excerpt: generated.excerpt,
    platforms: eligiblePlatforms,
    publishStatus: normalizedStatus,
  });

  return {
    success: true,
    mode,
    platforms: usedPlatforms,
    originalUrl: sourceUrl,
    title: generated.title,
    content: generated.content,
    tags: generated.tags,
    excerpt: generated.excerpt,
    results,
  };
}
