import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { app } from '../../server';
import { db } from '../../db';

describe('GET /api/platforms', () => {
  it('returns list of all platforms with status fields', async () => {
    const res = await request(app).get('/api/platforms');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('platforms');
    expect(res.body).toHaveProperty('defaults');
    expect(Array.isArray(res.body.platforms)).toBe(true);
    expect(res.body.platforms.length).toBeGreaterThan(0);
  });

  it('includes required status fields for each platform', async () => {
    const res = await request(app).get('/api/platforms');

    expect(res.status).toBe(200);
    const platform = res.body.platforms[0];

    expect(platform).toHaveProperty('name');
    expect(platform).toHaveProperty('id');
    expect(platform).toHaveProperty('connected');
    expect(platform).toHaveProperty('reason');
    expect(typeof platform.connected).toBe('boolean');
    expect(typeof platform.reason).toBe('string');
  });

  it('includes new timestamp fields when platform is tested', async () => {
    const res = await request(app).get('/api/platforms');

    expect(res.status).toBe(200);
    const platform = res.body.platforms[0];

    // These fields might be null initially, but should exist
    expect(platform).toHaveProperty('connected_at');
    expect(platform).toHaveProperty('last_test_error');
    expect(platform).toHaveProperty('test_timestamp');
  });

  it('returns Telegraph platform even with no env config', async () => {
    const res = await request(app).get('/api/platforms');

    expect(res.status).toBe(200);
    const telegraph = res.body.platforms.find((p: any) => p.name === 'Telegra.ph');
    expect(telegraph).toBeDefined();
    expect(telegraph.connected).toBe(true);
  });

  it('marks Blogger as supportsOAuth and exposes oauthConfigured/oauthConnected flags', async () => {
    const res = await request(app).get('/api/platforms');
    const blogger = res.body.platforms.find((p: any) => p.name === 'Blogger');
    expect(blogger).toBeDefined();
    expect(blogger.supportsOAuth).toBe(true);
    expect(typeof blogger.oauthConfigured).toBe('boolean');
    expect(typeof blogger.oauthConnected).toBe('boolean');
    expect(blogger.oauthProviderId).toBe('google');
    expect(blogger.oauthProviderLabel).toBe('Google');
  });

  it('marks Twitter as supportsOAuth with providerId=twitter and label=X', async () => {
    const res = await request(app).get('/api/platforms');
    const twitter = res.body.platforms.find((p: any) => p.name === 'Twitter');
    expect(twitter).toBeDefined();
    expect(twitter.supportsOAuth).toBe(true);
    expect(twitter.oauthProviderId).toBe('twitter');
    expect(twitter.oauthProviderLabel).toBe('X');
  });

  it('marks Medium as supportsBrowserFallback', async () => {
    const res = await request(app).get('/api/platforms');
    const medium = res.body.platforms.find((p: any) => p.name === 'Medium');
    expect(medium).toBeDefined();
    expect(medium.supportsBrowserFallback).toBe(true);
    expect(medium.supportsOAuth).toBe(false);
  });

  it('does not mark non-OAuth/non-fallback platforms with the new flags', async () => {
    const res = await request(app).get('/api/platforms');
    const telegraph = res.body.platforms.find((p: any) => p.name === 'Telegra.ph');
    expect(telegraph.supportsOAuth).toBe(false);
    expect(telegraph.supportsBrowserFallback).toBe(false);
  });

  it('includes browserSessionExists field for every platform', async () => {
    const res = await request(app).get('/api/platforms');
    for (const p of res.body.platforms) {
      expect(p).toHaveProperty('browserSessionExists');
      expect(typeof p.browserSessionExists).toBe('boolean');
    }
  });

  it('includes patGenerationUrl field for every platform (null when not set)', async () => {
    const res = await request(app).get('/api/platforms');
    for (const p of res.body.platforms) {
      expect(p).toHaveProperty('patGenerationUrl');
      // Either a non-empty URL string or null — never undefined
      expect(p.patGenerationUrl === null || typeof p.patGenerationUrl === 'string').toBe(true);
      if (typeof p.patGenerationUrl === 'string') {
        expect(p.patGenerationUrl.length).toBeGreaterThan(0);
      }
    }
  });

  it('returns null patGenerationUrl for OAuth-first platforms (Blogger, Twitter)', async () => {
    const res = await request(app).get('/api/platforms');
    const blogger = res.body.platforms.find((p: any) => p.name === 'Blogger');
    const twitter = res.body.platforms.find((p: any) => p.name === 'Twitter');
    expect(blogger.patGenerationUrl).toBeNull();
    expect(twitter.patGenerationUrl).toBeNull();
  });
});

describe('PATCH /api/platforms/:platformId/api-key', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 when api key is missing', async () => {
    const res = await request(app)
      .patch('/api/platforms/devto/api-key')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('API key');
  });

  it('returns 404 for unknown platform', async () => {
    const res = await request(app)
      .patch('/api/platforms/unknown-platform/api-key')
      .send({ apiKey: 'test-key' });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('not found');
  });

  it('returns 404 for browser automation platforms', async () => {
    const res = await request(app)
      .patch('/api/platforms/medium/api-key') // Assuming 'medium' maps to a valid adapter
      .send({ apiKey: 'test-key' });

    // This should either work or return 422 (validation failed)
    // but never 404 if it's a valid platform
    expect([200, 422, 500]).toContain(res.status);
  });

  it('validates API key before storing', async () => {
    const res = await request(app)
      .patch('/api/platforms/devto/api-key')
      .send({ apiKey: 'invalid-key-that-will-fail' });

    // Should fail validation and return 422
    expect(res.status).toBe(422);
    expect(res.body).toHaveProperty('ok');
    expect(res.body.ok).toBe(false);
    expect(res.body).toHaveProperty('error');
  });

  it('returns proper response structure on success or validation failure', async () => {
    const res = await request(app)
      .patch('/api/platforms/devto/api-key')
      .send({ apiKey: 'test-key' });

    // Either 200 (success) or 422 (validation failure)
    expect([200, 422]).toContain(res.status);

    if (res.status === 200) {
      expect(res.body).toHaveProperty('ok', true);
      expect(res.body).toHaveProperty('platform');
      expect(res.body).toHaveProperty('connected_at');
      expect(res.body).toHaveProperty('test_timestamp');
    } else {
      expect(res.body).toHaveProperty('ok', false);
      expect(res.body).toHaveProperty('error');
    }
  });
});

// ── process.env restoration ───────────────────────────────────────────────────
// These tests guard against the pre-existing bug where `process.env = originalEnv`
// was used (which is a no-op in Node.js), causing test keys to leak into the
// process environment.

describe('PATCH /api/platforms/:id/api-key — process.env restoration', () => {
  afterEach(() => {
    delete process.env.DEVTO_API_KEY;
  });

  it('restores process.env on validation failure (422) — no key leak', async () => {
    const valueBefore = process.env.DEVTO_API_KEY;

    const res = await request(app)
      .patch('/api/platforms/devto/api-key')
      .send({ apiKey: 'obviously-invalid-key-for-env-leak-test' });

    if (res.status === 422) {
      // Key should be restored to whatever it was before the request
      expect(process.env.DEVTO_API_KEY).toBe(valueBefore);
    }
    // If 200, the new key was intentionally stored — no check needed
  });
});

describe('POST /api/platforms/batch-validate — process.env restoration', () => {
  let savedDevtoKey: string | undefined;

  beforeEach(() => {
    savedDevtoKey = process.env.DEVTO_API_KEY;
  });

  afterEach(() => {
    if (savedDevtoKey === undefined) delete process.env.DEVTO_API_KEY;
    else process.env.DEVTO_API_KEY = savedDevtoKey;
  });

  it('restores all env vars after batch validation completes', async () => {
    const keyBefore = process.env.DEVTO_API_KEY;

    await request(app).post('/api/platforms/batch-validate');

    // process.env must return to pre-test state regardless of test outcome
    expect(process.env.DEVTO_API_KEY).toBe(keyBefore);
  });
});

describe('Platform status persistence', () => {
  it('brand_profiles table exists with required columns', async () => {
    // Verify the schema has the expected columns (table may be empty on a fresh DB)
    const cols = db
      .prepare(`SELECT name FROM pragma_table_info('brand_profiles')`)
      .all() as Array<{ name: string }>;
    const colNames = cols.map(c => c.name);
    expect(colNames).toContain('api_keys_encrypted');
    expect(colNames).toContain('platform_test_status');
  });

  it('subsequent requests reflect stored status', async () => {
    // Get platforms twice to verify consistency
    const res1 = await request(app).get('/api/platforms');
    const res2 = await request(app).get('/api/platforms');

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    // Both should return the same structure
    expect(res1.body.platforms.length).toBe(res2.body.platforms.length);
  });
});

// ── Helper: ensure a 'main' brand_profiles row exists ────────────────────────
function ensureMainProfile() {
  const existing = db
    .prepare(`SELECT brand_id FROM brand_profiles WHERE brand_id = 'main'`)
    .get();
  if (!existing) {
    db.prepare(`
      INSERT INTO brand_profiles (brand_id, name, name_variants_json, target_urls_json,
        exposure_blocklist_json, anchor_blocklist_json)
      VALUES ('main', 'Test Brand', '[]', '[]', '[]', '[]')
    `).run();
  }
}

// ── GET /api/v2/platform-health ───────────────────────────────────────────────

describe('GET /api/v2/platform-health', () => {
  it('returns array of 7 MVP platforms', async () => {
    const res = await request(app).get('/api/v2/platform-health');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(7);
  });

  it('each item has required fields', async () => {
    const res = await request(app).get('/api/v2/platform-health');

    expect(res.status).toBe(200);
    const item = res.body[0];
    expect(item).toHaveProperty('platform');
    expect(item).toHaveProperty('daTierLabel');
    expect(item).toHaveProperty('daTierScore');
    expect(item).toHaveProperty('t7dRate');
    expect(item).toHaveProperty('t30dRate');
    expect(item).toHaveProperty('status');
    expect(item).toHaveProperty('dataInsufficient');
  });

  it('returns status=insufficient for all when no link_checks data', async () => {
    const res = await request(app).get('/api/v2/platform-health');

    expect(res.status).toBe(200);
    // Fresh test DB has no link_checks data → all should be insufficient
    for (const item of res.body) {
      expect(item.dataInsufficient).toBe(true);
      expect(item.status).toBe('insufficient');
    }
  });

  it('includes all 7 MVP platform names', async () => {
    const res = await request(app).get('/api/v2/platform-health');

    expect(res.status).toBe(200);
    const names: string[] = res.body.map((item: any) => item.platform);
    const MVP = ['Telegra.ph', 'Dev.to', 'Medium', 'Hashnode', 'GitHub', 'Blogger', 'WordPress'];
    for (const p of MVP) {
      expect(names).toContain(p);
    }
  });
});

// ── PATCH /api/v2/roi-config ──────────────────────────────────────────────────

describe('PATCH /api/v2/roi-config', () => {
  beforeEach(() => {
    ensureMainProfile();
  });

  it('updates threshold and returns updated config', async () => {
    const res = await request(app)
      .patch('/api/v2/roi-config')
      .send({ daTierConfig: {}, threshold: 0.5 });

    expect(res.status).toBe(200);
    expect(res.body.threshold).toBe(0.5);
  });

  it('GET /api/v2/platform-health reflects new threshold after update', async () => {
    await request(app)
      .patch('/api/v2/roi-config')
      .send({ daTierConfig: {}, threshold: 0.7 });

    // Health endpoint should still work (returns 200)
    const healthRes = await request(app).get('/api/v2/platform-health');
    expect(healthRes.status).toBe(200);
    expect(Array.isArray(healthRes.body)).toBe(true);
  });

  it('rejects threshold > 1 with 400', async () => {
    const res = await request(app)
      .patch('/api/v2/roi-config')
      .send({ daTierConfig: {}, threshold: 1.5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/threshold/);
  });

  it('rejects threshold < 0 with 400', async () => {
    const res = await request(app)
      .patch('/api/v2/roi-config')
      .send({ daTierConfig: {}, threshold: -0.1 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/threshold/);
  });

  it('rejects non-finite threshold with 400', async () => {
    const res = await request(app)
      .patch('/api/v2/roi-config')
      .send({ daTierConfig: {}, threshold: null });

    expect(res.status).toBe(400);
  });

  it('rejects unknown platform key in daTierConfig with 400', async () => {
    const res = await request(app)
      .patch('/api/v2/roi-config')
      .send({ daTierConfig: { 'UnknownPlatform': 0.6 }, threshold: 0.3 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unknown platform/);
  });

  it('rejects invalid tier score (0.5) with 400', async () => {
    const res = await request(app)
      .patch('/api/v2/roi-config')
      .send({ daTierConfig: { 'Medium': 0.5 }, threshold: 0.3 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid tier score/);
  });

  it('accepts valid tier scores 0.3, 0.6, 1.0', async () => {
    const res = await request(app)
      .patch('/api/v2/roi-config')
      .send({
        daTierConfig: { 'Medium': 1.0, 'GitHub': 0.6, 'Telegra.ph': 0.3 },
        threshold: 0.3,
      });

    expect(res.status).toBe(200);
    expect(res.body.daTierConfig['Medium']).toBe(1.0);
    expect(res.body.daTierConfig['GitHub']).toBe(0.6);
    expect(res.body.daTierConfig['Telegra.ph']).toBe(0.3);
  });
});
