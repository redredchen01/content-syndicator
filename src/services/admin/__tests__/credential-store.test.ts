import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applyV2Schema } from '../../../db/schema';
import { encryptApiKey } from '../../../utils/encryption';

// ---------------------------------------------------------------------------
// Mocks — must be hoisted before importing the SUT
// ---------------------------------------------------------------------------

vi.mock('../../../adapters/index', () => {
  const adapters = [
    {
      name: 'Dev.to',
      isBrowserAutomation: false,
      testConnection: vi.fn(async () => ({ ok: true })),
    },
    {
      name: 'Medium',
      isBrowserAutomation: false,
      testConnection: vi.fn(async () => ({ ok: true })),
    },
    {
      name: 'Hashnode',
      isBrowserAutomation: false,
      testConnection: vi.fn(async () => ({ ok: true })),
    },
    {
      name: 'GitHub',
      isBrowserAutomation: false,
      testConnection: vi.fn(async () => ({ ok: true })),
    },
    {
      name: 'Twitter',
      isBrowserAutomation: false,
      testConnection: vi.fn(async () => ({ ok: true })),
    },
    {
      name: 'BrowserOnly',
      isBrowserAutomation: true,
    },
  ];
  return { allAdapters: adapters };
});

vi.mock('../../browser-session', () => ({
  // adapter.name → kebab-case id (matches real getAdapterId behavior for these names)
  getAdapterId: (a: { name: string }) =>
    a.name.toLowerCase().replace(/\./g, '').replace(/[^a-z0-9]/g, ''),
}));

vi.mock('../../../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// SUT — imported after mocks
import {
  ENV_KEY_MAP,
  testCredentialAgainstAdapter,
  updateApiKey,
  batchValidateApiKeys,
} from '../credential-store';
import { allAdapters } from '../../../adapters/index';
import { logger } from '../../../utils/logger';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  applyV2Schema(db);
  db.prepare(
    'INSERT INTO brand_profiles (brand_id, name, name_variants_json, target_urls_json, exposure_blocklist_json, anchor_blocklist_json) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('default', 'Test Brand', '[]', '[]', '[]', '[]');
  return db;
}

const PLAINTEXT_KEY = 'PLAIN_KEY_xyz_secret_VALUE';

function findAdapter(name: string) {
  return (allAdapters as any[]).find(a => a.name === name);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Reset mock testConnection to default (ok: true) so prior overrides don't leak
  for (const a of allAdapters as any[]) {
    if (a.testConnection) {
      a.testConnection.mockReset();
      a.testConnection.mockResolvedValue({ ok: true });
    }
  }
});

afterEach(() => {
  // Defense in depth: ensure no test leaks env mutation across cases
  delete process.env.DEVTO_API_KEY;
  delete process.env.MEDIUM_INTEGRATION_TOKEN;
  delete process.env.HASHNODE_TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.TWITTER_CONSUMER_KEY;
  delete process.env.TWITTER_CONSUMER_SECRET;
  delete process.env.TWITTER_ACCESS_TOKEN;
  delete process.env.TWITTER_ACCESS_TOKEN_SECRET;
});

// ---------------------------------------------------------------------------
// Happy + edge + error paths
// ---------------------------------------------------------------------------

describe('updateApiKey — happy path', () => {
  it('encrypts the key, persists to brand_profiles, and returns metadata', async () => {
    const db = freshDb();
    const result = await updateApiKey(db, 'devto', PLAINTEXT_KEY);

    expect(result).toMatchObject({
      ok: true,
      platform: 'Dev.to',
    });
    expect(typeof result.connected_at).toBe('string');
    expect(typeof result.test_timestamp).toBe('string');

    const row = db
      .prepare('SELECT api_keys_encrypted, platform_test_status FROM brand_profiles WHERE brand_id = ?')
      .get('default') as { api_keys_encrypted: string; platform_test_status: string };

    const apiKeys = JSON.parse(row.api_keys_encrypted);
    expect(apiKeys.devto).toBeDefined();
    expect(apiKeys.devto).not.toBe(PLAINTEXT_KEY); // encrypted, not plaintext

    const status = JSON.parse(row.platform_test_status);
    expect(status.devto.last_test_error).toBeNull();
    expect(typeof status.devto.connected_at).toBe('string');
  });
});

describe('batchValidateApiKeys — edge case: 5 keys, 2 fail', () => {
  it('reports per-platform success / failure', async () => {
    findAdapter('Dev.to').testConnection.mockResolvedValue({ ok: true });
    findAdapter('Medium').testConnection.mockResolvedValue({ ok: false, error: 'rate limited' });
    findAdapter('Hashnode').testConnection.mockResolvedValue({ ok: true });
    findAdapter('GitHub').testConnection.mockResolvedValue({ ok: false, error: 'bad token' });

    const credentials = [
      { platformId: 'devto', apiKey: 'k1' },
      { platformId: 'medium', apiKey: 'k2' },
      { platformId: 'hashnode', apiKey: 'k3' },
      { platformId: 'github', apiKey: 'k4' },
      // Browser-automation platform: should be filtered out
      { platformId: 'browseronly', apiKey: 'k5' },
    ];
    const results = await batchValidateApiKeys(credentials);

    expect(results).toHaveLength(5);
    expect(results.find(r => r.platformId === 'devto')).toMatchObject({ ok: true });
    expect(results.find(r => r.platformId === 'medium')).toMatchObject({ ok: false, error: 'rate limited' });
    expect(results.find(r => r.platformId === 'hashnode')).toMatchObject({ ok: true });
    expect(results.find(r => r.platformId === 'github')).toMatchObject({ ok: false, error: 'bad token' });
    expect(results.find(r => r.platformId === 'browseronly')).toMatchObject({
      ok: false,
      error: 'Platform not found or is browser automation',
    });
  });
});

describe('testCredentialAgainstAdapter — error path: unsupported platform', () => {
  it('returns Cannot validate this platform type when envKeyMap has no entry', async () => {
    // Construct a synthetic adapter whose id is not in ENV_KEY_MAP
    const fakeAdapter: any = {
      name: 'Unknown',
      isBrowserAutomation: false,
      testConnection: vi.fn(async () => ({ ok: true })),
    };
    expect((ENV_KEY_MAP as any).unknown).toBeUndefined();
    const result = await testCredentialAgainstAdapter(fakeAdapter, 'whatever');
    expect(result).toEqual({ ok: false, error: 'Cannot validate this platform type' });
    expect(fakeAdapter.testConnection).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Integration scenario — env restore order
// ---------------------------------------------------------------------------

describe('integration: env snapshot/restore preserves prior values', () => {
  it('after sequential devto + medium tests, both env vars return to their prior values', async () => {
    process.env.DEVTO_API_KEY = 'ORIGINAL_DEVTO';
    process.env.MEDIUM_INTEGRATION_TOKEN = 'ORIGINAL_MEDIUM';

    await testCredentialAgainstAdapter(findAdapter('Dev.to'), 'CANDIDATE_DEVTO', { keepOnSuccess: false });
    await testCredentialAgainstAdapter(findAdapter('Medium'), 'CANDIDATE_MEDIUM', { keepOnSuccess: false });

    expect(process.env.DEVTO_API_KEY).toBe('ORIGINAL_DEVTO');
    expect(process.env.MEDIUM_INTEGRATION_TOKEN).toBe('ORIGINAL_MEDIUM');
  });

  it('previously-unset env var is fully deleted (not left as empty string)', async () => {
    delete process.env.HASHNODE_TOKEN;
    await testCredentialAgainstAdapter(findAdapter('Hashnode'), 'CANDIDATE', { keepOnSuccess: false });
    expect('HASHNODE_TOKEN' in process.env).toBe(false);
  });

  it('keepOnSuccess=true leaves the candidate key in env after a successful test', async () => {
    process.env.DEVTO_API_KEY = 'ORIGINAL';
    findAdapter('Dev.to').testConnection.mockResolvedValue({ ok: true });

    const r = await testCredentialAgainstAdapter(findAdapter('Dev.to'), 'CANDIDATE', { keepOnSuccess: true });
    expect(r).toEqual({ ok: true });
    expect(process.env.DEVTO_API_KEY).toBe('CANDIDATE');
  });

  it('keepOnSuccess=true STILL restores env when adapter reports ok=false', async () => {
    process.env.DEVTO_API_KEY = 'ORIGINAL';
    findAdapter('Dev.to').testConnection.mockResolvedValue({ ok: false, error: 'bad' });

    const r = await testCredentialAgainstAdapter(findAdapter('Dev.to'), 'CANDIDATE', { keepOnSuccess: true });
    expect(r).toEqual({ ok: false, error: 'bad' });
    expect(process.env.DEVTO_API_KEY).toBe('ORIGINAL');
  });
});

// ---------------------------------------------------------------------------
// Security-negative assertions — Plan Unit 3 R9 secrets-leakage hardening
// ---------------------------------------------------------------------------

describe('security: plaintext key never leaks (negative assertions)', () => {
  it('A. updateApiKey response JSON does not contain the plaintext key', async () => {
    const db = freshDb();
    const result = await updateApiKey(db, 'devto', PLAINTEXT_KEY);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(PLAINTEXT_KEY);
  });

  it('B. logger.* is never called with an argument containing the plaintext key', async () => {
    const db = freshDb();
    await updateApiKey(db, 'devto', PLAINTEXT_KEY);

    const allLogArgs = [
      ...(logger.info as any).mock.calls,
      ...(logger.warn as any).mock.calls,
      ...(logger.error as any).mock.calls,
    ];
    for (const callArgs of allLogArgs) {
      const joined = callArgs.map((a: any) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      expect(joined).not.toContain(PLAINTEXT_KEY);
    }
  });

  it('C. brand_profiles.api_keys_encrypted column does not contain plaintext substring', async () => {
    const db = freshDb();
    await updateApiKey(db, 'devto', PLAINTEXT_KEY);
    const row = db.prepare('SELECT api_keys_encrypted FROM brand_profiles WHERE brand_id = ?').get('default') as
      { api_keys_encrypted: string };
    expect(row.api_keys_encrypted).not.toContain(PLAINTEXT_KEY);
  });

  it('D. testConnection throw still restores env (try/finally invariant)', async () => {
    process.env.DEVTO_API_KEY = 'ORIGINAL_AGAIN';
    findAdapter('Dev.to').testConnection.mockRejectedValue(new Error('boom'));

    const r = await testCredentialAgainstAdapter(findAdapter('Dev.to'), 'CANDIDATE_THROW', { keepOnSuccess: true });
    expect(r.ok).toBe(false);
    expect(process.env.DEVTO_API_KEY).toBe('ORIGINAL_AGAIN');
  });

  it('E. when testConnection throws with the plaintext key in the message, error is sanitized', async () => {
    findAdapter('Dev.to').testConnection.mockRejectedValue(
      new Error(`Bad request body: token=${PLAINTEXT_KEY}`),
    );

    const r = await testCredentialAgainstAdapter(findAdapter('Dev.to'), PLAINTEXT_KEY, { keepOnSuccess: false });
    expect(r.ok).toBe(false);
    expect(r.error).toBeDefined();
    expect(r.error).not.toContain(PLAINTEXT_KEY);
    expect(r.error).toContain('<redacted>');
  });

  it('F. when testConnection returns failure with plaintext in error, error is sanitized', async () => {
    findAdapter('Dev.to').testConnection.mockResolvedValue({
      ok: false,
      error: `Auth failed for key=${PLAINTEXT_KEY}`,
    });

    const r = await testCredentialAgainstAdapter(findAdapter('Dev.to'), PLAINTEXT_KEY, { keepOnSuccess: false });
    expect(r.ok).toBe(false);
    expect(r.error).not.toContain(PLAINTEXT_KEY);
  });
});

// ---------------------------------------------------------------------------
// Twitter-specific paths
// ---------------------------------------------------------------------------

describe('Twitter 4-key JSON path', () => {
  it('rejects malformed JSON without mutating env', async () => {
    process.env.TWITTER_CONSUMER_KEY = 'ORIG_CK';
    const r = await testCredentialAgainstAdapter(findAdapter('Twitter'), 'not-json{', { keepOnSuccess: false });
    expect(r).toMatchObject({ ok: false });
    expect(r.error).toMatch(/Twitter requires/);
    expect(process.env.TWITTER_CONSUMER_KEY).toBe('ORIG_CK');
    expect(findAdapter('Twitter').testConnection).not.toHaveBeenCalled();
  });

  it('parses 4-key payload and restores all 4 env vars on completion', async () => {
    delete process.env.TWITTER_CONSUMER_KEY;
    delete process.env.TWITTER_CONSUMER_SECRET;
    delete process.env.TWITTER_ACCESS_TOKEN;
    delete process.env.TWITTER_ACCESS_TOKEN_SECRET;

    const payload = JSON.stringify({ ck: 'CK', cs: 'CS', at: 'AT', as: 'AS' });
    findAdapter('Twitter').testConnection.mockResolvedValue({ ok: true });

    const r = await testCredentialAgainstAdapter(findAdapter('Twitter'), payload, { keepOnSuccess: false });
    expect(r).toEqual({ ok: true });
    expect('TWITTER_CONSUMER_KEY' in process.env).toBe(false);
    expect('TWITTER_CONSUMER_SECRET' in process.env).toBe(false);
    expect('TWITTER_ACCESS_TOKEN' in process.env).toBe(false);
    expect('TWITTER_ACCESS_TOKEN_SECRET' in process.env).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// updateApiKey — error mappings
// ---------------------------------------------------------------------------

describe('updateApiKey — input validation + status hints', () => {
  it('returns 400 when apiKey is empty', async () => {
    const db = freshDb();
    const r = await updateApiKey(db, 'devto', '');
    expect(r).toMatchObject({ ok: false, status: 400, error: 'API key is required' });
  });

  it('returns 404 when platform is unknown', async () => {
    const db = freshDb();
    const r = await updateApiKey(db, 'no-such-platform', 'KEY');
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it('returns 422 when adapter testConnection reports ok=false', async () => {
    findAdapter('Dev.to').testConnection.mockResolvedValue({ ok: false, error: 'Invalid token' });
    const db = freshDb();
    const r = await updateApiKey(db, 'devto', 'BAD_KEY');
    expect(r).toMatchObject({ ok: false, status: 422, error: 'Invalid token' });
  });

  it('returns 400 when twitter payload is malformed JSON', async () => {
    const db = freshDb();
    const r = await updateApiKey(db, 'twitter', 'not-json{');
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(r.error).toMatch(/Twitter requires/);
  });

  // Regression guard for ce:review correctness finding CORR-001:
  // old admin.ts:399 re-threw on testConnection throw → outer catch → 500.
  // Helper now caches threw:true so updateApiKey can map it to 500 (not 422).
  it('returns 500 when testConnection throws (preserves pre-refactor behavior)', async () => {
    findAdapter('Dev.to').testConnection.mockRejectedValue(new Error('Network unreachable'));
    const db = freshDb();
    const r = await updateApiKey(db, 'devto', 'KEY');
    expect(r).toMatchObject({ ok: false, status: 500 });
  });
});
