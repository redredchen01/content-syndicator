import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { logger } from '../utils/logger';

const DB_DIR = path.join(process.cwd(), '.data');
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const db = new Database(path.join(DB_DIR, 'syndicator.db'));

// Initialize tables
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

export interface SavedPost {
  id: number;
  timestamp: string;
  original_url: string;
  title: string;
  content: string;
  results_json: string;
}

export function savePost(originalUrl: string, title: string, content: string, results: any[]) {
  try {
    const stmt = db.prepare('INSERT INTO posts (original_url, title, content, results_json) VALUES (?, ?, ?, ?)');
    stmt.run(originalUrl, title, content, JSON.stringify(results));
    logger.success('Post saved to local SQLite database.');
  } catch (error) {
    logger.error('Failed to save post to local database', error);
  }
}

// ... existing code ...
export function updateTaskProgress(taskId: string, platform: string, status: string, error?: string): void {
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
  } catch (error) {
    logger.error('Failed to update task progress', error);
  }
}

export function getTaskProgress(taskId: string): Array<{ platform: string; status: string; last_error: string | null }> {
  try {
    const stmt = db.prepare('SELECT platform, status, last_error FROM task_progress WHERE task_id = ?');
    const rows = stmt.all(taskId) as Array<{ platform: string; status: string; last_error: string | null }>;
    return rows;
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
// ... existing code ...
