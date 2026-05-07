import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { applyV2Schema } from '../../../db/schema';
import type { Variant } from '../../../types';
import type { BrandProfile } from '../../../db/repositories';

// ---------------------------------------------------------------------------
// Mocks (hoisted before SUT import)
// ---------------------------------------------------------------------------

const fakeBrand: BrandProfile = {
  brand_id: 'main',
  name: 'Test Brand',
  name_variants: [],
  target_urls: [{ url: 'https://example.com', context_tag: 'home' }],
  exposure_blocklist: [],
  anchor_blocklist: [],
  signature: '',
  anchor_concentration_threshold: 0.3,
  weekly_url_cap: 5,
  jaccard_threshold: 0.6,
  digest_channel: 'none',
  digest_destination: '',
  updated_at: '',
};

const generateVariantsMock = vi.fn();
const generateSingleVariantMock = vi.fn();
const attachAnchorsMock = vi.fn();
const runLintMock = vi.fn();
const getProfileMock = vi.fn();
const filterByRoiMock = vi.fn();
const dispatchVariantJobsMock = vi.fn();

vi.mock('../../variant-generator', () => ({
  generateVariants: (...args: unknown[]) => generateVariantsMock(...args),
  generateSingleVariant: (...args: unknown[]) => generateSingleVariantMock(...args),
}));

vi.mock('../../anchor-generator', () => ({
  attachAnchors: (...args: unknown[]) => attachAnchorsMock(...args),
}));

vi.mock('../../lint', () => ({
  runLint: (...args: unknown[]) => runLintMock(...args),
}));

vi.mock('../../brand-profile', () => ({
  getProfile: (...args: unknown[]) => getProfileMock(...args),
}));

vi.mock('../../roi-scorer', () => ({
  filterByRoi: (...args: unknown[]) => filterByRoiMock(...args),
}));

vi.mock('../../queue/publish-worker', () => ({
  dispatchVariantJobs: (...args: unknown[]) => dispatchVariantJobsMock(...args),
}));

// SUT
import {
  runV2Generate,
  runV2Dispatch,
  runV2DispatchOverride,
  runRegenerateVariant,
} from '../v2-dispatch';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  applyV2Schema(db);
  return db;
}

function makeVariant(platform: string, body = 'A'.repeat(500), anchors = ['hello']): Variant {
  return {
    variant_id: `${platform}_v1`,
    platform,
    persona_group: 'tech_blogger',
    title: 'Test',
    body_markdown: body,
    anchor_words: anchors,
    target_url: 'https://example.com',
    generation_status: 'ok',
  };
}

beforeEach(() => {
  // mockReset (not clearAllMocks) — implementations set via mockImplementation
  // can capture per-test db references in closures, so reset between tests.
  generateVariantsMock.mockReset();
  generateSingleVariantMock.mockReset();
  attachAnchorsMock.mockReset();
  runLintMock.mockReset();
  getProfileMock.mockReset();
  filterByRoiMock.mockReset();
  dispatchVariantJobsMock.mockReset();
});

// ---------------------------------------------------------------------------
// runV2Generate
// ---------------------------------------------------------------------------

describe('runV2Generate', () => {
  it('returns batchId + variants + lintResult on happy path', async () => {
    getProfileMock.mockReturnValue(fakeBrand);
    const variants = [makeVariant('Dev.to'), makeVariant('Medium')];
    generateVariantsMock.mockResolvedValue({ batchId: 'batch_1', variants });
    attachAnchorsMock.mockResolvedValue(variants);
    runLintMock.mockReturnValue({ ok: true, violations: [] });

    const db = freshDb();
    const r = await runV2Generate(db, { draft: 'a'.repeat(700) });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.batchId).toBe('batch_1');
      expect(r.variants).toHaveLength(2);
      expect(r.lintResult).toEqual({ ok: true, violations: [] });
    }
    expect(generateVariantsMock).toHaveBeenCalledOnce();
    expect(attachAnchorsMock).toHaveBeenCalledOnce();
    expect(runLintMock).toHaveBeenCalledOnce();
  });

  it('returns 400 when draft is missing', async () => {
    const db = freshDb();
    const r = await runV2Generate(db, {});
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(generateVariantsMock).not.toHaveBeenCalled();
  });

  it('returns 400 when brand profile not configured', async () => {
    getProfileMock.mockReturnValue(null);
    const db = freshDb();
    const r = await runV2Generate(db, { draft: 'a'.repeat(700) });
    expect(r).toMatchObject({ ok: false, status: 400 });
    if (!r.ok) expect(r.error).toMatch(/Brand profile/i);
  });
});

// ---------------------------------------------------------------------------
// runV2Dispatch
// ---------------------------------------------------------------------------

describe('runV2Dispatch', () => {
  it('enqueues eligible variants and returns expected job count', () => {
    const db = freshDb();
    const variants = [makeVariant('Dev.to'), makeVariant('Medium')];

    filterByRoiMock.mockReturnValue({
      eligible: variants,
      skipped: [],
      roiScores: new Map([['Dev.to', 0.8], ['Medium', 0.7]]),
      engineStatus: 'ok',
    });

    // Simulate dispatchVariantJobs writing rows that publishJobs.byBatch picks up
    dispatchVariantJobsMock.mockImplementation((vs: Variant[], batchId: string) => {
      for (const v of vs) {
        db.prepare(
          'INSERT INTO publish_jobs (batch_id, variant_id, platform, job_type, payload_json, scheduled_at, metadata_json, priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(batchId, v.variant_id, v.platform, 'publish', '{}', new Date().toISOString(), '{}', 0);
      }
    });

    const r = runV2Dispatch(db, { batchId: 'batch_1', variants });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.jobsCreated).toBe(2);
      expect(r.batchId).toBe('batch_1');
      expect(r.variants).toHaveLength(2);
      expect(r.skipped).toEqual([]);
      expect(r.roiEngineStatus).toBe('ok');
    }
    expect(dispatchVariantJobsMock).toHaveBeenCalledOnce();
  });

  it('returns 400 when batchId or variants missing', () => {
    const db = freshDb();
    const r = runV2Dispatch(db, { batchId: 'b1' });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(dispatchVariantJobsMock).not.toHaveBeenCalled();
  });

  it('returns 422 invalid list when a variant has __naked_url__ anchor', () => {
    const db = freshDb();
    const bad = makeVariant('Dev.to', 'A'.repeat(500), ['__naked_url__']);
    const good = makeVariant('Medium');
    const r = runV2Dispatch(db, { batchId: 'b1', variants: [bad, good] });
    expect(r.ok).toBe(false);
    if (!r.ok && r.status === 422) {
      expect(r.invalid).toEqual([{ platform: 'Dev.to', reason: 'naked_url_fallback' }]);
    }
    expect(dispatchVariantJobsMock).not.toHaveBeenCalled();
  });

  it('returns 422 when body_markdown is shorter than 100 chars', () => {
    const db = freshDb();
    const bad = makeVariant('Dev.to', 'too short');
    const r = runV2Dispatch(db, { batchId: 'b1', variants: [bad] });
    expect(r.ok).toBe(false);
    if (!r.ok && r.status === 422) {
      expect(r.invalid).toEqual([{ platform: 'Dev.to', reason: 'body_too_short' }]);
    }
  });

  it('returns ok with zero jobs when all variants are ROI-skipped', () => {
    const db = freshDb();
    const variants = [makeVariant('Dev.to'), makeVariant('Medium')];

    filterByRoiMock.mockReturnValue({
      eligible: [],
      skipped: [
        { platform: 'Dev.to', score: 0.1, reason: 'low_roi' },
        { platform: 'Medium', score: 0.2, reason: 'low_roi' },
      ],
      roiScores: new Map(),
      engineStatus: 'ok',
    });

    const r = runV2Dispatch(db, { batchId: 'b1', variants });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.jobsCreated).toBe(0);
      expect(r.skipped).toHaveLength(2);
      expect(r.variants).toEqual([]);
    }
    expect(dispatchVariantJobsMock).toHaveBeenCalledWith([], 'b1', db, expect.any(Map));
  });
});

// ---------------------------------------------------------------------------
// runV2DispatchOverride
// ---------------------------------------------------------------------------

describe('runV2DispatchOverride', () => {
  it('enqueues only requested platforms with override score 0.5', () => {
    const db = freshDb();
    const variants = [makeVariant('Dev.to'), makeVariant('Medium'), makeVariant('Hashnode')];

    runV2DispatchOverride(db, {
      batchId: 'b1',
      platforms: ['Dev.to', 'Medium'],
      variants,
    });

    expect(dispatchVariantJobsMock).toHaveBeenCalledTimes(2);
    const firstCall = dispatchVariantJobsMock.mock.calls[0];
    const roiMap = firstCall[3] as Map<string, number>;
    expect(roiMap.get('Dev.to')).toBe(0.5);
  });

  it('returns added array of platforms it actually dispatched', () => {
    const db = freshDb();
    const variants = [makeVariant('Dev.to')];
    const r = runV2DispatchOverride(db, {
      batchId: 'b1',
      platforms: ['Dev.to', 'Missing'],
      variants,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.added).toEqual(['Dev.to']);
  });

  it('returns 400 when platforms[] missing or empty', () => {
    const db = freshDb();
    const r = runV2DispatchOverride(db, { batchId: 'b1', platforms: [], variants: [] });
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it('returns 400 when variants[] missing', () => {
    const db = freshDb();
    const r = runV2DispatchOverride(db, { batchId: 'b1', platforms: ['Dev.to'] });
    expect(r).toMatchObject({ ok: false, status: 400 });
  });
});

// ---------------------------------------------------------------------------
// runRegenerateVariant
// ---------------------------------------------------------------------------

describe('runRegenerateVariant', () => {
  it('regenerates one platform and merges with siblings before lint', async () => {
    getProfileMock.mockReturnValue(fakeBrand);
    const newVariant = makeVariant('Dev.to', 'B'.repeat(500));
    generateSingleVariantMock.mockResolvedValue(newVariant);
    attachAnchorsMock.mockImplementation(async (vs: Variant[]) => vs);
    runLintMock.mockReturnValue({ ok: true, violations: [] });

    const sibling = makeVariant('Medium');
    const staleSelf = makeVariant('Dev.to', 'STALE'.repeat(50));

    const db = freshDb();
    const r = await runRegenerateVariant(db, {
      batchId: 'b1',
      platform: 'Dev.to',
      draft: 'draft body',
      siblings: [sibling, staleSelf],
    });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.variant).toBe(newVariant);

    const lintArgs = runLintMock.mock.calls[0][0] as Variant[];
    expect(lintArgs).toHaveLength(2); // sibling + new (stale Dev.to dropped)
    expect(lintArgs.find(v => v.platform === 'Dev.to')).toBe(newVariant);
    expect(lintArgs.find(v => v.platform === 'Medium')).toBe(sibling);
  });

  it('returns 400 when batchId/platform/draft missing', async () => {
    const db = freshDb();
    const r = await runRegenerateVariant(db, { batchId: 'b1', platform: 'Dev.to' });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(generateSingleVariantMock).not.toHaveBeenCalled();
  });

  it('returns 400 when brand profile not configured', async () => {
    getProfileMock.mockReturnValue(null);
    const db = freshDb();
    const r = await runRegenerateVariant(db, {
      batchId: 'b1',
      platform: 'Dev.to',
      draft: 'd',
    });
    expect(r).toMatchObject({ ok: false, status: 400 });
  });
});
