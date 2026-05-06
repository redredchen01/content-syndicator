/**
 * Unit 10: Publish Worker
 *
 * Registered with Scheduler as the 'publish' job_type handler.
 * Processes one publish_job record at a time (one variant, one platform).
 *
 * Flow per job:
 *   1. Parse payload_json → Variant
 *   2. Idempotency check (if attempts > 0 and already published)
 *   3. MVP_PLATFORMS whitelist gate
 *   4. Single publish call via adapter (no inner retry — Scheduler owns retries)
 *   5. On success: upsert posts + write anchor_history + queue 3 health_check jobs + Sheets sync
 *   6. On failure: throw so Scheduler can decide retryable vs terminal
 */

import type Database from 'better-sqlite3';
import { allAdapters } from '../../adapters';
import { MVP_PLATFORMS } from '../../constants';
import { publishJobs, anchorHistory, type PublishJob } from '../../db/repositories';
import { getSheetsClient } from '../../sheets';
import { db as globalDb, savePost } from '../../db';
import { classifyError, ErrorType } from '../../utils/smartRetry';
import { logger } from '../../utils/logger';
import type { Variant } from '../../types';

// -----------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------

export interface PublishResult {
  ok: boolean;
  publishedUrl?: string;
  error?: string;
  errorType?: ErrorType;
}

// -----------------------------------------------------------------------
// Main handler — registered with scheduler.registerHandler('publish', ...)
// -----------------------------------------------------------------------

export async function handlePublishJob(job: PublishJob, db: Database.Database): Promise<void> {
  // 1. Parse payload
  let variant: Variant;
  try {
    variant = JSON.parse(job.payload_json) as Variant;
  } catch {
    throw new Error(`payload_json is not valid JSON (job ${job.id})`);
  }

  if (!variant?.platform || !variant?.body_markdown) {
    throw new Error(`payload_json missing required fields (job ${job.id})`);
  }

  // 2. Idempotency: if this is a retry and the URL is already recorded, just
  //    sync side-effects and succeed without re-publishing.
  if (job.attempts > 0) {
    const existing = db
      .prepare(
        'SELECT published_url FROM posts WHERE batch_id = ? AND platform = ? AND published_url IS NOT NULL',
      )
      .get(job.batch_id, job.platform) as { published_url: string } | undefined;

    if (existing?.published_url) {
      logger.info(
        `[PublishWorker] Idempotent skip: ${job.platform} batch=${job.batch_id} already published at ${existing.published_url}`,
      );
      await syncSideEffects(job, variant, existing.published_url, db);
      publishJobs.markSucceededWithUrl(db, job.id, existing.published_url);
      return;
    }
  }

  // 3. Platform whitelist
  if (!MVP_PLATFORMS.includes(job.platform as (typeof MVP_PLATFORMS)[number])) {
    logger.info(`[PublishWorker] ${job.platform} not in MVP_PLATFORMS, skipping`);
    publishJobs.markSkipped(db, job.id, 'Not in MVP_PLATFORMS');
    return;
  }

  // 4. Find adapter and publish once
  const adapter = allAdapters.find(a => a.name === job.platform);
  if (!adapter) {
    throw new Error(`No adapter registered for platform: ${job.platform}`);
  }

  let publishedUrl: string;
  try {
    const result = await adapter.publish({
      title: variant.title,
      markdownContent: variant.body_markdown,
      tags: [],
      excerpt: variant.body_markdown.slice(0, 160),
      originalUrl: variant.target_url,
      publishStatus: 'public',
    });

    if (!result.success) {
      const errType = classifyError({ message: result.error });
      const err = new Error(result.error ?? 'Adapter returned failure');
      Object.assign(err, { errorType: errType });
      throw err;
    }
    if (!result.publishedUrl) {
      // Adapter returned success but no publishedUrl — use target_url as a
      // best-effort fallback. This makes idempotency and liveness checks
      // unreliable, so log a warn so the gap is visible in ops dashboards.
      logger.warn(
        `[PublishWorker] ${job.platform} succeeded but returned no publishedUrl ` +
        `— falling back to target_url. Idempotency and liveness checks may be impaired.`,
      );
    }
    publishedUrl = result.publishedUrl ?? variant.target_url;
  } catch (err: any) {
    // Re-classify and re-throw so Scheduler can route to retryable/terminal
    if (!err.errorType) {
      err.errorType = classifyError(err);
    }
    logger.warn(`[PublishWorker] ${job.platform} failed (${err.errorType}): ${err.message}`);
    throw err;
  }

  // 5. Success — persist terminal state then sync side-effects
  publishJobs.markSucceededWithUrl(db, job.id, publishedUrl);
  await syncSideEffects(job, variant, publishedUrl, db);
  logger.info(`[PublishWorker] ${job.platform} published: ${publishedUrl}`);
}

// -----------------------------------------------------------------------
// Side effects on success
// -----------------------------------------------------------------------

async function syncSideEffects(
  job: PublishJob,
  variant: Variant,
  publishedUrl: string,
  db: Database.Database,
): Promise<void> {
  // Upsert posts row — platform + published_url required for idempotency guard
  try {
    db.prepare(`
      INSERT INTO posts (original_url, title, content, results_json, batch_id, platform, published_url)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING
    `).run(
      variant.target_url,
      variant.title,
      variant.body_markdown,
      JSON.stringify([{ platform: job.platform, success: true, publishedUrl }]),
      job.batch_id,
      job.platform,
      publishedUrl,
    );
  } catch (err: any) {
    logger.warn(`[PublishWorker] posts upsert failed: ${err.message}`);
  }

  // Write anchor_history only on first attempt (no double-counting on retry)
  if (job.attempts === 0) {
    for (const anchor of variant.anchor_words.filter(a => a !== '__naked_url__')) {
      try {
        anchorHistory.insert(db, {
          batch_id: job.batch_id,
          variant_id: variant.variant_id,
          platform: job.platform,
          anchor_text: anchor,
          target_url: variant.target_url,
        });
      } catch (err: any) {
        logger.warn(`[PublishWorker] anchor_history insert failed: ${err.message}`);
      }
    }

    // Queue health_check jobs (T+24h, T+7d, T+30d)
    const checkTypes: Array<{ kind: 'health_check_t24h' | 'health_check_t7d' | 'health_check_t30d'; delayHours: number }> = [
      { kind: 'health_check_t24h', delayHours: 24 },
      { kind: 'health_check_t7d', delayHours: 24 * 7 },
      { kind: 'health_check_t30d', delayHours: 24 * 30 },
    ];
    for (const { kind, delayHours } of checkTypes) {
      const scheduledAt = new Date(Date.now() + delayHours * 3_600_000).toISOString();
      try {
        publishJobs.insert(db, {
          batch_id: job.batch_id,
          variant_id: variant.variant_id,
          platform: job.platform,
          job_type: kind,
          scheduled_at: scheduledAt,
          payload: { published_url: publishedUrl, platform: job.platform },
        });
      } catch (err: any) {
        logger.warn(`[PublishWorker] health_check enqueue (${kind}) failed: ${err.message}`);
      }
    }
  }

  // Sheets sync (non-blocking — failures must not propagate to Scheduler)
  try {
    const sheets = getSheetsClient();
    await sheets.appendRow('Posts!A:L', [
      new Date().toISOString(),
      'main',
      job.batch_id,
      job.platform,
      variant.persona_group,
      variant.anchor_words.filter(a => a !== '__naked_url__').join(', '),
      variant.target_url,
      publishedUrl,
      'succeeded',
      '', '', '', // t24h/t7d/t30d_alive (filled by liveness worker)
    ]);
  } catch (err: any) {
    logger.warn(`[PublishWorker] Sheets sync failed (non-fatal): ${err.message}`);
  }
}

// -----------------------------------------------------------------------
// Helper: schedule 7 publish_jobs for a batch of variants
// -----------------------------------------------------------------------

/**
 * Creates one publish_job per variant. Scheduled_at is staggered by
 * R15-style random delays (same platform ≥ 20 min apart, different platforms
 * immediately available to the scheduler).
 */
export function dispatchVariantJobs(
  variants: Variant[],
  batchId: string,
  db: Database.Database,
  roiScores?: Map<string, number>,
): void {
  const now = Date.now();
  for (const variant of variants) {
    if (variant.generation_status === 'failed') continue;
    if (!MVP_PLATFORMS.includes(variant.platform as (typeof MVP_PLATFORMS)[number])) continue;

    // Stagger by a small random delay (0–10 min) to avoid simultaneous bursts.
    const jitterMs = Math.floor(Math.random() * 10 * 60_000);
    const scheduledAt = new Date(now + jitterMs).toISOString();

    publishJobs.insert(db, {
      batch_id: batchId,
      variant_id: variant.variant_id,
      platform: variant.platform,
      job_type: 'publish',
      scheduled_at: scheduledAt,
      payload: variant,
      priority: roiScores?.get(variant.platform) ?? 0.0,
    });
  }
}
