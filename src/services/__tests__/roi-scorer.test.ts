import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyV2Schema } from '../../db/schema';
import { linkChecks } from '../../db/repositories';
import {
  getDaTierConfig,
  computeRoiScore,
  filterByRoi,
  computePlatformHealth,
  DEFAULT_ROI_THRESHOLD,
} from '../roi-scorer';
import type { Variant } from '../../types/index';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  applyV2Schema(db);
  return db;
}

/** Insert N link_check records for a given platform + check_type, all 'alive'. */
function insertChecks(
  db: Database.Database,
  platform: string,
  checkType: 't7d' | 't30d',
  count: number,
  classification: 'alive' | '404' = 'alive',
) {
  for (let i = 0; i < count; i++) {
    linkChecks.insert(db, {
      batch_id: `${platform}-${checkType}-${i}`,
      variant_id: 'v',
      platform,
      published_url: `https://example.com/${platform}/${i}`,
      check_type: checkType,
      http_status: classification === 'alive' ? 200 : 404,
      classification,
    });
  }
}

function makeVariant(platform: string): Variant {
  return {
    variant_id: `v-${platform}`,
    platform,
    persona_group: 'tech_blogger',
    title: `Test post for ${platform}`,
    body_markdown: 'A'.repeat(200),
    anchor_words: ['test'],
    target_url: 'https://example.com',
    generation_status: 'ok',
  };
}

const SINCE = '2020-01-01T00:00:00Z';

describe('getDaTierConfig', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => db.close());

  it('returns defaults when no brand profile row exists', () => {
    const config = getDaTierConfig(db);
    expect(config.threshold).toBe(DEFAULT_ROI_THRESHOLD);
    expect(config.tiers['Medium']).toBe(1.0);
    expect(config.tiers['Telegra.ph']).toBe(0.3);
  });

  it('merges admin overrides with defaults', () => {
    db.prepare(`INSERT INTO brand_profiles (brand_id, name) VALUES ('main', 'Brand')`).run();
    db.prepare(`UPDATE brand_profiles SET da_tier_config_json = '{"Telegra.ph": 0.6}', roi_threshold = 0.4 WHERE brand_id = 'main'`).run();

    const config = getDaTierConfig(db);
    expect(config.tiers['Telegra.ph']).toBe(0.6); // overridden
    expect(config.tiers['Medium']).toBe(1.0);       // unchanged default
    expect(config.threshold).toBe(0.4);
  });
});

describe('computeRoiScore', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => db.close());

  const defaultConfig = { tiers: { 'Medium': 1.0, 'Telegra.ph': 0.3 }, threshold: 0.3 };

  it('full cold start — both check_types < 5 records — score = DA × 1.0', () => {
    insertChecks(db, 'Medium', 't7d', 3); // < 5
    insertChecks(db, 'Medium', 't30d', 2); // < 5

    const result = computeRoiScore(db, 'Medium', defaultConfig, SINCE);
    expect(result.coldStart).toBe(true);
    expect(result.dataInsufficient).toBe(true);
    expect(result.score).toBeCloseTo(1.0, 5); // DA × 1.0
    expect(result.t7dRate).toBeNull();
    expect(result.t30dRate).toBeNull();
  });

  it('partial cold start — t7d cold but t30d ≥ 5 — uses t30d only', () => {
    insertChecks(db, 'Medium', 't7d', 3);          // cold
    insertChecks(db, 'Medium', 't30d', 5, 'alive'); // warm, rate=1.0

    const result = computeRoiScore(db, 'Medium', defaultConfig, SINCE);
    expect(result.coldStart).toBe(false);
    expect(result.t7dRate).toBeNull();
    expect(result.t30dRate).toBeCloseTo(1.0, 5);
    // score = 1.0 × 0.6 + 1.0 × 0.4 = 1.0
    expect(result.score).toBeCloseTo(1.0, 5);
  });

  it('both check_types warm — blends DA + survival avg', () => {
    insertChecks(db, 'Medium', 't7d', 5, 'alive');  // rate = 1.0
    insertChecks(db, 'Medium', 't30d', 5, 'alive'); // rate = 1.0

    const result = computeRoiScore(db, 'Medium', defaultConfig, SINCE);
    expect(result.coldStart).toBe(false);
    // score = 1.0 × 0.6 + avg(1.0, 1.0) × 0.4 = 1.0
    expect(result.score).toBeCloseTo(1.0, 5);
  });

  it('Tier3 cold start scores exactly 0.3 (= threshold, not skipped with strict <)', () => {
    // No records — full cold start
    const result = computeRoiScore(db, 'Telegra.ph', defaultConfig, SINCE);
    expect(result.score).toBeCloseTo(0.3, 5);
    // score < 0.3 is false, so it should NOT be skipped
    expect(result.score < defaultConfig.threshold).toBe(false);
  });

  it('unknown platform falls back to DA tier 0.3', () => {
    const result = computeRoiScore(db, 'UnknownPlatform', defaultConfig, SINCE);
    expect(result.daTierScore).toBe(0.3);
    expect(result.score).toBeCloseTo(0.3, 5);
  });

  it('admin override changes DA tier score', () => {
    const config = { tiers: { 'Telegra.ph': 0.6 }, threshold: 0.3 };
    const result = computeRoiScore(db, 'Telegra.ph', config, SINCE);
    expect(result.daTierScore).toBe(0.6);
    expect(result.score).toBeCloseTo(0.6, 5); // cold start, DA × 1.0
  });
});

describe('filterByRoi', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    db.prepare(`INSERT INTO brand_profiles (brand_id, name) VALUES ('main', 'Brand')`).run();
  });
  afterEach(() => db.close());

  it('eligible platforms pass through, low-ROI platforms are skipped', () => {
    // Medium warm with high survival → eligible
    insertChecks(db, 'Medium', 't7d', 5, 'alive');
    insertChecks(db, 'Medium', 't30d', 5, 'alive');

    const variants = [
      makeVariant('Medium'),    // score ≈ 1.0 → eligible
      makeVariant('Telegra.ph'), // cold start, score = 0.3, threshold = 0.3 → eligible (not < threshold)
    ];

    const result = filterByRoi(variants, db);
    expect(result.engineStatus).toBe('ok');
    expect(result.eligible).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);
  });

  it('skips platform when score < threshold', () => {
    // Set threshold = 0.4 so Telegra.ph (score=0.3 cold) gets skipped
    db.prepare(`UPDATE brand_profiles SET roi_threshold = 0.4 WHERE brand_id = 'main'`).run();

    const variants = [
      makeVariant('Medium'),     // Tier1 cold start = 1.0 → eligible
      makeVariant('Telegra.ph'), // Tier3 cold start = 0.3 < 0.4 → skipped
    ];

    const result = filterByRoi(variants, db);
    expect(result.eligible.map(v => v.platform)).toContain('Medium');
    expect(result.skipped.map(s => s.platform)).toContain('Telegra.ph');
    expect(result.skipped[0].reason).toBe('low_roi');
  });

  it('all eligible when all pass threshold', () => {
    const variants = ['Medium', 'Dev.to', 'Hashnode'].map(makeVariant);
    const result = filterByRoi(variants, db);
    expect(result.eligible).toHaveLength(3);
    expect(result.skipped).toHaveLength(0);
  });

  it('roiScores map populated for all input platforms', () => {
    const variants = [makeVariant('Medium'), makeVariant('Blogger')];
    const result = filterByRoi(variants, db);
    expect(result.roiScores.has('Medium')).toBe(true);
    expect(result.roiScores.has('Blogger')).toBe(true);
  });
});

describe('computePlatformHealth', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    db.prepare(`INSERT INTO brand_profiles (brand_id, name) VALUES ('main', 'Brand')`).run();
  });
  afterEach(() => db.close());

  it('returns all 7 MVP platforms', () => {
    const health = computePlatformHealth(db);
    expect(health).toHaveLength(7);
  });

  it('cold start platforms have status=insufficient', () => {
    const health = computePlatformHealth(db);
    // No link_checks data at all — all cold start
    health.forEach(p => expect(p.status).toBe('insufficient'));
  });

  it('platform with high ROI and sufficient data gets status=active', () => {
    insertChecks(db, 'Medium', 't7d', 5, 'alive');
    insertChecks(db, 'Medium', 't30d', 5, 'alive');
    const health = computePlatformHealth(db);
    const medium = health.find(p => p.platform === 'Medium')!;
    expect(medium.status).toBe('active');
  });

  it('insufficient platforms sorted to end, others sorted by ROI asc', () => {
    // Give Medium good data so it's not insufficient
    insertChecks(db, 'Medium', 't7d', 5, 'alive');
    insertChecks(db, 'Medium', 't30d', 5, 'alive');

    const health = computePlatformHealth(db);
    const mediumIdx = health.findIndex(p => p.platform === 'Medium');
    const insufficientIdx = health.findIndex(p => p.dataInsufficient);

    // Medium should not be last among non-insufficient items
    expect(mediumIdx).toBeGreaterThanOrEqual(0);
    if (insufficientIdx >= 0) {
      // All insufficient rows come after non-insufficient rows
      const nonInsufficient = health.filter(p => !p.dataInsufficient);
      const insufficient = health.filter(p => p.dataInsufficient);
      expect(health.slice(0, nonInsufficient.length)).toEqual(nonInsufficient);
      expect(health.slice(nonInsufficient.length)).toEqual(insufficient);
    }
  });

  it('daTierLabel reflects tier score correctly', () => {
    const health = computePlatformHealth(db);
    const medium = health.find(p => p.platform === 'Medium')!;
    const telegra = health.find(p => p.platform === 'Telegra.ph')!;
    expect(medium.daTierLabel).toBe('Tier1');
    expect(telegra.daTierLabel).toBe('Tier3');
  });
});
