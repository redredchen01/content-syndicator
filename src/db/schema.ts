/**
 * v0.2 SQLite schema (Plan Unit 2).
 *
 * Single source of truth — `src/db/index.ts` applies it on import; tests
 * instantiate a fresh `:memory:` Database and call `applyV2Schema(db)` to
 * get the same shape in isolation.
 *
 * All statements are idempotent (`CREATE TABLE IF NOT EXISTS`) and
 * backwards-compatible: legacy posts rows survive with NULL batch_id.
 */

import type Database from 'better-sqlite3';

/**
 * Adds a column to a table only if it is not already present.
 * SQLite's ALTER TABLE ADD COLUMN errors if the column exists; we guard
 * against that using PRAGMA table_info so the migration is idempotent.
 */
export function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  typeAndDefault: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeAndDefault}`);
}

export function applyV2Schema(db: Database.Database): void {
  // Existing v0.1 table — kept for back-compat. New columns added below.
  db.exec(`
    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      original_url TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      results_json TEXT NOT NULL
    )
  `);

  // posts: v0.2 columns. Idempotent — old rows keep NULL on these.
  addColumnIfMissing(db, 'posts', 'batch_id', 'TEXT');
  addColumnIfMissing(db, 'posts', 'brand_id', "TEXT DEFAULT 'main'");
  addColumnIfMissing(db, 'posts', 'variant_id', 'TEXT');
  addColumnIfMissing(db, 'posts', 'platform', 'TEXT');
  addColumnIfMissing(db, 'posts', 'published_url', 'TEXT');

  // Per Plan: idempotent worker upsert keyed on (batch_id, variant_id, platform)
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_batch_variant_platform
      ON posts(batch_id, variant_id, platform)
      WHERE batch_id IS NOT NULL
  `);

  // task_progress — its CREATE statement was missing from v0.1. Add cleanly.
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_progress (
      task_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      status TEXT NOT NULL,
      last_error TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (task_id, platform)
    )
  `);

  // brand_profiles — single row enforced via trigger (adversarial F7).
  db.exec(`
    CREATE TABLE IF NOT EXISTS brand_profiles (
      brand_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_variants_json TEXT NOT NULL DEFAULT '[]',
      target_urls_json TEXT NOT NULL DEFAULT '[]',
      exposure_blocklist_json TEXT NOT NULL DEFAULT '[]',
      anchor_blocklist_json TEXT NOT NULL DEFAULT '[]',
      signature TEXT,
      anchor_concentration_threshold REAL DEFAULT 0.30,
      weekly_url_cap INTEGER DEFAULT 6,
      jaccard_threshold REAL DEFAULT 0.5,
      digest_channel TEXT CHECK(digest_channel IN ('none','email','telegram')) DEFAULT 'none',
      digest_destination TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS brand_profiles_single_row
      BEFORE INSERT ON brand_profiles
      WHEN (SELECT COUNT(*) FROM brand_profiles) >= 1
      BEGIN
        SELECT RAISE(ABORT, 'brand_profiles is single-row only; use UPDATE');
      END
  `);

  // publish_jobs — unified queue table. UNIQUE on (batch_id, variant_id,
  // platform, job_type) makes health_check enqueue idempotent.
  db.exec(`
    CREATE TABLE IF NOT EXISTS publish_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id TEXT NOT NULL,
      variant_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      job_type TEXT NOT NULL CHECK(job_type IN (
        'publish',
        'health_check_t24h','health_check_t7d','health_check_t30d',
        'aggregate_sheets','daily_digest','reconciliation','monthly_alert'
      )),
      payload_json TEXT NOT NULL DEFAULT '{}',
      scheduled_at DATETIME NOT NULL,
      status TEXT NOT NULL CHECK(status IN (
        'scheduled','running','succeeded','skipped','failed_retryable','failed_terminal'
      )) DEFAULT 'scheduled',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      metadata_json TEXT DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(batch_id, variant_id, platform, job_type)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_publish_jobs_dispatch
      ON publish_jobs(status, scheduled_at)
  `);

  // link_checks — T+24h / T+7d / T+30d outcomes per (batch, variant, platform).
  db.exec(`
    CREATE TABLE IF NOT EXISTS link_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id TEXT NOT NULL,
      variant_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      published_url TEXT NOT NULL,
      check_type TEXT NOT NULL CHECK(check_type IN ('t24h','t7d','t30d')),
      http_status INTEGER,
      classification TEXT NOT NULL CHECK(classification IN (
        'alive','redirect_alive','404','410','timeout','unknown'
      )),
      checked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(batch_id, variant_id, platform, check_type)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_link_checks_check_type
      ON link_checks(check_type, classification, checked_at)
  `);

  // anchor_history — every anchor used per published variant. Drives R10b
  // distribution monitoring (last-30-batches) and audit.
  db.exec(`
    CREATE TABLE IF NOT EXISTS anchor_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id TEXT NOT NULL,
      variant_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      anchor_text TEXT NOT NULL,
      target_url TEXT NOT NULL,
      used_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_anchor_history_used_at
      ON anchor_history(used_at)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_anchor_history_batch
      ON anchor_history(batch_id)
  `);

  // llm_calls — per-call cost tracking for budget alarm (adversarial F6 / P0-2).
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id TEXT,
      variant_id TEXT,
      kind TEXT NOT NULL CHECK(kind IN (
        'variant_body','variant_anchor','regenerate','single'
      )),
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_llm_calls_created_at
      ON llm_calls(created_at)
  `);

  // draft_batches — pre-dispatch persistence for preview state recovery
  // (origin R13) and single-tab regenerate context (P1-9 / feasibility F8).
  db.exec(`
    CREATE TABLE IF NOT EXISTS draft_batches (
      batch_id TEXT PRIMARY KEY,
      brand_id TEXT NOT NULL DEFAULT 'main',
      draft_text TEXT NOT NULL,
      variants_json TEXT,
      lint_result_json TEXT,
      status TEXT NOT NULL CHECK(status IN ('drafting','dispatched','archived')) DEFAULT 'drafting',
      metadata_json TEXT DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Add Unit 3 columns for API key storage and platform test status
  addColumnIfMissing(db, 'brand_profiles', 'api_keys_encrypted', "TEXT DEFAULT '{}'");
  addColumnIfMissing(db, 'brand_profiles', 'platform_test_status', "TEXT DEFAULT '{}'");

  // Add Unit 4 columns for onboarding tracking
  addColumnIfMissing(db, 'brand_profiles', 'onboarding_completed_at', 'DATETIME');
  addColumnIfMissing(db, 'brand_profiles', 'preferred_platforms_json', "TEXT DEFAULT '[]'");

  // Optimize publish_jobs queries with composite index for common dispatch patterns
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_publish_jobs_status_type
      ON publish_jobs(status, job_type, scheduled_at)
  `);

  // Optimize anchor_history queries for recent batches lookups
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_anchor_history_batch_used
      ON anchor_history(batch_id, used_at DESC)
  `);

  // oauth_tokens — one row per platform. Stores user-level OAuth2 credentials
  // obtained via the /api/auth/google/callback flow. Takes precedence over
  // service-account JSON for adapters that support it (e.g. Blogger).
  db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      platform    TEXT PRIMARY KEY,
      access_token  TEXT,
      refresh_token TEXT NOT NULL,
      expires_at    INTEGER,
      updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ROI auto-ranking: DA tier config + skip threshold per brand
  addColumnIfMissing(db, 'brand_profiles', 'da_tier_config_json', "TEXT DEFAULT '{}'");
  addColumnIfMissing(db, 'brand_profiles', 'roi_threshold', 'REAL DEFAULT 0.3');

  // ROI auto-ranking: priority column for queue ordering (REAL preserves score precision)
  addColumnIfMissing(db, 'publish_jobs', 'priority', 'REAL NOT NULL DEFAULT 0.0');

  // Compound backlink graph: marks anchor_history rows where WordPress variant
  // linked to a tier-2 intermediate page instead of the brand money page.
  // Used for 7-day cooldown queries and anti-tier-3 pool exclusion.
  addColumnIfMissing(db, 'anchor_history', 'is_tier2', 'INTEGER NOT NULL DEFAULT 0');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_anchor_history_tier2
      ON anchor_history(is_tier2, target_url, used_at)
  `);

  // Rebuild dispatch index to include priority DESC for ROI-ordered dequeue
  db.exec('DROP INDEX IF EXISTS idx_publish_jobs_dispatch');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_publish_jobs_dispatch
      ON publish_jobs(status, priority DESC, scheduled_at ASC)
  `);

  // Index for per-platform survival rate queries (Unit 2 / ROI scorer)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_link_checks_platform_type
      ON link_checks(platform, check_type, checked_at)
  `);

  // variant_cache — LLM generation result caching (Unit 5, R3)
  // Keyed by hash(brand_id + draft_hash + persona_group) for 24h TTL reuse
  db.exec(`
    CREATE TABLE IF NOT EXISTS variant_cache (
      cache_key TEXT PRIMARY KEY,
      brand_id TEXT NOT NULL,
      draft_hash TEXT NOT NULL,
      persona_group TEXT NOT NULL,
      title TEXT NOT NULL,
      body_markdown TEXT NOT NULL,
      anchor_words TEXT DEFAULT '[]',
      generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      hit_count INTEGER DEFAULT 0
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_variant_cache_brand_expires
      ON variant_cache(brand_id, expires_at)
  `);

  // Index for batch queries by brand and status (Unit 6)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_draft_batches_brand_status
      ON draft_batches(brand_id, status)
  `);
}
