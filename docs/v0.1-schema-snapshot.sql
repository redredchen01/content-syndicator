-- v0.1 SQLite schema baseline (as of 2026-04-30, before v0.2 refactor)
--
-- Captured by: scripts/preflight-check.ts (Plan Unit 1)
-- Source DB:   .data/syndicator.db
--
-- Notable observation confirmed by this snapshot:
--   `task_progress` table CREATE statement is MISSING from src/db/index.ts
--   AND from disk — meaning v0.1's updateTaskProgress() / getTaskProgress()
--   have been silently failing on every call (errors swallowed).
--   v0.2 Unit 2 will introduce it cleanly alongside the 6 new tables.

CREATE TABLE posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    original_url TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    results_json TEXT NOT NULL
  );
CREATE TABLE sqlite_sequence(name,seq);
