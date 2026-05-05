/**
 * Unit 12b: Sheets maintenance job handlers.
 *
 * aggregate_sheets  — Runs at 04:00 daily. Rewrites the Aggregates sheet
 *                     with fresh per-URL / per-platform / per-persona stats.
 *
 * reconciliation    — Runs at 04:30 daily. Finds publish_jobs rows that
 *                     succeeded but are missing from the Posts sheet and
 *                     appends them (protects against Sheets quota failures
 *                     during publishing).
 *
 * Both are registered with the Scheduler and seeded once per day by the
 * seedSheetsJobs() helper called from index.ts.
 */

import type Database from 'better-sqlite3';
import type { PublishJob } from '../../db/repositories';
import { getSheetsClient } from '../../sheets';
import { logger } from '../../utils/logger';

// -----------------------------------------------------------------------
// aggregate_sheets handler
// -----------------------------------------------------------------------

export async function handleAggregateSheets(_job: PublishJob, _db: Database.Database): Promise<void> {
  logger.info('[SheetsJobs] aggregate_sheets: refreshing Aggregates sheet...');
  try {
    const sheets = getSheetsClient();
    await sheets.refreshAggregates();
    logger.info('[SheetsJobs] aggregate_sheets: done');
  } catch (err: any) {
    logger.warn(`[SheetsJobs] aggregate_sheets failed (non-fatal): ${err.message}`);
  }
}

// -----------------------------------------------------------------------
// reconciliation handler
// -----------------------------------------------------------------------

export async function handleReconciliation(_job: PublishJob, db: Database.Database): Promise<void> {
  logger.info('[SheetsJobs] reconciliation: syncing SQLite → Sheets...');
  try {
    // Collect succeeded publish_jobs that have a platform post URL in posts
    const rows = db.prepare(`
      SELECT pj.batch_id, pj.platform,
             p.published_url
      FROM publish_jobs pj
      LEFT JOIN posts p ON p.batch_id = pj.batch_id
                       AND p.platform = pj.platform
                       AND p.published_url IS NOT NULL
      WHERE pj.status = 'succeeded' AND pj.job_type = 'publish'
      ORDER BY pj.updated_at DESC
      LIMIT 500
    `).all() as Array<{ batch_id: string; platform: string; published_url: string | null }>;

    const toSync = rows
      .filter(r => r.published_url)
      .map(r => ({
        batch_id: r.batch_id,
        platform: r.platform,
        published_url: r.published_url!,
      }));

    if (toSync.length === 0) {
      logger.info('[SheetsJobs] reconciliation: nothing to sync');
      return;
    }

    const sheets = getSheetsClient();
    await sheets.reconcileWithSqlite(toSync);
    logger.info(`[SheetsJobs] reconciliation: synced ${toSync.length} rows`);
  } catch (err: any) {
    logger.warn(`[SheetsJobs] reconciliation failed (non-fatal): ${err.message}`);
  }
}

// -----------------------------------------------------------------------
// Seed helper — called from index.ts at startup
// -----------------------------------------------------------------------

export function seedSheetsJobs(db: Database.Database): void {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const jobs = [
    { type: 'aggregate_sheets', hour: '04:00' },
    { type: 'reconciliation',   hour: '04:30' },
  ] as const;

  for (const { type, hour } of jobs) {
    const existing = db
      .prepare(`SELECT id FROM publish_jobs WHERE job_type = ? AND DATE(scheduled_at) = ?`)
      .get(type, today);

    if (!existing) {
      const scheduledAt = `${today}T${hour}:00.000Z`;
      db.prepare(`
        INSERT INTO publish_jobs (batch_id, variant_id, platform, job_type, payload_json, scheduled_at, metadata_json)
        VALUES ('system', ?, 'system', ?, '{}', ?, '{}')
      `).run(type, type, scheduledAt);
      logger.info(`[SheetsJobs] Seeded ${type} job for ${today} ${hour} UTC`);
    }
  }
}
