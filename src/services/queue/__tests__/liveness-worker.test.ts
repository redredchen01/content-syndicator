import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { handleLivenessJob, checkLiveness } from '../liveness-worker';
import type { PublishJob } from '../../../db/repositories';
import { applyV2Schema } from '../../../db/schema';

vi.mock('../../../sheets', () => ({
  getSheetsClient: () => ({
    updateLiveness: vi.fn().mockResolvedValue(undefined),
    appendRow: vi.fn(),
    appendPost: vi.fn(),
    reconcileWithSqlite: vi.fn(),
    refreshAggregates: vi.fn(),
  }),
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

function makeJob(overrides: Partial<PublishJob> = {}): PublishJob {
  return {
    id: 1,
    batch_id: 'batch_test',
    variant_id: 'variant_test',
    platform: 'Dev.to',
    job_type: 'health_check_t24h',
    payload_json: JSON.stringify({
      published_url: 'https://dev.to/article/123',
      platform: 'Dev.to',
    }),
    scheduled_at: new Date().toISOString(),
    status: 'running',
    attempts: 0,
    last_error: null,
    metadata_json: '{}',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// checkLiveness unit tests
// ---------------------------------------------------------------------------

describe('checkLiveness', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('200 response → alive', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200, headers: new Headers() }));
    const result = await checkLiveness('https://dev.to/article/123', 'Dev.to');
    expect(result.classification).toBe('alive');
    expect(result.httpStatus).toBe(200);
  });

  it('206 (range) → alive', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 206, headers: new Headers() }));
    const result = await checkLiveness('https://dev.to/article/123', 'Dev.to');
    expect(result.classification).toBe('alive');
  });

  it('404 → 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 404, headers: new Headers() }));
    const result = await checkLiveness('https://dev.to/missing', 'Dev.to');
    expect(result.classification).toBe('404');
    expect(result.httpStatus).toBe(404);
  });

  it('410 → 410', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 410, headers: new Headers() }));
    const result = await checkLiveness('https://dev.to/deleted', 'Dev.to');
    expect(result.classification).toBe('410');
  });

  it('301 to same domain → redirect_alive', async () => {
    const headers = new Headers({ location: 'https://dev.to/article/123-new' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 301, headers }));
    const result = await checkLiveness('https://dev.to/article/123', 'Dev.to');
    expect(result.classification).toBe('redirect_alive');
  });

  it('301 to different domain (takedown) → unknown', async () => {
    const headers = new Headers({ location: 'https://takedown-notice.example.com' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 301, headers }));
    const result = await checkLiveness('https://dev.to/article/123', 'Dev.to');
    expect(result.classification).toBe('unknown');
  });

  it('AbortError (timeout) → timeout', async () => {
    const err = new Error('signal timed out'); err.name = 'AbortError';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(err));
    const result = await checkLiveness('https://dev.to/slow', 'Dev.to');
    expect(result.classification).toBe('timeout');
    expect(result.httpStatus).toBeNull();
  });

  it('Network error → unknown', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const result = await checkLiveness('https://down.example.com', 'Dev.to');
    expect(result.classification).toBe('unknown');
    expect(result.httpStatus).toBeNull();
  });

  it('GitHub uses HEAD (PLATFORM_HEAD_SUPPORTED=true)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, headers: new Headers() });
    vi.stubGlobal('fetch', fetchMock);
    await checkLiveness('https://github.com/user/repo', 'GitHub');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ method: 'HEAD' }),
    );
  });

  it('Dev.to uses GET (PLATFORM_HEAD_SUPPORTED=false)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, headers: new Headers() });
    vi.stubGlobal('fetch', fetchMock);
    await checkLiveness('https://dev.to/article/123', 'Dev.to');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ method: 'GET' }),
    );
  });
});

// ---------------------------------------------------------------------------
// handleLivenessJob integration tests
// ---------------------------------------------------------------------------

describe('handleLivenessJob', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('writes link_checks row on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200, headers: new Headers() }));
    const db = makeDb();

    await handleLivenessJob(makeJob(), db);

    const rows = db.prepare('SELECT * FROM link_checks WHERE batch_id = ?').all('batch_test');
    expect(rows).toHaveLength(1);
    expect((rows[0] as any).classification).toBe('alive');
    db.close();
  });

  it('maps job_type to check_type correctly', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 404, headers: new Headers() }));
    const db = makeDb();

    await handleLivenessJob(makeJob({ job_type: 'health_check_t7d' }), db);

    const rows = db.prepare('SELECT check_type FROM link_checks').all();
    expect((rows[0] as any).check_type).toBe('t7d');
    db.close();
  });

  it('throws on corrupt payload but does not swallow', async () => {
    const db = makeDb();
    const badJob = makeJob({ payload_json: 'not json' });
    await expect(handleLivenessJob(badJob, db)).rejects.toThrow();
    db.close();
  });

  it('does not throw when Sheets update fails (non-fatal)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200, headers: new Headers() }));
    const { getSheetsClient } = await import('../../../sheets');
    (getSheetsClient as ReturnType<typeof vi.fn>)().updateLiveness = vi.fn().mockRejectedValue(new Error('Sheets error'));

    const db = makeDb();
    await expect(handleLivenessJob(makeJob(), db)).resolves.toBeUndefined();
    db.close();
  });
});
