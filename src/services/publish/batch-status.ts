/**
 * services/publish/batch-status.ts (Plan 2026-05-07-002 Unit 5)
 *
 * Read-side queries for publish_jobs:
 *   GET /api/batch-status/:batchId  → getBatchStatus  (v1 progress polling)
 *   GET /api/v2/queue               → getQueueSnapshot (v0.2 queue page polling)
 *
 * Both endpoints already had thin handlers in routes/publish.ts; the only
 * non-trivial piece is the v1 progress aggregation (total / completed /
 * percent / isFinished). Unknown batchIds return an empty payload rather
 * than 404 — the v1 spinner UI polls before any jobs exist.
 */

import type Database from 'better-sqlite3';
import { publishJobs, type PublishJob } from '../../db/repositories';

const COMPLETED_STATUSES: ReadonlyArray<PublishJob['status']> = [
  'succeeded',
  'failed_terminal',
  'skipped',
];

export interface BatchStatusSnapshot {
  batchId: string;
  percent: number;
  total: number;
  completed: number;
  jobs: PublishJob[];
  isFinished: boolean;
}

export function getBatchStatus(db: Database.Database, batchId: string): BatchStatusSnapshot {
  const jobs = publishJobs.byBatch(db, batchId);
  const total = jobs.length;
  const completed = jobs.filter(j => COMPLETED_STATUSES.includes(j.status)).length;
  return {
    batchId,
    percent: total > 0 ? Math.round((completed / total) * 100) : 0,
    total,
    completed,
    jobs,
    isFinished: completed === total && total > 0,
  };
}

const QUEUE_SNAPSHOT_LIMIT = 200;

export interface QueueSnapshot {
  jobs: PublishJob[];
}

export function getQueueSnapshot(db: Database.Database, batchId?: string): QueueSnapshot {
  if (batchId) {
    return { jobs: publishJobs.byBatch(db, batchId) };
  }
  const jobs = db
    .prepare('SELECT * FROM publish_jobs ORDER BY created_at DESC LIMIT ?')
    .all(QUEUE_SNAPSHOT_LIMIT) as PublishJob[];
  return { jobs };
}
