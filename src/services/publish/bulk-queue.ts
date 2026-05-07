/**
 * services/publish/bulk-queue.ts (Plan 2026-05-07-002 Unit 6)
 *
 * Bulk-publish from CSV upload — encapsulates the legacy multer + CSV
 * pipeline that previously lived inline in routes/publish.ts.
 *
 *   POST /api/bulk-publish   → startBulkPublishFromFile
 *
 * Cross-step error isolation: if one URL fails to scrape/generate, the
 * remaining URLs still process. Per-URL errors are logged but do not abort
 * the loop. Sleeps 30–60s between articles to avoid platform rate limits.
 *
 * Dependency: bulk-queue → dispatch is one-way (runPublishingTask is shared
 * via publish-service, not via dispatch.ts). dispatch.ts never imports back.
 */

import fs from 'fs';
import csv from 'csv-parser';
import type Database from 'better-sqlite3';
import { logger, randomSleep } from '../../utils/logger';
import { scrapeUrl } from '../../scraper';
import { generateMarkdown } from '../../llm';
import { resolveTargetPlatforms } from '../admin/platforms';
import { getPreferredPlatforms } from '../brand-profile';
import { publishToPlatforms } from '../publish-service';

// ---------------------------------------------------------------------------
// processBulkQueue — async background worker
// ---------------------------------------------------------------------------

const BULK_INTER_URL_DELAY_MIN_MS = 30_000;
const BULK_INTER_URL_DELAY_MAX_MS = 60_000;

/**
 * Walk a list of URLs sequentially: scrape → generate → publish via
 * publishToPlatforms. Per-URL exceptions are logged and skipped — the
 * remaining URLs still process. Sleeps between URLs to spread platform load.
 */
export async function processBulkQueue(
  urls: string[],
  targetPlatforms: string[],
  publishStatus: 'draft' | 'public',
): Promise<void> {
  logger.info(`Starting bulk queue processing for ${urls.length} URLs...`);
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    logger.info(`[Bulk ${i + 1}/${urls.length}] Processing URL: ${url}`);

    try {
      logger.info(`[Bulk ${i + 1}/${urls.length}] Scraping...`);
      const scrapedData = await scrapeUrl(url);

      logger.info(`[Bulk ${i + 1}/${urls.length}] Generating markdown...`);
      const { title, content, tags, excerpt } = await generateMarkdown(scrapedData);

      logger.info(`[Bulk ${i + 1}/${urls.length}] Publishing and saving results...`);
      await publishToPlatforms({
        sourceUrl: url,
        title,
        content,
        tags,
        excerpt,
        platforms: targetPlatforms,
        publishStatus,
      });

      logger.success(`[Bulk ${i + 1}/${urls.length}] Finished processing URL.`);
    } catch (err) {
      logger.error(`[Bulk ${i + 1}/${urls.length}] Failed processing URL ${url}`, err);
    }

    if (i < urls.length - 1) {
      const sleepTime =
        Math.floor(Math.random() * (BULK_INTER_URL_DELAY_MAX_MS - BULK_INTER_URL_DELAY_MIN_MS + 1)) +
        BULK_INTER_URL_DELAY_MIN_MS;
      logger.info(`[Bulk] Sleeping for ${sleepTime / 1000}s before next article...`);
      await randomSleep(sleepTime, sleepTime);
    }
  }
  logger.success('Bulk queue processing completed entirely.');
}

// ---------------------------------------------------------------------------
// CSV parsing helper
// ---------------------------------------------------------------------------

/**
 * Read CSV from `filePath` and extract URL strings (one per row). Accepts
 * either a header named `url` or the first column as URL. Lines that do not
 * start with `http` are filtered out.
 */
export function parseCsvUrls(filePath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const urls: string[] = [];
    const readStream = fs.createReadStream(filePath);
    readStream.on('error', err => reject(err));
    readStream
      .pipe(csv(['url']))
      .on('data', (data: Record<string, string>) => {
        const url = data.url || data[Object.keys(data)[0]];
        if (url && typeof url === 'string' && url.startsWith('http')) {
          urls.push(url.trim());
        }
      })
      .on('end', () => resolve(urls))
      .on('error', err => reject(err));
  });
}

// ---------------------------------------------------------------------------
// startBulkPublishFromFile (POST /api/bulk-publish)
// ---------------------------------------------------------------------------

export interface StartBulkPublishInput {
  platforms?: unknown;
  publishStatus?: unknown;
}

export type StartBulkPublishResult =
  | { ok: true; urlCount: number; message: string }
  | { ok: false; error: string; status: 400 };

/**
 * Resolve target platforms, parse CSV, validate URL count, then kick off
 * `processBulkQueue` as a fire-and-forget background task. The CSV file is
 * deleted after parsing regardless of outcome.
 *
 * Note: the `platforms` form field arrives as either a JSON string (from
 * multipart upload) or an already-parsed array. Both shapes are handled.
 */
export async function startBulkPublishFromFile(
  db: Database.Database,
  filePath: string,
  body: StartBulkPublishInput,
): Promise<StartBulkPublishResult> {
  let parsedPlatforms: unknown = body.platforms;
  if (typeof parsedPlatforms === 'string') {
    try {
      parsedPlatforms = JSON.parse(parsedPlatforms);
    } catch {
      // leave as string — resolveTargetPlatforms will treat as empty.
    }
  }

  let targetPlatforms: string[];
  if (!parsedPlatforms || (Array.isArray(parsedPlatforms) && parsedPlatforms.length === 0)) {
    const preferred = getPreferredPlatforms(db);
    targetPlatforms = preferred.length > 0 ? preferred : resolveTargetPlatforms(db, parsedPlatforms);
  } else {
    targetPlatforms = resolveTargetPlatforms(db, parsedPlatforms);
  }

  if (targetPlatforms.length === 0) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* best-effort cleanup */
    }
    return {
      ok: false,
      error: 'No connected platforms available. Connect at least one channel in Settings first.',
      status: 400,
    };
  }

  const urls = await parseCsvUrls(filePath);
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* best-effort cleanup */
  }

  if (urls.length === 0) {
    return { ok: false, error: 'No valid URLs found in the CSV file.', status: 400 };
  }

  const publishStatus: 'draft' | 'public' = body.publishStatus === 'public' ? 'public' : 'draft';

  // Fire-and-forget — caller observes progress via /api/batch-status.
  processBulkQueue(urls, targetPlatforms, publishStatus).catch(err =>
    logger.error('Bulk queue processing failed', err),
  );

  return {
    ok: true,
    urlCount: urls.length,
    message: `Bulk process started for ${urls.length} URLs in the background. You can safely close this page.`,
  };
}
