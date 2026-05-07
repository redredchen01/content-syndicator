import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { applyV2Schema } from '../../../db/schema';

// ---------------------------------------------------------------------------
// Mocks (hoisted before SUT import)
// ---------------------------------------------------------------------------

const adapterPublishMocks = new Map<string, ReturnType<typeof vi.fn>>();
const allAdaptersMock: Array<{
  name: string;
  isBrowserAutomation?: boolean;
  canPublishAutomatically?: boolean;
  publish?: (...args: unknown[]) => Promise<unknown>;
}> = [];

const appendToSheetMock = vi.fn();
const savePostMock = vi.fn();
const scrapeUrlMock = vi.fn();
const generateMarkdownMock = vi.fn();
const publishToPlatformsMock = vi.fn();
const filterByRoiMock = vi.fn();
const getPreferredPlatformsMock = vi.fn();
const resolveTargetPlatformsMock = vi.fn();
const randomSleepMock = vi.fn();

vi.mock('../../../adapters/index', () => ({
  get allAdapters() {
    return allAdaptersMock;
  },
}));

vi.mock('../../../sheets', () => ({
  appendToSheet: (...args: unknown[]) => appendToSheetMock(...args),
}));

vi.mock('../../../db', () => ({
  savePost: (...args: unknown[]) => savePostMock(...args),
}));

vi.mock('../../../scraper', () => ({
  scrapeUrl: (...args: unknown[]) => scrapeUrlMock(...args),
}));

vi.mock('../../../llm', () => ({
  generateMarkdown: (...args: unknown[]) => generateMarkdownMock(...args),
  generatePromoMarkdown: vi.fn(),
}));

vi.mock('../../publish-service', () => ({
  publishToPlatforms: (...args: unknown[]) => publishToPlatformsMock(...args),
}));

vi.mock('../../roi-scorer', () => ({
  filterByRoi: (...args: unknown[]) => filterByRoiMock(...args),
}));

vi.mock('../../brand-profile', () => ({
  getPreferredPlatforms: (...args: unknown[]) => getPreferredPlatformsMock(...args),
  // dispatch.ts doesn't use getProfile but other co-bundled modules might.
  getProfile: vi.fn(),
}));

vi.mock('../../admin/platforms', () => ({
  resolveTargetPlatforms: (...args: unknown[]) => resolveTargetPlatformsMock(...args),
}));

vi.mock('../../../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
  randomSleep: (...args: unknown[]) => randomSleepMock(...args),
}));

// SUT
import {
  runPublishingTask,
  startSinglePublish,
  startAutoPublish,
} from '../dispatch';
import { publishJobs } from '../../../db/repositories';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  applyV2Schema(db);
  return db;
}

function registerAdapter(name: string, publish: ReturnType<typeof vi.fn>): void {
  adapterPublishMocks.set(name, publish);
  allAdaptersMock.push({
    name,
    isBrowserAutomation: false,
    canPublishAutomatically: true,
    publish: (...args: unknown[]) => publish(...args),
  });
}

function seedScheduledJob(
  db: Database.Database,
  batchId: string,
  platform: string,
): number {
  const id = db
    .prepare(
      `INSERT INTO publish_jobs (batch_id, variant_id, platform, job_type, status, scheduled_at, payload_json, metadata_json, priority)
       VALUES (?, 'v1', ?, 'publish', 'scheduled', CURRENT_TIMESTAMP, '{}', '{}', 0)`,
    )
    .run(batchId, platform).lastInsertRowid;
  return Number(id);
}

beforeEach(() => {
  adapterPublishMocks.clear();
  allAdaptersMock.length = 0;

  appendToSheetMock.mockReset().mockResolvedValue(undefined);
  savePostMock.mockReset();
  scrapeUrlMock.mockReset();
  generateMarkdownMock.mockReset();
  publishToPlatformsMock.mockReset();
  filterByRoiMock.mockReset();
  getPreferredPlatformsMock.mockReset().mockReturnValue([]);
  resolveTargetPlatformsMock.mockReset();
  randomSleepMock.mockReset().mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// runPublishingTask — characterization tests for the async worker
// ---------------------------------------------------------------------------

describe('runPublishingTask — job state machine', () => {
  it('transitions both jobs scheduled → running → succeeded on happy path', async () => {
    const db = freshDb();
    const devPub = vi.fn().mockResolvedValue({
      success: true,
      publishedUrl: 'https://dev.to/post',
    });
    const medPub = vi.fn().mockResolvedValue({
      success: true,
      publishedUrl: 'https://medium.com/post',
    });
    registerAdapter('Dev.to', devPub);
    registerAdapter('Medium', medPub);

    const stateLog: string[] = [];
    const markRunningSpy = vi.spyOn(publishJobs, 'markRunning').mockImplementation((d, id) => {
      stateLog.push(`running:${id}`);
      d.prepare('UPDATE publish_jobs SET status = ? WHERE id = ?').run('running', id);
    });
    const markSucceededSpy = vi
      .spyOn(publishJobs, 'markSucceededWithUrl')
      .mockImplementation((d, id, url) => {
        stateLog.push(`succeeded:${id}`);
        d.prepare(
          `UPDATE publish_jobs SET status = 'succeeded', metadata_json = ? WHERE id = ?`,
        ).run(JSON.stringify({ publishedUrl: url }), id);
      });

    const id1 = seedScheduledJob(db, 'b1', 'Dev.to');
    const id2 = seedScheduledJob(db, 'b1', 'Medium');

    await runPublishingTask(db, 'b1', {
      sourceUrl: 'https://example.com',
      title: 'T',
      content: 'C',
    });

    expect(stateLog).toEqual([
      `running:${id1}`,
      `succeeded:${id1}`,
      `running:${id2}`,
      `succeeded:${id2}`,
    ]);
    expect(devPub).toHaveBeenCalledOnce();
    expect(medPub).toHaveBeenCalledOnce();

    markRunningSpy.mockRestore();
    markSucceededSpy.mockRestore();
  });

  it('isolates per-job adapter throws — loop continues, partial failure recorded', async () => {
    const db = freshDb();
    const failingPub = vi.fn().mockRejectedValue(new Error('boom'));
    const goodPub = vi.fn().mockResolvedValue({
      success: true,
      publishedUrl: 'https://medium.com/post',
    });
    registerAdapter('Dev.to', failingPub);
    registerAdapter('Medium', goodPub);

    seedScheduledJob(db, 'b1', 'Dev.to');
    seedScheduledJob(db, 'b1', 'Medium');

    await runPublishingTask(db, 'b1', {
      sourceUrl: 'https://example.com',
      title: 'T',
      content: 'C',
    });

    const rows = publishJobs.byBatch(db, 'b1');
    const dev = rows.find(r => r.platform === 'Dev.to')!;
    const med = rows.find(r => r.platform === 'Medium')!;
    expect(dev.status).toBe('failed_terminal');
    expect(dev.last_error).toMatch(/boom/);
    expect(med.status).toBe('succeeded');

    // Both adapters were invoked — adapter[0] throwing did NOT abort the loop.
    expect(failingPub).toHaveBeenCalledOnce();
    expect(goodPub).toHaveBeenCalledOnce();
  });

  it('records failure and skips when adapter not found in registry', async () => {
    const db = freshDb();
    seedScheduledJob(db, 'b1', 'GhostPlatform');

    await runPublishingTask(db, 'b1', {
      sourceUrl: 'https://example.com',
      title: 'T',
      content: 'C',
    });

    const rows = publishJobs.byBatch(db, 'b1');
    expect(rows[0].status).toBe('failed_terminal');
    expect(rows[0].last_error).toMatch(/Adapter not found/);
  });

  it('records failure when adapter returns success: false', async () => {
    const db = freshDb();
    const pub = vi.fn().mockResolvedValue({ success: false, error: 'rate limited' });
    registerAdapter('Dev.to', pub);
    seedScheduledJob(db, 'b1', 'Dev.to');

    await runPublishingTask(db, 'b1', {
      sourceUrl: 'https://example.com',
      title: 'T',
      content: 'C',
    });

    const [row] = publishJobs.byBatch(db, 'b1');
    expect(row.status).toBe('failed_terminal');
    expect(row.last_error).toBe('rate limited');
  });
});

describe('runPublishingTask — sheet + savePost side effects', () => {
  it('calls appendToSheet exactly once with formatted results', async () => {
    const db = freshDb();
    const pub = vi.fn().mockResolvedValue({
      success: true,
      publishedUrl: 'https://dev.to/post',
    });
    registerAdapter('Dev.to', pub);
    seedScheduledJob(db, 'b1', 'Dev.to');

    await runPublishingTask(db, 'b1', {
      sourceUrl: 'https://example.com',
      title: 'T',
      content: 'C',
    });

    expect(appendToSheetMock).toHaveBeenCalledOnce();
    const [sourceUrl, title, results] = appendToSheetMock.mock.calls[0];
    expect(sourceUrl).toBe('https://example.com');
    expect(title).toBe('T');
    expect(results).toEqual([
      {
        platform: 'Dev.to',
        success: true,
        error: undefined,
        publishedUrl: 'https://dev.to/post',
      },
    ]);
  });

  it('does not block savePost when appendToSheet rejects (fire-and-forget)', async () => {
    const db = freshDb();
    appendToSheetMock.mockRejectedValueOnce(new Error('sheets api down'));
    const pub = vi.fn().mockResolvedValue({ success: true, publishedUrl: 'https://x' });
    registerAdapter('Dev.to', pub);
    seedScheduledJob(db, 'b1', 'Dev.to');

    await expect(
      runPublishingTask(db, 'b1', {
        sourceUrl: 'https://example.com',
        title: 'T',
        content: 'C',
      }),
    ).resolves.toBeUndefined();

    expect(savePostMock).toHaveBeenCalledOnce();
  });

  it('returns immediately for an empty batch (no adapter / sheet calls)', async () => {
    const db = freshDb();
    await runPublishingTask(db, 'empty', {
      sourceUrl: 'https://example.com',
      title: 'T',
      content: 'C',
    });

    // Sheet + savePost are still invoked once with empty results — that's the
    // legacy contract (it's a noop sheet write but the call shape is fixed).
    expect(appendToSheetMock).toHaveBeenCalledOnce();
    expect(appendToSheetMock.mock.calls[0][2]).toEqual([]);
    expect(savePostMock).toHaveBeenCalledOnce();
    expect(randomSleepMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// startSinglePublish (POST /api/publish)
// ---------------------------------------------------------------------------

describe('startSinglePublish', () => {
  it('returns 400 when title or content is missing', () => {
    const db = freshDb();
    const r = startSinglePublish(db, { title: 'only title' });
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it('returns 400 when no platforms can be resolved', () => {
    const db = freshDb();
    resolveTargetPlatformsMock.mockReturnValue([]);
    getPreferredPlatformsMock.mockReturnValue([]);
    const r = startSinglePublish(db, { title: 'T', content: 'C' });
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it('uses preferred platforms when client sends an empty platforms array', () => {
    const db = freshDb();
    getPreferredPlatformsMock.mockReturnValue(['Dev.to', 'Medium']);
    // Adapter registry empty → runPublishingTask will mark all as failed but
    // jobs still get created.
    const r = startSinglePublish(db, { title: 'T', content: 'C', platforms: [] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const jobs = publishJobs.byBatch(db, r.batchId);
      expect(jobs.map(j => j.platform).sort()).toEqual(['Dev.to', 'Medium']);
    }
  });

  it('forwards explicit platforms through resolveTargetPlatforms', () => {
    const db = freshDb();
    resolveTargetPlatformsMock.mockReturnValue(['Hashnode']);
    const r = startSinglePublish(db, {
      title: 'T',
      content: 'C',
      platforms: ['Hashnode'],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const jobs = publishJobs.byBatch(db, r.batchId);
      expect(jobs.map(j => j.platform)).toEqual(['Hashnode']);
    }
    expect(resolveTargetPlatformsMock).toHaveBeenCalledWith(db, ['Hashnode']);
  });

  it('defaults sourceUrl to manual-content when url omitted', () => {
    const db = freshDb();
    getPreferredPlatformsMock.mockReturnValue(['Dev.to']);
    const r = startSinglePublish(db, { title: 'T', content: 'C', platforms: [] });
    // We cannot assert sourceUrl directly without spying on runPublishingTask.
    // The important behaviour is observable via DB rows being created.
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.batchId).toMatch(/^batch_/);
  });
});

// ---------------------------------------------------------------------------
// startAutoPublish (POST /api/auto-publish)
// ---------------------------------------------------------------------------

describe('startAutoPublish', () => {
  function withGenerated() {
    generateMarkdownMock.mockResolvedValue({
      title: 'GenT',
      content: 'GenC',
      tags: ['t1'],
      excerpt: 'ex',
    });
    filterByRoiMock.mockReturnValue({
      eligible: [{ platform: 'Dev.to' }],
      skipped: [],
      roiScores: new Map([['Dev.to', 0.8]]),
      engineStatus: 'ok',
    });
    publishToPlatformsMock.mockResolvedValue({
      targetPlatforms: ['Dev.to'],
      results: [{ platform: 'Dev.to', success: true, publishedUrl: 'https://dev.to/p' }],
    });
    registerAdapter(
      'Dev.to',
      vi.fn().mockResolvedValue({ success: true, publishedUrl: 'https://dev.to/p' }),
    );
  }

  it('returns 400 in manual mode when rawContent missing', async () => {
    const db = freshDb();
    const r = await startAutoPublish(db, { mode: 'manual' });
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it('returns 400 in url mode when url missing', async () => {
    const db = freshDb();
    const r = await startAutoPublish(db, { mode: 'url' });
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it('manual mode: skips scrape, calls generateMarkdown with manual title', async () => {
    const db = freshDb();
    withGenerated();
    const r = await startAutoPublish(db, {
      mode: 'manual',
      rawContent: 'raw text',
      originalUrl: 'https://orig.com',
      platforms: ['Dev.to'],
    });

    expect(scrapeUrlMock).not.toHaveBeenCalled();
    expect(generateMarkdownMock).toHaveBeenCalledWith({
      title: 'Manual Content',
      content: 'raw text',
      originalUrl: 'https://orig.com',
    });
    expect('success' in r && r.success).toBe(true);
  });

  it('url mode: scrapes then generates markdown', async () => {
    const db = freshDb();
    withGenerated();
    scrapeUrlMock.mockResolvedValue({ title: 'S', content: 'B', originalUrl: 'https://x' });

    const r = await startAutoPublish(db, {
      mode: 'url',
      url: 'https://x',
      platforms: ['Dev.to'],
    });

    expect(scrapeUrlMock).toHaveBeenCalledWith('https://x');
    expect(generateMarkdownMock).toHaveBeenCalledOnce();
    expect('success' in r && r.success).toBe(true);
  });

  it('passes only ROI-eligible platforms to publishToPlatforms', async () => {
    const db = freshDb();
    generateMarkdownMock.mockResolvedValue({
      title: 'T',
      content: 'C',
      tags: [],
      excerpt: '',
    });
    filterByRoiMock.mockReturnValue({
      eligible: [{ platform: 'Dev.to' }],
      skipped: [{ platform: 'Medium', score: 0.1 }],
      roiScores: new Map(),
      engineStatus: 'ok',
    });
    publishToPlatformsMock.mockResolvedValue({
      targetPlatforms: ['Dev.to'],
      results: [{ platform: 'Dev.to', success: true }],
    });

    const r = await startAutoPublish(db, {
      mode: 'url',
      url: 'https://x',
      platforms: ['Dev.to', 'Medium'],
    });
    if ('success' in r) {
      // We assert against the publishToPlatforms call: only Dev.to was passed
      expect(publishToPlatformsMock).toHaveBeenCalledOnce();
      const callArg = publishToPlatformsMock.mock.calls[0][0];
      expect(callArg.platforms).toEqual(['Dev.to']);
    }
    scrapeUrlMock.mockResolvedValue({ title: 'S', content: 'B', originalUrl: 'https://x' });
  });
});
