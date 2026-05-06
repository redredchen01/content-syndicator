import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../../server';

// ── POST /api/v2/dispatch — server-side validation ───────────────────────────

const VALID_VARIANT = {
  platform: 'Dev.to',
  variant_id: 'batch_x_devto',
  persona_group: 'tech_blogger',
  title: 'Test Article',
  body_markdown: 'This is a test article body with enough content to pass the minimum length check. '.repeat(3),
  anchor_words: ['long-tail anchor', 'brand term'],
  target_url: 'https://example.com',
  generation_status: 'ok',
};

describe('POST /api/v2/dispatch — input validation', () => {
  it('returns 400 when batchId missing', async () => {
    const res = await request(app)
      .post('/api/v2/dispatch')
      .send({ variants: [VALID_VARIANT] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/batchId/);
  });

  it('returns 400 when variants not an array', async () => {
    const res = await request(app)
      .post('/api/v2/dispatch')
      .send({ batchId: 'batch_test', variants: 'not-an-array' });

    expect(res.status).toBe(400);
  });
});

describe('POST /api/v2/dispatch — naked_url_fallback rejection', () => {
  it('returns 422 when any variant has __naked_url__ anchor', async () => {
    const nakedVariant = { ...VALID_VARIANT, anchor_words: ['__naked_url__'] };

    const res = await request(app)
      .post('/api/v2/dispatch')
      .send({ batchId: 'batch_naked', variants: [nakedVariant] });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/not ready/i);
    expect(res.body.invalid).toHaveLength(1);
    expect(res.body.invalid[0].reason).toBe('naked_url_fallback');
    expect(res.body.invalid[0].platform).toBe('Dev.to');
  });

  it('returns 422 when body_markdown is too short', async () => {
    const shortBodyVariant = { ...VALID_VARIANT, body_markdown: 'Too short.' };

    const res = await request(app)
      .post('/api/v2/dispatch')
      .send({ batchId: 'batch_short', variants: [shortBodyVariant] });

    expect(res.status).toBe(422);
    expect(res.body.invalid[0].reason).toBe('body_too_short');
  });

  it('returns 422 listing all invalid platforms when multiple fail', async () => {
    const goodVariant = { ...VALID_VARIANT, platform: 'Hashnode', variant_id: 'batch_multi_hashnode' };
    const variants = [
      { ...VALID_VARIANT, platform: 'Dev.to',  variant_id: 'batch_multi_devto',  anchor_words: ['__naked_url__'] },
      { ...VALID_VARIANT, platform: 'Medium',  variant_id: 'batch_multi_medium', body_markdown: 'Short.' },
      goodVariant,
    ];

    const res = await request(app)
      .post('/api/v2/dispatch')
      .send({ batchId: 'batch_multi', variants });

    expect(res.status).toBe(422);
    const platforms = res.body.invalid.map((v: any) => v.platform);
    expect(platforms).toContain('Dev.to');
    expect(platforms).toContain('Medium');
    expect(platforms).not.toContain('Hashnode'); // only invalid ones listed
  });

  it('accepts dispatch when all variants are valid', async () => {
    const res = await request(app)
      .post('/api/v2/dispatch')
      .send({ batchId: 'batch_valid', variants: [VALID_VARIANT] });

    // 200 = enqueued; backend may also return other success codes
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('jobsCreated');
  });
});
