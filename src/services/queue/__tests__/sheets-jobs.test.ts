import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { handleAggregateSheets, handleReconciliation, seedSheetsJobs } from '../sheets-jobs';
import type { PublishJob } from '../../../db/repositories';
import { applyV2Schema } from '../../../db/schema';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockSheets = {
  refreshAggregates: vi.fn().mockResolvedValue(undefined),
  reconcileWithSqlite: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../../../sheets', () => ({
  getSheetsClient: vi.fn(() => mockSheets),
}));

vi.mock('../../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDb() {
  const db = new Database(':memory:');
  applyV2Schema(db);
  return db;
}

function makeJob(jobType = 'aggregate_sheets'): PublishJob {
  return {
    id: 1,
    batch_id: 'system',
    variant_id: jobType,
    platform: 'system',
    job_type: jobType,
    payload_json: '{}',
    scheduled_at: new Date().toISOString(),
    status: 'running',
    attempts: 0,
    last_error: null,
    metadata_json: '{}',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function insertSucceededJob(db: Database.Database, batchId = 'batch1', platform = 'github') {
  db.prepare(`
    INSERT INTO publish_jobs
      (batch_id, variant_id, platform, job_type, payload_json, scheduled_at, status, attempts, metadata_json)
    VALUES (?, 'v1', ?, 'publish', '{}', datetime('now'), 'succeeded', 1, '{}')
  `).run(batchId, platform);
}

function insertPost(db: Database.Database, batchId = 'batch1', platform = 'github', publishedUrl = 'https://github.com/test') {
  db.prepare(`
    INSERT INTO posts (original_url, title, content, results_json, batch_id, variant_id, platform, published_url)
    VALUES ('https://src.com', 'Test', 'content', '[]', ?, 'v1', ?, ?)
  `).run(batchId, platform, publishedUrl);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSheets.refreshAggregates.mockResolvedValue(undefined);
  mockSheets.reconcileWithSqlite.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// handleAggregateSheets
// ---------------------------------------------------------------------------

describe('handleAggregateSheets', () => {
  it('calls refreshAggregates on the sheets client', async () => {
    const db = makeDb();
    await handleAggregateSheets(makeJob(), db);
    expect(mockSheets.refreshAggregates).toHaveBeenCalledOnce();
    db.close();
  });

  it('logs info before and after a successful run', async () => {
    const db = makeDb();
    const { logger } = await import('../../../utils/logger');
    await handleAggregateSheets(makeJob(), db);
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      expect.stringContaining('aggregate_sheets'),
    );
    db.close();
  });

  it('catches sheets error and logs warn — does not rethrow', async () => {
    const db = makeDb();
    mockSheets.refreshAggregates.mockRejectedValue(new Error('Sheets API quota exceeded'));
    const { logger } = await import('../../../utils/logger');

    await expect(handleAggregateSheets(makeJob(), db)).resolves.toBeUndefined();

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining('Sheets API quota exceeded'),
    );
    db.close();
  });
});

// ---------------------------------------------------------------------------
// handleReconciliation
// ---------------------------------------------------------------------------

describe('handleReconciliation', () => {
  it('syncs succeeded publish_jobs that have matching posts rows', async () => {
    const db = makeDb();
    insertSucceededJob(db, 'batch1', 'github');
    insertPost(db, 'batch1', 'github', 'https://github.com/article');

    await handleReconciliation(makeJob('reconciliation'), db);

    expect(mockSheets.reconcileWithSqlite).toHaveBeenCalledOnce();
    const [rows] = mockSheets.reconcileWithSqlite.mock.calls[0];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      batch_id: 'batch1',
      platform: 'github',
      published_url: 'https://github.com/article',
    });
    db.close();
  });

  it('skips reconcileWithSqlite when there are no succeeded jobs', async () => {
    const db = makeDb();
    const { logger } = await import('../../../utils/logger');

    await handleReconciliation(makeJob('reconciliation'), db);

    expect(mockSheets.reconcileWithSqlite).not.toHaveBeenCalled();
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      expect.stringContaining('nothing to sync'),
    );
    db.close();
  });

  it('filters out publish_jobs with no matching published_url in posts', async () => {
    const db = makeDb();
    // Job succeeded but post row has no published_url
    insertSucceededJob(db, 'batch2', 'medium');
    // No matching post inserted → LEFT JOIN gives null published_url → filtered out

    await handleReconciliation(makeJob('reconciliation'), db);

    expect(mockSheets.reconcileWithSqlite).not.toHaveBeenCalled();
    db.close();
  });

  it('catches sheets error and logs warn — does not rethrow', async () => {
    const db = makeDb();
    insertSucceededJob(db, 'batch3', 'devto');
    insertPost(db, 'batch3', 'devto', 'https://dev.to/article');
    mockSheets.reconcileWithSqlite.mockRejectedValue(new Error('Sheets write failed'));
    const { logger } = await import('../../../utils/logger');

    await expect(handleReconciliation(makeJob('reconciliation'), db)).resolves.toBeUndefined();

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining('Sheets write failed'),
    );
    db.close();
  });
});

// ---------------------------------------------------------------------------
// seedSheetsJobs
// ---------------------------------------------------------------------------

describe('seedSheetsJobs', () => {
  it('inserts aggregate_sheets and reconciliation jobs for today', () => {
    const db = makeDb();
    seedSheetsJobs(db);

    const jobs = db
      .prepare(`SELECT job_type FROM publish_jobs WHERE job_type IN ('aggregate_sheets','reconciliation')`)
      .all() as Array<{ job_type: string }>;

    const types = jobs.map((j) => j.job_type);
    expect(types).toContain('aggregate_sheets');
    expect(types).toContain('reconciliation');
    db.close();
  });

  it('does not insert duplicates on second call', () => {
    const db = makeDb();
    seedSheetsJobs(db);
    seedSheetsJobs(db);

    const count = (
      db
        .prepare(`SELECT COUNT(*) as n FROM publish_jobs WHERE job_type IN ('aggregate_sheets','reconciliation')`)
        .get() as { n: number }
    ).n;
    expect(count).toBe(2);
    db.close();
  });
});
