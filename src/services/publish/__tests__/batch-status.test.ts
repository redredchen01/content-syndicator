import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { applyV2Schema } from '../../../db/schema';
import { getBatchStatus, getQueueSnapshot } from '../batch-status';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  applyV2Schema(db);
  return db;
}

function insertJob(
  db: Database.Database,
  row: {
    batch_id: string;
    variant_id: string;
    platform: string;
    status?: string;
  },
): void {
  const id = db
    .prepare(
      'INSERT INTO publish_jobs (batch_id, variant_id, platform, job_type, payload_json, scheduled_at, metadata_json, priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(row.batch_id, row.variant_id, row.platform, 'publish', '{}', new Date().toISOString(), '{}', 0)
    .lastInsertRowid;
  if (row.status) {
    db.prepare('UPDATE publish_jobs SET status = ? WHERE id = ?').run(row.status, id);
  }
}

describe('getBatchStatus', () => {
  it('aggregates totals across mixed statuses', () => {
    const db = freshDb();
    insertJob(db, { batch_id: 'b1', variant_id: 'v1', platform: 'Dev.to', status: 'succeeded' });
    insertJob(db, { batch_id: 'b1', variant_id: 'v2', platform: 'Medium', status: 'failed_terminal' });
    insertJob(db, { batch_id: 'b1', variant_id: 'v3', platform: 'GitHub', status: 'skipped' });
    insertJob(db, { batch_id: 'b1', variant_id: 'v4', platform: 'Hashnode', status: 'running' });
    insertJob(db, { batch_id: 'b1', variant_id: 'v5', platform: 'Twitter', status: 'scheduled' });

    const r = getBatchStatus(db, 'b1');
    expect(r.batchId).toBe('b1');
    expect(r.total).toBe(5);
    expect(r.completed).toBe(3); // succeeded + failed_terminal + skipped
    expect(r.percent).toBe(60);
    expect(r.isFinished).toBe(false);
    expect(r.jobs).toHaveLength(5);
  });

  it('reports 100% and isFinished=true once every job has reached a terminal state', () => {
    const db = freshDb();
    insertJob(db, { batch_id: 'b1', variant_id: 'v1', platform: 'Dev.to', status: 'succeeded' });
    insertJob(db, { batch_id: 'b1', variant_id: 'v2', platform: 'Medium', status: 'failed_terminal' });

    const r = getBatchStatus(db, 'b1');
    expect(r.total).toBe(2);
    expect(r.completed).toBe(2);
    expect(r.percent).toBe(100);
    expect(r.isFinished).toBe(true);
  });

  it('returns empty payload (no 404) for an unknown batchId', () => {
    const db = freshDb();
    const r = getBatchStatus(db, 'does-not-exist');
    expect(r).toEqual({
      batchId: 'does-not-exist',
      percent: 0,
      total: 0,
      completed: 0,
      jobs: [],
      isFinished: false,
    });
  });

  it('does not flag isFinished=true when no jobs exist', () => {
    const db = freshDb();
    const r = getBatchStatus(db, 'empty');
    expect(r.isFinished).toBe(false);
  });

  it('isolates counts by batchId', () => {
    const db = freshDb();
    insertJob(db, { batch_id: 'b1', variant_id: 'v1', platform: 'Dev.to', status: 'succeeded' });
    insertJob(db, { batch_id: 'b2', variant_id: 'v1', platform: 'Dev.to', status: 'scheduled' });

    const r1 = getBatchStatus(db, 'b1');
    const r2 = getBatchStatus(db, 'b2');
    expect(r1.total).toBe(1);
    expect(r1.completed).toBe(1);
    expect(r2.total).toBe(1);
    expect(r2.completed).toBe(0);
  });
});

describe('getQueueSnapshot', () => {
  it('returns jobs filtered by batchId when supplied', () => {
    const db = freshDb();
    insertJob(db, { batch_id: 'b1', variant_id: 'v1', platform: 'Dev.to' });
    insertJob(db, { batch_id: 'b2', variant_id: 'v1', platform: 'Dev.to' });

    const r = getQueueSnapshot(db, 'b1');
    expect(r.jobs).toHaveLength(1);
    expect(r.jobs[0].batch_id).toBe('b1');
  });

  it('returns all jobs (across batches) when batchId omitted', () => {
    const db = freshDb();
    insertJob(db, { batch_id: 'b1', variant_id: 'v1', platform: 'Dev.to' });
    insertJob(db, { batch_id: 'b2', variant_id: 'v1', platform: 'Medium' });
    insertJob(db, { batch_id: 'b3', variant_id: 'v1', platform: 'GitHub' });

    const r = getQueueSnapshot(db);
    expect(r.jobs).toHaveLength(3);
    const batchIds = r.jobs.map(j => j.batch_id).sort();
    expect(batchIds).toEqual(['b1', 'b2', 'b3']);
  });

  it('returns empty jobs array when queue is empty', () => {
    const db = freshDb();
    const r = getQueueSnapshot(db);
    expect(r.jobs).toEqual([]);
  });
});
