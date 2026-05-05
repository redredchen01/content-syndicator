import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { handleDailyDigestJob, seedDailyDigest } from '../digest-job';
import type { PublishJob } from '../../../db/repositories';
import { applyV2Schema } from '../../../db/schema';

vi.mock('../../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function makeDb() {
  const db = new Database(':memory:');
  applyV2Schema(db);
  return db;
}

function makeDigestJob(): PublishJob {
  return {
    id: 99,
    batch_id: 'system',
    variant_id: 'digest',
    platform: 'system',
    job_type: 'daily_digest',
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

describe('handleDailyDigestJob', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('skips when no brand profile configured', async () => {
    const db = makeDb();
    const { logger } = await import('../../../utils/logger');
    await handleDailyDigestJob(makeDigestJob(), db);
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(expect.stringContaining('digest_channel=none'));
    db.close();
  });

  it('skips digest when no activity today', async () => {
    const db = makeDb();
    // Insert a brand profile with telegram channel
    db.prepare(`INSERT INTO brand_profiles
      (brand_id, name, name_variants_json, target_urls_json, exposure_blocklist_json, anchor_blocklist_json,
       digest_channel, digest_destination)
      VALUES ('main', 'TestBrand', '[]', '[]', '[]', '[]', 'telegram', 'bot123:chatid')
    `).run();

    const { logger } = await import('../../../utils/logger');
    await handleDailyDigestJob(makeDigestJob(), db);
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(expect.stringContaining('No activity'));
    db.close();
  });

  it('digest_channel=none → skips even with brand profile', async () => {
    const db = makeDb();
    db.prepare(`INSERT INTO brand_profiles
      (brand_id, name, name_variants_json, target_urls_json, exposure_blocklist_json, anchor_blocklist_json,
       digest_channel)
      VALUES ('main', 'TestBrand', '[]', '[]', '[]', '[]', 'none')
    `).run();

    const { logger } = await import('../../../utils/logger');
    await handleDailyDigestJob(makeDigestJob(), db);
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(expect.stringContaining('none'));
    db.close();
  });
});

describe('seedDailyDigest', () => {
  it('inserts a daily_digest job for today if not present', () => {
    const db = makeDb();
    seedDailyDigest(db);
    const jobs = db.prepare("SELECT * FROM publish_jobs WHERE job_type = 'daily_digest'").all();
    expect(jobs).toHaveLength(1);
    db.close();
  });

  it('does not insert duplicate if already seeded today', () => {
    const db = makeDb();
    seedDailyDigest(db);
    seedDailyDigest(db); // second call
    const jobs = db.prepare("SELECT * FROM publish_jobs WHERE job_type = 'daily_digest'").all();
    expect(jobs).toHaveLength(1);
    db.close();
  });
});
