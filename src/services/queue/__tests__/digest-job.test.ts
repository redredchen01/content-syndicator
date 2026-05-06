import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { handleDailyDigestJob, seedDailyDigest } from '../digest-job';
import type { PublishJob } from '../../../db/repositories';
import { applyV2Schema } from '../../../db/schema';

vi.mock('../../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock googleapis so tests don't make real HTTP calls
vi.mock('googleapis', () => ({
  google: {
    auth: {
      JWT: vi.fn().mockImplementation(() => ({})),
    },
    gmail: vi.fn().mockReturnValue({
      users: {
        messages: {
          send: vi.fn().mockResolvedValue({ data: { id: 'msg_123' } }),
        },
      },
    }),
  },
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

// ── Email digest tests ───────────────────────────────────────────────────────

describe('handleDailyDigestJob — email channel', () => {
  const origCredsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  const origSender   = process.env.DIGEST_SENDER_EMAIL;

  afterEach(() => {
    vi.clearAllMocks();
    if (origCredsJson === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    else process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = origCredsJson;
    if (origSender === undefined) delete process.env.DIGEST_SENDER_EMAIL;
    else process.env.DIGEST_SENDER_EMAIL = origSender;
  });

  function makeEmailProfile(db: Database.Database) {
    db.prepare(`INSERT INTO brand_profiles
      (brand_id, name, name_variants_json, target_urls_json, exposure_blocklist_json, anchor_blocklist_json,
       digest_channel, digest_destination)
      VALUES ('main', 'TestBrand', '[]', '[]', '[]', '[]', 'email', 'ops@example.com')
    `).run();
    // Insert a succeeded job today so there IS activity
    db.prepare(`INSERT INTO publish_jobs
      (batch_id, variant_id, platform, job_type, payload_json, scheduled_at, status, metadata_json)
      VALUES ('b1', 'v1', 'Dev.to', 'publish', '{}', datetime('now'), 'succeeded', '{}')
    `).run();
  }

  it('warns and skips when GOOGLE_APPLICATION_CREDENTIALS_JSON missing', async () => {
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    delete process.env.DIGEST_SENDER_EMAIL;
    const db = makeDb();
    makeEmailProfile(db);

    const { logger } = await import('../../../utils/logger');
    await handleDailyDigestJob(makeDigestJob(), db);

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining('GOOGLE_APPLICATION_CREDENTIALS_JSON'),
    );
    db.close();
  });

  it('warns and skips when DIGEST_SENDER_EMAIL not set', async () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = JSON.stringify({
      client_email: 'sa@proj.iam.gserviceaccount.com',
      private_key: 'FAKE_KEY',
    });
    delete process.env.DIGEST_SENDER_EMAIL;
    const db = makeDb();
    makeEmailProfile(db);

    const { logger } = await import('../../../utils/logger');
    await handleDailyDigestJob(makeDigestJob(), db);

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining('DIGEST_SENDER_EMAIL'),
    );
    db.close();
  });

  it('calls gmail.users.messages.send when credentials are present', async () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = JSON.stringify({
      client_email: 'sa@proj.iam.gserviceaccount.com',
      private_key: 'FAKE_KEY',
    });
    process.env.DIGEST_SENDER_EMAIL = 'sender@example.com';
    const db = makeDb();
    makeEmailProfile(db);

    const { google } = await import('googleapis');
    const mockSend = vi.mocked(google.gmail({} as any).users.messages.send);

    await handleDailyDigestJob(makeDigestJob(), db);

    expect(mockSend).toHaveBeenCalledOnce();
    const call = mockSend.mock.calls[0][0];
    expect(call.userId).toBe('sender@example.com');
    expect(call.requestBody?.raw).toBeDefined();
    db.close();
  });

  it('logs warn (not throw) when Gmail API call fails', async () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = JSON.stringify({
      client_email: 'sa@proj.iam.gserviceaccount.com',
      private_key: 'FAKE_KEY',
    });
    process.env.DIGEST_SENDER_EMAIL = 'sender@example.com';
    const db = makeDb();
    makeEmailProfile(db);

    const { google } = await import('googleapis');
    vi.mocked(google.gmail({} as any).users.messages.send).mockRejectedValueOnce(
      Object.assign(new Error('unauthorized_client'), { status: 403 }),
    );

    const { logger } = await import('../../../utils/logger');
    // Should not throw
    await expect(handleDailyDigestJob(makeDigestJob(), db)).resolves.toBeUndefined();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(expect.stringContaining('Email send failed'));
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(expect.stringContaining('domain-wide delegation'));
    db.close();
  });
});

// ── Existing tests ───────────────────────────────────────────────────────────

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

describe('Telegram token parsing — full-token format', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 }),
    );
  });
  afterEach(() => fetchSpy.mockRestore());

  function makeDbWithActivity(digest_destination: string) {
    const db = makeDb();
    db.prepare(`INSERT INTO brand_profiles
      (brand_id, name, name_variants_json, target_urls_json, exposure_blocklist_json,
       anchor_blocklist_json, digest_channel, digest_destination)
      VALUES ('main','T','[]','[]','[]','[]','telegram', ?)
    `).run(digest_destination);
    // Add one succeeded publish job today so digest has activity to report
    db.prepare(`INSERT INTO publish_jobs
      (batch_id, variant_id, platform, job_type, payload_json, scheduled_at, status, attempts, metadata_json)
      VALUES ('b1','v1','github','publish','{}',datetime('now'),'succeeded',1,'{}')
    `).run();
    return db;
  }

  it('legacy format bot<id>:<chatId> — sends with correct botToken and chatId', async () => {
    const db = makeDbWithActivity('bot123:chatid456');
    await handleDailyDigestJob(makeDigestJob(), db);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const url = fetchSpy.mock.calls[0][0] as string;
    // botToken = '123' (just numeric id, legacy)
    expect(url).toContain('bot123/sendMessage');
    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.chat_id).toBe('chatid456');
    db.close();
  });

  it('full-token format bot<id>:<hash>:<chatId> — sends with complete botToken', async () => {
    const db = makeDbWithActivity('bot1234567890:AABBCCDDEEFF:987654321');
    await handleDailyDigestJob(makeDigestJob(), db);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const url = fetchSpy.mock.calls[0][0] as string;
    // botToken = '1234567890:AABBCCDDEEFF' (full token including hash)
    expect(url).toContain('bot1234567890:AABBCCDDEEFF/sendMessage');
    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.chat_id).toBe('987654321');
    db.close();
  });

  it('invalid token (no colon) — warns and does not call fetch', async () => {
    const db = makeDbWithActivity('invalid_no_colon');
    const { logger } = await import('../../../utils/logger');
    await handleDailyDigestJob(makeDigestJob(), db);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining('Invalid Telegram token format'),
    );
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
