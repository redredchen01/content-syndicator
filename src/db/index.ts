/**
 * SQLite singleton + back-compat exports for v0.1 callers.
 *
 * v0.2 prefers `src/db/repositories.ts` (multi-namespace, db-injected).
 * Legacy savePost / updateTaskProgress / getTaskProgress / getPostsHistory
 * remain wired to the singleton so untouched v0.1 paths keep working.
 *
 * Tests should NOT import this module — they instantiate their own
 * `:memory:` Database and call applyV2Schema(db) directly.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { logger } from '../utils/logger';
import { applyV2Schema } from './schema';

const DB_DIR = path.join(process.cwd(), '.data');
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const db = new Database(path.join(DB_DIR, 'syndicator.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

applyV2Schema(db);

export { db };

// Re-export repositories so callers can do `import { brandProfile } from './db'`.
// Note: oauthTokens lives in its own module (./oauth-tokens) because it
// transparently encrypts refresh_token at rest — separating it from
// repositories keeps the DAO surface honest about which fields are encrypted.
export {
  brandProfile,
  publishJobs,
  linkChecks,
  anchorHistory,
  llmCalls,
  draftBatches,
} from './repositories';
export { oauthTokens } from './oauth-tokens';

export type {
  BrandProfile,
  PublishJob,
  LinkCheck,
  LinkCheckType,
  LinkClassification,
  JobType,
  JobStatus,
  LlmCallKind,
  DraftBatch,
  DraftBatchStatus,
} from './repositories';

// ---------------------------------------------------------------------------
// v0.1 back-compat API (kept identical so server.ts / cli.ts keep working)
// ---------------------------------------------------------------------------

export interface SavedPost {
  id: number;
  timestamp: string;
  original_url: string;
  title: string;
  content: string;
  results_json: string;
}

export function savePost(
  originalUrl: string,
  title: string,
  content: string,
  results: unknown[],
  batchId?: string,
): void {
  try {
    const stmt = db.prepare(
      'INSERT INTO posts (original_url, title, content, results_json, batch_id) VALUES (?, ?, ?, ?, ?)',
    );
    stmt.run(originalUrl, title, content, JSON.stringify(results), batchId ?? null);
    logger.success?.('Post saved to local SQLite database.');
  } catch (error) {
    logger.error('Failed to save post to local database', error);
  }
}

export function updateTaskProgress(
  taskId: string,
  platform: string,
  status: string,
  error?: string,
): void {
  try {
    const stmt = db.prepare(`
      INSERT INTO task_progress (task_id, platform, status, last_error, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(task_id, platform) DO UPDATE SET
        status = excluded.status,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `);
    stmt.run(taskId, platform, status, error || null);
  } catch (e) {
    logger.error('Failed to update task progress', e);
  }
}

export function getTaskProgress(
  taskId: string,
): Array<{ platform: string; status: string; last_error: string | null }> {
  try {
    const stmt = db.prepare(
      'SELECT platform, status, last_error FROM task_progress WHERE task_id = ?',
    );
    return stmt.all(taskId) as Array<{
      platform: string;
      status: string;
      last_error: string | null;
    }>;
  } catch (error) {
    logger.error('Failed to get task progress', error);
    return [];
  }
}

export function getPostsHistory(): SavedPost[] {
  try {
    const stmt = db.prepare('SELECT * FROM posts ORDER BY timestamp DESC LIMIT 100');
    return stmt.all() as SavedPost[];
  } catch (error) {
    logger.error('Failed to retrieve history from local database', error);
    return [];
  }
}
