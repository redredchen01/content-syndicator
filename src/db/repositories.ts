/**
 * Repository layer for v0.2 schema (Plan Unit 2).
 *
 * Single file, multiple namespaces — matches v0.1's flat src/db/index.ts
 * convention rather than fanning out to per-table files (scope-guardian
 * F1: 4-file split for 4 small tables was premature abstraction).
 *
 * Every namespace function accepts a `db: Database.Database` so tests can
 * inject a `:memory:` instance and the production singleton in `index.ts`
 * can pass itself.
 */

import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BrandProfileRow {
  brand_id: string;
  name: string;
  name_variants_json: string;
  target_urls_json: string;
  exposure_blocklist_json: string;
  anchor_blocklist_json: string;
  signature: string | null;
  anchor_concentration_threshold: number;
  weekly_url_cap: number;
  jaccard_threshold: number;
  digest_channel: 'none' | 'email' | 'telegram';
  digest_destination: string | null;
  updated_at: string;
}

export interface BrandProfile {
  brand_id: string;
  name: string;
  name_variants: string[];
  target_urls: Array<{ url: string; context_tag: string }>;
  exposure_blocklist: string[];
  anchor_blocklist: string[];
  signature: string | null;
  anchor_concentration_threshold: number;
  weekly_url_cap: number;
  jaccard_threshold: number;
  digest_channel: 'none' | 'email' | 'telegram';
  digest_destination: string | null;
  updated_at: string;
}

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
}

export type LinkCheckType = 't24h' | 't7d' | 't30d';
export type LinkClassification =
  | 'alive'
  | 'redirect_alive'
  | '404'
  | '410'
  | 'timeout'
  | 'unknown';

export interface LinkCheck {
  id: number;
  batch_id: string;
  variant_id: string;
  platform: string;
  published_url: string;
  check_type: LinkCheckType;
  http_status: number | null;
  classification: LinkClassification;
  checked_at: string;
}

export type LlmCallKind = 'variant_body' | 'variant_anchor' | 'regenerate' | 'single';

export interface AnchorHistoryRow {
  batch_id: string;
  variant_id: string;
  platform: string;
  anchor_text: string;
  target_url: string;
}

export type DraftBatchStatus = 'drafting' | 'dispatched' | 'archived';

export interface DraftBatch {
  batch_id: string;
  brand_id: string;
  draft_text: string;
  variants_json: string | null;
  lint_result_json: string | null;
  status: DraftBatchStatus;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// brandProfile
// ---------------------------------------------------------------------------

function rowToProfile(row: BrandProfileRow): BrandProfile {
  return {
    brand_id: row.brand_id,
    name: row.name,
    name_variants: JSON.parse(row.name_variants_json),
    target_urls: JSON.parse(row.target_urls_json),
    exposure_blocklist: JSON.parse(row.exposure_blocklist_json),
    anchor_blocklist: JSON.parse(row.anchor_blocklist_json),
    signature: row.signature,
    anchor_concentration_threshold: row.anchor_concentration_threshold,
    weekly_url_cap: row.weekly_url_cap,
    jaccard_threshold: row.jaccard_threshold,
    digest_channel: row.digest_channel,
    digest_destination: row.digest_destination,
    updated_at: row.updated_at,
  };
}

export const brandProfile = {
  /** Returns the single brand row (always brand_id='main' in MVP). */
  get(db: Database.Database, brandId = 'main'): BrandProfile | null {
    const row = db
      .prepare('SELECT * FROM brand_profiles WHERE brand_id = ?')
      .get(brandId) as BrandProfileRow | undefined;
    return row ? rowToProfile(row) : null;
  },

  /**
   * Single-row upsert. Always operates on brand_id='main' regardless of any
   * client-supplied brand_id (defends against adversarial F7: silent
   * multi-row corruption via PUT body brand_id='main2').
   */
  upsertMain(
    db: Database.Database,
    profile: Partial<Omit<BrandProfile, 'brand_id' | 'updated_at'>> & { name: string },
  ): BrandProfile {
    const existing = brandProfile.get(db, 'main');
    const merged: Omit<BrandProfile, 'updated_at'> = {
      brand_id: 'main',
      name: profile.name,
      name_variants: profile.name_variants ?? existing?.name_variants ?? [],
      target_urls: profile.target_urls ?? existing?.target_urls ?? [],
      exposure_blocklist: profile.exposure_blocklist ?? existing?.exposure_blocklist ?? [],
      anchor_blocklist: profile.anchor_blocklist ?? existing?.anchor_blocklist ?? [],
      signature: profile.signature ?? existing?.signature ?? null,
      anchor_concentration_threshold:
        profile.anchor_concentration_threshold ??
        existing?.anchor_concentration_threshold ??
        0.30,
      weekly_url_cap: profile.weekly_url_cap ?? existing?.weekly_url_cap ?? 6,
      jaccard_threshold: profile.jaccard_threshold ?? existing?.jaccard_threshold ?? 0.5,
      digest_channel: profile.digest_channel ?? existing?.digest_channel ?? 'none',
      digest_destination: profile.digest_destination ?? existing?.digest_destination ?? null,
    };

    if (existing) {
      db.prepare(`
        UPDATE brand_profiles SET
          name = ?,
          name_variants_json = ?,
          target_urls_json = ?,
          exposure_blocklist_json = ?,
          anchor_blocklist_json = ?,
          signature = ?,
          anchor_concentration_threshold = ?,
          weekly_url_cap = ?,
          jaccard_threshold = ?,
          digest_channel = ?,
          digest_destination = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE brand_id = 'main'
      `).run(
        merged.name,
        JSON.stringify(merged.name_variants),
        JSON.stringify(merged.target_urls),
        JSON.stringify(merged.exposure_blocklist),
        JSON.stringify(merged.anchor_blocklist),
        merged.signature,
        merged.anchor_concentration_threshold,
        merged.weekly_url_cap,
        merged.jaccard_threshold,
        merged.digest_channel,
        merged.digest_destination,
      );
    } else {
      db.prepare(`
        INSERT INTO brand_profiles (
          brand_id, name, name_variants_json, target_urls_json,
          exposure_blocklist_json, anchor_blocklist_json, signature,
          anchor_concentration_threshold, weekly_url_cap, jaccard_threshold,
          digest_channel, digest_destination
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'main',
        merged.name,
        JSON.stringify(merged.name_variants),
        JSON.stringify(merged.target_urls),
        JSON.stringify(merged.exposure_blocklist),
        JSON.stringify(merged.anchor_blocklist),
        merged.signature,
        merged.anchor_concentration_threshold,
        merged.weekly_url_cap,
        merged.jaccard_threshold,
        merged.digest_channel,
        merged.digest_destination,
      );
    }
    return brandProfile.get(db, 'main')!;
  },
};

// ---------------------------------------------------------------------------
// publishJobs
// ---------------------------------------------------------------------------

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
    },
  ): number {
    // OR IGNORE makes (batch_id, variant_id, platform, job_type) UNIQUE
    // collisions safe — health_check_t24h re-enqueue on retry won't error.
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO publish_jobs (
        batch_id, variant_id, platform, job_type, payload_json,
        scheduled_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      job.batch_id,
      job.variant_id,
      job.platform,
      job.job_type,
      JSON.stringify(job.payload ?? {}),
      job.scheduled_at,
      JSON.stringify(job.metadata ?? {}),
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
          ORDER BY scheduled_at ASC
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

// ---------------------------------------------------------------------------
// linkChecks
// ---------------------------------------------------------------------------

export const linkChecks = {
  insert(
    db: Database.Database,
    row: Omit<LinkCheck, 'id' | 'checked_at'>,
  ): number {
    const result = db.prepare(`
      INSERT OR REPLACE INTO link_checks
      (batch_id, variant_id, platform, published_url, check_type, http_status, classification)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.batch_id,
      row.variant_id,
      row.platform,
      row.published_url,
      row.check_type,
      row.http_status,
      row.classification,
    );
    return Number(result.lastInsertRowid);
  },

  /** Returns survival rate for a check_type over the trailing N days. */
  survivalRate(
    db: Database.Database,
    checkType: LinkCheckType,
    sinceIso: string,
  ): { total: number; alive: number; rate: number } {
    const row = db.prepare(`
      SELECT
        SUM(CASE WHEN classification IN ('alive','redirect_alive') THEN 1 ELSE 0 END) AS alive,
        COUNT(*) AS total
      FROM link_checks
      WHERE check_type = ? AND checked_at >= ?
    `).get(checkType, sinceIso) as { alive: number | null; total: number };
    const alive = row.alive ?? 0;
    const total = row.total;
    return { total, alive, rate: total === 0 ? 0 : alive / total };
  },
};

// ---------------------------------------------------------------------------
// anchorHistory
// ---------------------------------------------------------------------------

export const anchorHistory = {
  insert(db: Database.Database, row: AnchorHistoryRow): number {
    const result = db.prepare(`
      INSERT INTO anchor_history (batch_id, variant_id, platform, anchor_text, target_url)
      VALUES (?, ?, ?, ?, ?)
    `).run(row.batch_id, row.variant_id, row.platform, row.anchor_text, row.target_url);
    return Number(result.lastInsertRowid);
  },

  /**
   * Top-N anchor frequencies across the most recent `batchScope` distinct
   * batches. Drives the R10b 30%-concentration alarm AND the LLM "recent
   * top anchors to avoid" prompt input (Unit 6).
   */
  topInRecentBatches(
    db: Database.Database,
    batchScope = 30,
    topN = 10,
  ): Array<{ anchor: string; count: number; ratio: number }> {
    const rows = db.prepare(`
      WITH recent_batches AS (
        SELECT DISTINCT batch_id FROM anchor_history
        ORDER BY MAX(used_at) OVER (PARTITION BY batch_id) DESC
        LIMIT ?
      )
      SELECT anchor_text AS anchor, COUNT(*) AS count
      FROM anchor_history
      WHERE batch_id IN (SELECT batch_id FROM recent_batches)
      GROUP BY anchor_text
      ORDER BY count DESC
      LIMIT ?
    `).all(batchScope, topN) as Array<{ anchor: string; count: number }>;
    const total = rows.reduce((s, r) => s + r.count, 0);
    return rows.map((r) => ({
      anchor: r.anchor,
      count: r.count,
      ratio: total === 0 ? 0 : r.count / total,
    }));
  },

  /** Sliding-window: count published links to target_url within last N days. */
  weeklyCountForUrl(db: Database.Database, targetUrl: string, sinceIso: string): number {
    const row = db.prepare(`
      SELECT COUNT(*) AS cnt FROM anchor_history
      WHERE target_url = ? AND used_at >= ?
    `).get(targetUrl, sinceIso) as { cnt: number };
    return row.cnt;
  },
};

// ---------------------------------------------------------------------------
// llmCalls
// ---------------------------------------------------------------------------

export const llmCalls = {
  record(
    db: Database.Database,
    row: {
      batch_id?: string | null;
      variant_id?: string | null;
      kind: LlmCallKind;
      model: string;
      input_tokens: number;
      output_tokens: number;
      cost_usd: number;
    },
  ): number {
    const result = db.prepare(`
      INSERT INTO llm_calls (batch_id, variant_id, kind, model, input_tokens, output_tokens, cost_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.batch_id ?? null,
      row.variant_id ?? null,
      row.kind,
      row.model,
      row.input_tokens,
      row.output_tokens,
      row.cost_usd,
    );
    return Number(result.lastInsertRowid);
  },

  /** Total spend in USD across a time range. Drives daily/monthly alarms. */
  spendBetween(db: Database.Database, sinceIso: string, untilIso: string): number {
    const row = db.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) AS total
      FROM llm_calls
      WHERE created_at >= ? AND created_at < ?
    `).get(sinceIso, untilIso) as { total: number };
    return row.total;
  },
};

// ---------------------------------------------------------------------------
// draftBatches
// ---------------------------------------------------------------------------

export const draftBatches = {
  save(
    db: Database.Database,
    row: {
      batch_id: string;
      brand_id?: string;
      draft_text: string;
      variants_json?: string | null;
      lint_result_json?: string | null;
      status?: DraftBatchStatus;
      metadata_json?: string;
    },
  ): void {
    db.prepare(`
      INSERT INTO draft_batches
        (batch_id, brand_id, draft_text, variants_json, lint_result_json, status, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(batch_id) DO UPDATE SET
        brand_id = excluded.brand_id,
        draft_text = excluded.draft_text,
        variants_json = excluded.variants_json,
        lint_result_json = excluded.lint_result_json,
        status = excluded.status,
        metadata_json = excluded.metadata_json,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      row.batch_id,
      row.brand_id ?? 'main',
      row.draft_text,
      row.variants_json ?? null,
      row.lint_result_json ?? null,
      row.status ?? 'drafting',
      row.metadata_json ?? '{}',
    );
  },

  load(db: Database.Database, batchId: string): DraftBatch | null {
    const row = db
      .prepare('SELECT * FROM draft_batches WHERE batch_id = ?')
      .get(batchId) as DraftBatch | undefined;
    return row ?? null;
  },

  archive(db: Database.Database, batchId: string): void {
    db.prepare(`
      UPDATE draft_batches SET status = 'archived', updated_at = CURRENT_TIMESTAMP
      WHERE batch_id = ?
    `).run(batchId);
  },
};
