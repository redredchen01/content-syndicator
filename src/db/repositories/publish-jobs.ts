import type Database from 'better-sqlite3';

export type JobType =
  | 'publish'
  | 'health_check_t24h'
  | 'health_check_t7d'
  | 'health_check_t30d'
  | 'aggregate_sheets'
  | 'daily_digest'
  | 'reconciliation'
  | 'monthly_alert';

export type JobStatus =
  | 'scheduled'
  | 'running'
  | 'succeeded'
  | 'skipped'
  | 'failed_retryable'
  | 'failed_terminal';

export interface PublishJob {
  id: number;
  batch_id: string;
  variant_id: string;
  platform: string;
  job_type: JobType;
  payload_json: string;
  scheduled_at: string;
  status: JobStatus;
  attempts: number;
  last_error: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
  /** ROI score (0.0–1.0) used for dequeue ordering. Default 0.0 for pre-ROI rows. */
  priority: number;
}

export const publishJobs = {
  insert(
    db: Database.Database,
    job: {
      batch_id: string;
      variant_id: string;
      platform: string;
      job_type: JobType;
      scheduled_at: string;
      payload?: unknown;
      metadata?: unknown;
      /** ROI score written at dispatch time. Defaults to 0.0 (lowest priority). */
      priority?: number;
    },
  ): number {
    // OR IGNORE makes (batch_id, variant_id, platform, job_type) UNIQUE
    // collisions safe — health_check_t24h re-enqueue on retry won't error.
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO publish_jobs (
        batch_id, variant_id, platform, job_type, payload_json,
        scheduled_at, metadata_json, priority
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      job.batch_id,
      job.variant_id,
      job.platform,
      job.job_type,
      JSON.stringify(job.payload ?? {}),
      job.scheduled_at,
      JSON.stringify(job.metadata ?? {}),
      job.priority ?? 0.0,
    );
    return Number(result.lastInsertRowid);
  },

  /**
   * Atomic dequeue: select due jobs, transition to 'running', increment
   * attempts. Returns the rows that this caller now owns.
   */
  dequeueDue(db: Database.Database, nowIso: string, limit = 5): PublishJob[] {
    const txn = db.transaction((now: string, lim: number): PublishJob[] => {
      const rows = db
        .prepare(`
          SELECT * FROM publish_jobs
          WHERE status = 'scheduled' AND scheduled_at <= ?
          ORDER BY priority DESC, scheduled_at ASC
          LIMIT ?
        `)
        .all(now, lim) as PublishJob[];
      const update = db.prepare(`
        UPDATE publish_jobs
        SET status = 'running', attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `);
      for (const r of rows) {
        update.run(r.id);
        r.status = 'running';
        r.attempts += 1;
      }
      return rows;
    });
    return txn(nowIso, limit);
  },

  markSucceeded(db: Database.Database, id: number): void {
    db.prepare(`
      UPDATE publish_jobs
      SET status = 'succeeded', last_error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(id);
  },

  markSucceededWithUrl(db: Database.Database, id: number, publishedUrl: string): void {
    db.prepare(`
      UPDATE publish_jobs
      SET status = 'succeeded', last_error = NULL,
          metadata_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(JSON.stringify({ publishedUrl }), id);
  },

  markRunning(db: Database.Database, id: number): void {
    db.prepare(
      `UPDATE publish_jobs SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    ).run(id);
  },

  markSkipped(db: Database.Database, id: number, reason: string): void {
    db.prepare(`
      UPDATE publish_jobs
      SET status = 'skipped', last_error = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(reason, id);
  },

  /**
   * Marks a failure. If attempts < maxAttempts, transitions back to
   * 'scheduled' with a new scheduled_at; otherwise to 'failed_terminal'.
   */
  markFailed(
    db: Database.Database,
    id: number,
    error: string,
    nextScheduledAtIso: string | null,
    maxAttempts = 2,
  ): JobStatus {
    const row = db
      .prepare('SELECT attempts FROM publish_jobs WHERE id = ?')
      .get(id) as { attempts: number } | undefined;
    if (!row) return 'failed_terminal';

    const isTerminal = row.attempts >= maxAttempts || nextScheduledAtIso === null;
    if (isTerminal) {
      db.prepare(`
        UPDATE publish_jobs
        SET status = 'failed_terminal', last_error = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(error, id);
      return 'failed_terminal';
    }
    db.prepare(`
      UPDATE publish_jobs
      SET status = 'failed_retryable', last_error = ?, scheduled_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(error, nextScheduledAtIso, id);
    // Revive for the next tick.
    db.prepare(`UPDATE publish_jobs SET status = 'scheduled' WHERE id = ?`).run(id);
    return 'scheduled';
  },

  /**
   * Reset zombie 'running' jobs older than `staleSecondsAgoIso` back to
   * 'failed_retryable' on startup and during periodic sweeps (Unit 9).
   */
  resetZombies(db: Database.Database, staleBeforeIso: string): number {
    const result = db.prepare(`
      UPDATE publish_jobs
      SET status = 'failed_retryable',
          last_error = COALESCE(last_error, '') || ' [zombie-reset]',
          updated_at = CURRENT_TIMESTAMP
      WHERE status = 'running' AND updated_at < ?
    `).run(staleBeforeIso);
    return Number(result.changes);
  },

  /** Counts all jobs by status — drives the queue UI page. */
  countByStatus(db: Database.Database): Record<JobStatus, number> {
    const rows = db
      .prepare('SELECT status, COUNT(*) AS cnt FROM publish_jobs GROUP BY status')
      .all() as Array<{ status: JobStatus; cnt: number }>;
    const counts: Record<JobStatus, number> = {
      scheduled: 0,
      running: 0,
      succeeded: 0,
      skipped: 0,
      failed_retryable: 0,
      failed_terminal: 0,
    };
    for (const r of rows) counts[r.status] = r.cnt;
    return counts;
  },

  byBatch(db: Database.Database, batchId: string): PublishJob[] {
    return db
      .prepare('SELECT * FROM publish_jobs WHERE batch_id = ? ORDER BY id')
      .all(batchId) as PublishJob[];
  },
};
