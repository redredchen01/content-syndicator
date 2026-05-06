import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../../server';

// ── Module mock — controls filterByRoi behaviour per-test ────────────────────
vi.mock('../../services/roi-scorer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/roi-scorer')>();
  return {
    ...actual,
    // Default: pass everything through (keeps pre-ROI tests green)
    filterByRoi: vi.fn((variants: import('../../types').Variant[]) => ({
      eligible: variants,
      skipped: [],
      roiScores: new Map(variants.map((v: import('../../types').Variant) => [v.platform, 1.0])),
      engineStatus: 'ok' as const,
    })),
  };
});

import { filterByRoi } from '../../services/roi-scorer';

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

// ── POST /api/v2/dispatch — ROI filtering ────────────────────────────────────

const VALID_MEDIUM = {
  platform: 'Medium',
  variant_id: 'batch_roi_medium',
  persona_group: 'personal_essay',
  title: 'ROI Test Article',
  body_markdown: 'This is a test article body with enough content to pass the minimum length check. '.repeat(3),
  anchor_words: ['brand term', 'useful tool'],
  target_url: 'https://example.com',
  generation_status: 'ok',
};

const VALID_TELEGRA = {
  ...VALID_MEDIUM,
  platform: 'Telegra.ph',
  variant_id: 'batch_roi_telegra',
};

describe('POST /api/v2/dispatch — ROI filtering', () => {
  beforeEach(() => {
    vi.mocked(filterByRoi).mockReset();
  });

  it('eligible platforms enter queue, skipped platforms omitted; response has skipped[] and roiEngineStatus', async () => {
    vi.mocked(filterByRoi).mockReturnValueOnce({
      eligible: [VALID_MEDIUM as import('../../types').Variant],
      skipped: [{ platform: 'Telegra.ph', score: 0.1, reason: 'low_roi' }],
      roiScores: new Map([['Medium', 0.9], ['Telegra.ph', 0.1]]),
      engineStatus: 'ok',
    });

    const res = await request(app)
      .post('/api/v2/dispatch')
      .send({ batchId: 'batch_roi_filter', variants: [VALID_MEDIUM, VALID_TELEGRA] });

    expect(res.status).toBe(200);
    expect(res.body.roiEngineStatus).toBe('ok');
    expect(res.body.skipped).toHaveLength(1);
    expect(res.body.skipped[0].platform).toBe('Telegra.ph');
    expect(res.body.variants.map((v: any) => v.platform)).toContain('Medium');
    expect(res.body.variants.map((v: any) => v.platform)).not.toContain('Telegra.ph');
  });

  it('all platforms pass when none below ROI threshold', async () => {
    vi.mocked(filterByRoi).mockReturnValueOnce({
      eligible: [VALID_MEDIUM, VALID_TELEGRA] as import('../../types').Variant[],
      skipped: [],
      roiScores: new Map([['Medium', 1.0], ['Telegra.ph', 0.8]]),
      engineStatus: 'ok',
    });

    const res = await request(app)
      .post('/api/v2/dispatch')
      .send({ batchId: 'batch_roi_all_pass', variants: [VALID_MEDIUM, VALID_TELEGRA] });

    expect(res.status).toBe(200);
    expect(res.body.skipped).toHaveLength(0);
    expect(res.body.roiEngineStatus).toBe('ok');
    expect(res.body.variants).toHaveLength(2);
  });

  it('response has roiEngineStatus=degraded when ROI scorer is degraded', async () => {
    vi.mocked(filterByRoi).mockReturnValueOnce({
      eligible: [VALID_MEDIUM] as import('../../types').Variant[],
      skipped: [],
      roiScores: new Map([['Medium', 1.0]]),
      engineStatus: 'degraded',
    });

    const res = await request(app)
      .post('/api/v2/dispatch')
      .send({ batchId: 'batch_roi_degraded', variants: [VALID_MEDIUM] });

    expect(res.status).toBe(200);
    expect(res.body.roiEngineStatus).toBe('degraded');
  });
});

// ── POST /api/v2/dispatch/override ──────────────────────────────────────────

describe('POST /api/v2/dispatch/override', () => {
  it('returns 400 when batchId missing', async () => {
    const res = await request(app)
      .post('/api/v2/dispatch/override')
      .send({ platforms: ['Telegra.ph'], variants: [VALID_TELEGRA] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/batchId/);
  });

  it('returns 400 when platforms[] missing or empty', async () => {
    const res = await request(app)
      .post('/api/v2/dispatch/override')
      .send({ batchId: 'batch_override_test', platforms: [], variants: [VALID_TELEGRA] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/platforms/);
  });

  it('returns 400 when variants[] missing', async () => {
    const res = await request(app)
      .post('/api/v2/dispatch/override')
      .send({ batchId: 'batch_override_test', platforms: ['Telegra.ph'], variants: [] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/variants/);
  });

  it('creates jobs for specified platforms and returns added[]', async () => {
    const res = await request(app)
      .post('/api/v2/dispatch/override')
      .send({
        batchId: 'batch_override_ok',
        platforms: ['Telegra.ph'],
        variants: [VALID_TELEGRA],
      });

    expect(res.status).toBe(200);
    expect(res.body.added).toContain('Telegra.ph');
  });

  it('skips platforms that have no matching variant in request body', async () => {
    const res = await request(app)
      .post('/api/v2/dispatch/override')
      .send({
        batchId: 'batch_override_nomatch',
        platforms: ['GitHub'],         // no matching variant
        variants: [VALID_TELEGRA],     // only Telegra.ph supplied
      });

    expect(res.status).toBe(200);
    expect(res.body.added).toHaveLength(0);
  });
});
