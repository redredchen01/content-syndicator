import type Database from 'better-sqlite3';

export type { JobType, JobStatus, PublishJob } from './publish-jobs';
export { publishJobs } from './publish-jobs';

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

  /**
   * Returns survival rate for a check_type over the trailing N days.
   * Pass an optional `platform` to scope the query to a single platform
   * (used by the ROI scorer for per-platform scoring).
   */
  survivalRate(
    db: Database.Database,
    checkType: LinkCheckType,
    sinceIso: string,
    platform?: string,
  ): { total: number; alive: number; rate: number } {
    const wherePlatform = platform ? 'AND platform = ?' : '';
    const params: unknown[] = platform
      ? [checkType, sinceIso, platform]
      : [checkType, sinceIso];
    const row = db.prepare(`
      SELECT
        SUM(CASE WHEN classification IN ('alive','redirect_alive') THEN 1 ELSE 0 END) AS alive,
        COUNT(*) AS total
      FROM link_checks
      WHERE check_type = ? AND checked_at >= ? ${wherePlatform}
    `).get(...params) as { alive: number | null; total: number };
    const alive = row.alive ?? 0;
    const total = row.total;
    return { total, alive, rate: total === 0 ? 0 : alive / total };
  },

  /**
   * Returns the number of link_check records for a platform + check_type within
   * the trailing window. Used by the ROI scorer to determine cold-start status
   * (< 5 records → fall back to DA tier only).
   */
  survivalRecordCount(
    db: Database.Database,
    checkType: LinkCheckType,
    platform: string,
    sinceIso: string,
  ): number {
    const row = db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM link_checks
      WHERE check_type = ? AND platform = ? AND checked_at >= ?
    `).get(checkType, platform, sinceIso) as { cnt: number };
    return row.cnt;
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
