/**
 * Sheets canonical interface (Unit 12a stub).
 *
 * Unit 10 (publish worker) and Unit 13 (liveness) import this type,
 * not the concrete googleapis implementation, so those units can be
 * developed and tested independently. The real implementation lives
 * in src/sheets/index.ts (Unit 12b).
 *
 * Column order for the "Posts" sheet (12 columns):
 *   timestamp | brand_id | batch_id | platform | persona_group |
 *   anchor_words | target_url | published_url | status |
 *   t24h_alive | t7d_alive | t30d_alive
 */

export interface PostRow {
  timestamp: string;
  brand_id: string;
  batch_id: string;
  platform: string;
  persona_group: string;
  anchor_words: string; // comma-separated
  target_url: string;
  published_url: string;
  status: string;
  t24h_alive?: string;
  t7d_alive?: string;
  t30d_alive?: string;
}

export type LivenessColumn = 't24h_alive' | 't7d_alive' | 't30d_alive';

export interface SheetsClient {
  /**
   * Generic row append — used by v0.1 back-compat shim and any caller
   * that needs to write to an arbitrary range.
   */
  appendRow(range: string, values: string[]): Promise<void>;

  /**
   * Appends a new row to the Posts sheet. Called after each successful
   * publish (Unit 10 worker, learning #2: rate-limit at dequeue not
   * enqueue; sheets append is part of the publish pipeline).
   */
  appendPost(row: PostRow): Promise<void>;

  /**
   * Updates the liveness column for an existing row identified by
   * (batch_id, platform). Called by Unit 13 health_check workers.
   */
  updateLiveness(
    batchId: string,
    platform: string,
    column: LivenessColumn,
    value: string,
  ): Promise<void>;

  /**
   * Writes or rewrites the Aggregates sheet (called by daily cron job).
   * Aggregates across all Posts rows: by target_url, platform, persona.
   */
  refreshAggregates(): Promise<void>;

  /**
   * Reconciliation: reads SQLite succeeded jobs, finds rows missing
   * from the Posts sheet, and appends them. Runs at 04:30 daily.
   */
  reconcileWithSqlite(
    sqliteRows: Array<{ batch_id: string; platform: string; published_url: string }>,
  ): Promise<void>;
}

/**
 * No-op stub for Unit 10/13 to import while Unit 12b is not yet wired.
 * All methods are async no-ops — no failures, no side-effects.
 */
export class NopSheetsClient implements SheetsClient {
  async appendRow(_range: string, _values: string[]): Promise<void> {
    // no-op stub
  }

  async appendPost(_row: PostRow): Promise<void> {
    // no-op stub — replaced by GoogleSheetsClient in Unit 12b
  }

  async updateLiveness(
    _batchId: string,
    _platform: string,
    _column: LivenessColumn,
    _value: string,
  ): Promise<void> {
    // no-op stub
  }

  async refreshAggregates(): Promise<void> {
    // no-op stub
  }

  async reconcileWithSqlite(
    _sqliteRows: Array<{ batch_id: string; platform: string; published_url: string }>,
  ): Promise<void> {
    // no-op stub
  }
}
