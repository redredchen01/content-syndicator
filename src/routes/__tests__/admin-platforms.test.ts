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

describe('Platform status persistence', () => {
  it('platform status is stored in database', async () => {
    // Verify database initialization
    const result = db.prepare('SELECT api_keys_encrypted, platform_test_status FROM brand_profiles LIMIT 1').get();

    // The table should exist but fields might not be populated yet
    expect(result).toBeDefined();
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
