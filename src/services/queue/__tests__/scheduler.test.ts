import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyV2Schema } from '../../../db/schema';
import { publishJobs } from '../../../db/repositories';
import { Scheduler, randomIntervalIso } from '../scheduler';
import type { PublishJob } from '../../../db/repositories';

function freshDb() {
  const db = new Database(':memory:');
  applyV2Schema(db);
  return db;
}

function scheduledNow(db: Database.Database, extra: Partial<Parameters<typeof publishJobs.insert>[1]> = {}) {
  return publishJobs.insert(db, {
    batch_id: 'b1',
    variant_id: 'v1',
    platform: 'Dev.to',
    job_type: 'publish',
    scheduled_at: new Date(Date.now() - 1000).toISOString(), // 1s in past
    ...extra,
  });
}

describe('Scheduler — zombie sweep', () => {
  it('resets stale running jobs at start()', () => {
    const db = freshDb();
    // Insert a job then manually set it to running with a stale updated_at.
    scheduledNow(db);
    publishJobs.dequeueDue(db, new Date().toISOString(), 5);
    db.prepare(`UPDATE publish_jobs SET updated_at = '2020-01-01T00:00:00Z'`).run();

    const s = new Scheduler(db, {
      tickIntervalMs: 100_000,  // prevent ticks during test
      zombieThresholdMinutes: 1,
      zombieSweepIntervalMinutes: 1000,
    });
    s.start();
    s.stop();

    const counts = publishJobs.countByStatus(db);
    expect(counts.running).toBe(0);
    expect(counts.failed_retryable).toBe(1);
    db.close();
  });
});

describe('Scheduler — handler dispatch', () => {
  let db: Database.Database;
  let scheduler: Scheduler;

  beforeEach(() => {
    db = freshDb();
    // Use a fast tick for tests; no zombie sweep needed.
    scheduler = new Scheduler(db, {
      tickIntervalMs: 20,
      zombieThresholdMinutes: 999,
      zombieSweepIntervalMinutes: 999,
    });
  });

  afterEach(() => {
    scheduler.stop();
    db.close();
  });

  it('calls handler for due job and expects handler to mark outcome', async () => {
    scheduledNow(db);
    const called: PublishJob[] = [];
    scheduler.registerHandler('publish', async (job, dbArg) => {
      called.push(job);
      publishJobs.markSucceeded(dbArg, job.id);
    });

    scheduler.start();
    await new Promise((r) => setTimeout(r, 200)); // wait for tick

    expect(called).toHaveLength(1);
    expect(publishJobs.countByStatus(db).succeeded).toBe(1);
  });

  it('marks terminal when no handler is registered', async () => {
    scheduledNow(db);
    // No handler registered for 'publish'.
    scheduler.start();
    await new Promise((r) => setTimeout(r, 200));

    const counts = publishJobs.countByStatus(db);
    expect(counts.failed_terminal).toBe(1);
  });

  it('catches handler throws and schedules retry', async () => {
    scheduledNow(db);
    scheduler.registerHandler('publish', async () => {
      throw new Error('transient boom');
    });

    scheduler.start();
    await new Promise((r) => setTimeout(r, 200));

    const counts = publishJobs.countByStatus(db);
    // First failure → attempts=1, < 2 → retry scheduled
    expect(counts.scheduled).toBeGreaterThanOrEqual(1);
    expect(counts.failed_terminal).toBe(0);
  });

  it('does not process future jobs', async () => {
    publishJobs.insert(db, {
      batch_id: 'b_future',
      variant_id: 'v1',
      platform: 'Dev.to',
      job_type: 'publish',
      scheduled_at: new Date(Date.now() + 60_000).toISOString(), // 1 min future
    });
    const called: PublishJob[] = [];
    scheduler.registerHandler('publish', async (job, dbArg) => {
      called.push(job);
      publishJobs.markSucceeded(dbArg, job.id);
    });

    scheduler.start();
    await new Promise((r) => setTimeout(r, 150));

    expect(called).toHaveLength(0);
    expect(publishJobs.countByStatus(db).scheduled).toBe(1);
  });

  it('isRunning reflects state', () => {
    expect(scheduler.isRunning).toBe(false);
    scheduler.start();
    expect(scheduler.isRunning).toBe(true);
    scheduler.stop();
    expect(scheduler.isRunning).toBe(false);
  });
});

describe('randomIntervalIso', () => {
  it('returns an ISO string in the future', () => {
    const iso = randomIntervalIso(20, 90);
    const future = new Date(iso).getTime();
    expect(future).toBeGreaterThan(Date.now() + 19 * 60_000);
    expect(future).toBeLessThan(Date.now() + 91 * 60_000);
  });

  it('is a valid date string', () => {
    expect(Number.isNaN(new Date(randomIntervalIso(1, 2)).getTime())).toBe(false);
  });
});
