import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { applyV2Schema } from '../../../db/schema';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const scrapeUrlMock = vi.fn();
const generateMarkdownMock = vi.fn();
const publishToPlatformsMock = vi.fn();
const resolveTargetPlatformsMock = vi.fn();
const getPreferredPlatformsMock = vi.fn();
const randomSleepMock = vi.fn();
const loggerErrorMock = vi.fn();

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

vi.mock('../../admin/platforms', () => ({
  resolveTargetPlatforms: (...args: unknown[]) => resolveTargetPlatformsMock(...args),
}));

vi.mock('../../brand-profile', () => ({
  getPreferredPlatforms: (...args: unknown[]) => getPreferredPlatformsMock(...args),
  getProfile: vi.fn(),
}));

vi.mock('../../../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: (...args: unknown[]) => loggerErrorMock(...args),
    success: vi.fn(),
  },
  randomSleep: (...args: unknown[]) => randomSleepMock(...args),
}));

// SUT
import {
  processBulkQueue,
  parseCsvUrls,
  startBulkPublishFromFile,
} from '../bulk-queue';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  applyV2Schema(db);
  return db;
}

const tmpFiles: string[] = [];
function writeTempCsv(content: string): string {
  const p = path.join(os.tmpdir(), `bulk-csv-${Date.now()}-${Math.random()}.csv`);
  fs.writeFileSync(p, content);
  tmpFiles.push(p);
  return p;
}

beforeEach(() => {
  scrapeUrlMock.mockReset();
  generateMarkdownMock.mockReset();
  publishToPlatformsMock.mockReset().mockResolvedValue({ targetPlatforms: [], results: [] });
  resolveTargetPlatformsMock.mockReset();
  getPreferredPlatformsMock.mockReset().mockReturnValue([]);
  randomSleepMock.mockReset().mockResolvedValue(undefined);
  loggerErrorMock.mockReset();
});

afterEach(() => {
  for (const f of tmpFiles) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* already cleaned */
    }
  }
  tmpFiles.length = 0;
});

// ---------------------------------------------------------------------------
// processBulkQueue — characterization
// ---------------------------------------------------------------------------

describe('processBulkQueue', () => {
  it('processes every URL even when one of them throws (cross-step isolation)', async () => {
    scrapeUrlMock
      .mockResolvedValueOnce({ title: 's1', content: 'c1', originalUrl: 'u1' })
      .mockRejectedValueOnce(new Error('scrape boom'))
      .mockResolvedValueOnce({ title: 's3', content: 'c3', originalUrl: 'u3' });
    generateMarkdownMock
      .mockResolvedValueOnce({ title: 'g1', content: 'b1', tags: [], excerpt: '' })
      .mockResolvedValueOnce({ title: 'g3', content: 'b3', tags: [], excerpt: '' });

    await processBulkQueue(['u1', 'u2', 'u3'], ['Dev.to'], 'draft');

    // Scrape called for all 3 URLs.
    expect(scrapeUrlMock).toHaveBeenCalledTimes(3);
    // Generate called only for the 2 that scraped successfully.
    expect(generateMarkdownMock).toHaveBeenCalledTimes(2);
    // Publish only for the 2 that generated successfully.
    expect(publishToPlatformsMock).toHaveBeenCalledTimes(2);
    // logger.error called once for the failed URL.
    expect(loggerErrorMock).toHaveBeenCalledOnce();
  });

  it('forwards platforms + publishStatus into publishToPlatforms verbatim', async () => {
    scrapeUrlMock.mockResolvedValue({ title: 's', content: 'c', originalUrl: 'u' });
    generateMarkdownMock.mockResolvedValue({
      title: 'gT',
      content: 'gC',
      tags: ['x'],
      excerpt: 'e',
    });

    await processBulkQueue(['u1'], ['Dev.to', 'Medium'], 'public');

    expect(publishToPlatformsMock).toHaveBeenCalledWith({
      sourceUrl: 'u1',
      title: 'gT',
      content: 'gC',
      tags: ['x'],
      excerpt: 'e',
      platforms: ['Dev.to', 'Medium'],
      publishStatus: 'public',
    });
  });

  it('does not sleep after the last URL', async () => {
    scrapeUrlMock.mockResolvedValue({ title: 's', content: 'c', originalUrl: 'u' });
    generateMarkdownMock.mockResolvedValue({
      title: 'g',
      content: 'b',
      tags: [],
      excerpt: '',
    });

    await processBulkQueue(['u1', 'u2'], ['Dev.to'], 'draft');

    // 2 URLs → exactly 1 inter-URL sleep.
    expect(randomSleepMock).toHaveBeenCalledTimes(1);
  });

  it('handles an empty URL list without errors and without sleeping', async () => {
    await processBulkQueue([], ['Dev.to'], 'draft');
    expect(scrapeUrlMock).not.toHaveBeenCalled();
    expect(randomSleepMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// parseCsvUrls
// ---------------------------------------------------------------------------

describe('parseCsvUrls', () => {
  it('extracts URLs from a header-less CSV', async () => {
    const file = writeTempCsv('https://a.com\nhttps://b.com\nhttps://c.com\n');
    const urls = await parseCsvUrls(file);
    expect(urls).toEqual(['https://a.com', 'https://b.com', 'https://c.com']);
  });

  it('skips lines that do not start with http', async () => {
    const file = writeTempCsv('https://ok.com\nnot-a-url\nftp://foo\n');
    const urls = await parseCsvUrls(file);
    expect(urls).toEqual(['https://ok.com']);
  });

  it('returns empty array for an empty file', async () => {
    const file = writeTempCsv('');
    const urls = await parseCsvUrls(file);
    expect(urls).toEqual([]);
  });

  it('rejects when file path does not exist', async () => {
    await expect(parseCsvUrls('/no/such/path.csv')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// startBulkPublishFromFile
// ---------------------------------------------------------------------------

describe('startBulkPublishFromFile', () => {
  it('returns 400 and removes file when no platforms can be resolved', async () => {
    const db = freshDb();
    resolveTargetPlatformsMock.mockReturnValue([]);
    getPreferredPlatformsMock.mockReturnValue([]);

    const file = writeTempCsv('https://a.com\n');
    const r = await startBulkPublishFromFile(db, file, { platforms: [] });

    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('returns 400 when CSV contains no valid URLs (and removes file)', async () => {
    const db = freshDb();
    resolveTargetPlatformsMock.mockReturnValue(['Dev.to']);

    const file = writeTempCsv('not-a-url\nstill-not-a-url\n');
    const r = await startBulkPublishFromFile(db, file, { platforms: ['Dev.to'] });

    expect(r).toMatchObject({ ok: false, status: 400 });
    if (!r.ok) expect(r.error).toMatch(/No valid URLs/);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('parses platforms when supplied as JSON string (multipart upload shape)', async () => {
    const db = freshDb();
    resolveTargetPlatformsMock.mockReturnValue(['Dev.to', 'Medium']);

    const file = writeTempCsv('https://a.com\n');
    const r = await startBulkPublishFromFile(db, file, {
      platforms: '["Dev.to","Medium"]' as unknown as string,
    });

    expect(r.ok).toBe(true);
    expect(resolveTargetPlatformsMock).toHaveBeenCalledWith(db, ['Dev.to', 'Medium']);
  });

  it('falls back to preferred platforms when client sends empty platforms', async () => {
    const db = freshDb();
    getPreferredPlatformsMock.mockReturnValue(['Hashnode']);
    resolveTargetPlatformsMock.mockReturnValue([]);

    const file = writeTempCsv('https://a.com\n');
    const r = await startBulkPublishFromFile(db, file, { platforms: [] });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.urlCount).toBe(1);
  });

  it('returns ok with urlCount and removes the temp CSV', async () => {
    const db = freshDb();
    resolveTargetPlatformsMock.mockReturnValue(['Dev.to']);

    const file = writeTempCsv('https://a.com\nhttps://b.com\n');
    const r = await startBulkPublishFromFile(db, file, { platforms: ['Dev.to'] });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.urlCount).toBe(2);
      expect(r.message).toMatch(/Bulk process started/);
    }
    expect(fs.existsSync(file)).toBe(false);
  });
});
