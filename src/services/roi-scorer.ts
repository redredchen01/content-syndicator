/**
 * ROI Scorer — rates each MVP platform by DA tier (prior) + survival data (learned).
 *
 * score = DA_tier × 0.6 + avg(t7d_survival, t30d_survival) × 0.4
 * Cold start (<5 records for a check_type): that dimension is excluded from avg.
 * Full cold start (both dimensions cold): score = DA_tier × 1.0
 *
 * On error: fail-soft — score = DA_tier × 1.0 for all platforms (keeps low-DA
 * platforms filtered, but removes survival-learning component).
 */

import type Database from 'better-sqlite3';
import { linkChecks } from '../db/repositories';
import { MVP_PLATFORMS } from '../constants';
import { logger } from '../utils/logger';
import type { Variant } from '../types/index';

// ---------------------------------------------------------------------------
// DA tier defaults (using canonical adapter.name strings as keys)
// ---------------------------------------------------------------------------

/** Tier 1 (DA≥70 or high value): score = 1.0 */
const DEFAULT_DA_TIERS: Record<string, number> = {
  'Medium': 1.0,
  'Dev.to': 1.0,
  'Hashnode': 1.0,
  'Blogger': 0.6,    // Tier 2
  'WordPress': 0.6,  // Tier 2
  'Telegra.ph': 0.3, // Tier 3 — nofollow links
  'GitHub': 0.3,     // Tier 3 — nofollow links
};

export const DEFAULT_ROI_THRESHOLD = 0.3;

/** Minimum records per check_type before survival data enters the formula. */
const COLD_START_MIN_RECORDS = 5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RoiScoreResult {
  platform: string;
  score: number;
  daTierScore: number;
  t7dRate: number | null;
  t30dRate: number | null;
  dataInsufficient: boolean;
  coldStart: boolean;
}

export interface PlatformHealth extends RoiScoreResult {
  daTierLabel: 'Tier1' | 'Tier2' | 'Tier3';
  status: 'active' | 'warn' | 'insufficient';
  /** Alias for `score` — exposed for frontend compatibility. */
  roiScore: number;
}

export interface FilterResult {
  eligible: Variant[];
  skipped: Array<{ platform: string; score: number; reason: string }>;
  roiScores: Map<string, number>;
  engineStatus: 'ok' | 'degraded';
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

interface DaTierConfig {
  tiers: Record<string, number>;
  threshold: number;
}

export function getDaTierConfig(db: Database.Database): DaTierConfig {
  try {
    const row = db.prepare(
      `SELECT da_tier_config_json, roi_threshold FROM brand_profiles WHERE brand_id = 'main' LIMIT 1`,
    ).get() as { da_tier_config_json?: string; roi_threshold?: number | null } | undefined;

    const overrides: Record<string, number> = row?.da_tier_config_json
      ? JSON.parse(row.da_tier_config_json)
      : {};
    const threshold =
      typeof row?.roi_threshold === 'number' ? row.roi_threshold : DEFAULT_ROI_THRESHOLD;

    return {
      tiers: { ...DEFAULT_DA_TIERS, ...overrides },
      threshold,
    };
  } catch (err) {
    logger.warn(
      `[ROI] Failed to read DA tier config; falling back to defaults: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { tiers: { ...DEFAULT_DA_TIERS }, threshold: DEFAULT_ROI_THRESHOLD };
  }
}

// ---------------------------------------------------------------------------
// Core scoring
// ---------------------------------------------------------------------------

function since90DaysAgo(): string {
  const d = new Date();
  d.setDate(d.getDate() - 90);
  return d.toISOString();
}

export function computeRoiScore(
  db: Database.Database,
  platform: string,
  config: DaTierConfig,
  sinceIso?: string,
): RoiScoreResult {
  const since = sinceIso ?? since90DaysAgo();
  const daTierScore = config.tiers[platform] ?? 0.3;

  const t7dCount = linkChecks.survivalRecordCount(db, 't7d', platform, since);
  const t30dCount = linkChecks.survivalRecordCount(db, 't30d', platform, since);

  const hasT7d = t7dCount >= COLD_START_MIN_RECORDS;
  const hasT30d = t30dCount >= COLD_START_MIN_RECORDS;

  if (!hasT7d && !hasT30d) {
    // Full cold start — no reliable survival data
    return {
      platform,
      score: daTierScore,
      daTierScore,
      t7dRate: null,
      t30dRate: null,
      dataInsufficient: true,
      coldStart: true,
    };
  }

  const t7dRate = hasT7d
    ? linkChecks.survivalRate(db, 't7d', since, platform).rate
    : null;
  const t30dRate = hasT30d
    ? linkChecks.survivalRate(db, 't30d', since, platform).rate
    : null;

  const rates = [t7dRate, t30dRate].filter((r): r is number => r !== null);
  const avgSurvival = rates.reduce((s, r) => s + r, 0) / rates.length;

  const score = daTierScore * 0.6 + avgSurvival * 0.4;

  return {
    platform,
    score,
    daTierScore,
    t7dRate,
    t30dRate,
    dataInsufficient: false,
    coldStart: false,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function daTierLabel(score: number): 'Tier1' | 'Tier2' | 'Tier3' {
  if (score >= 1.0) return 'Tier1';
  if (score >= 0.6) return 'Tier2';
  return 'Tier3';
}

export function computePlatformHealth(db: Database.Database): PlatformHealth[] {
  const config = getDaTierConfig(db);
  const since = since90DaysAgo();

  const results = MVP_PLATFORMS.map((platform) => {
    const result = computeRoiScore(db, platform, config, since);
    const status: PlatformHealth['status'] = result.dataInsufficient
      ? 'insufficient'
      : result.score < config.threshold
        ? 'warn'
        : 'active';
    return {
      ...result,
      daTierLabel: daTierLabel(result.daTierScore),
      status,
      roiScore: result.score, // alias for frontend compatibility
    } satisfies PlatformHealth;
  });

  // Sort ascending by ROI score (worst first), insufficient rows last
  return results.sort((a, b) => {
    if (a.dataInsufficient && !b.dataInsufficient) return 1;
    if (!a.dataInsufficient && b.dataInsufficient) return -1;
    return a.score - b.score;
  });
}

export function filterByRoi(
  variants: Variant[],
  db: Database.Database,
): FilterResult {
  try {
    const config = getDaTierConfig(db);
    const since = since90DaysAgo();
    const roiScores = new Map<string, number>();
    const eligible: Variant[] = [];
    const skipped: FilterResult['skipped'] = [];

    for (const variant of variants) {
      const result = computeRoiScore(db, variant.platform, config, since);
      roiScores.set(variant.platform, result.score);

      if (result.score < config.threshold) {
        skipped.push({ platform: variant.platform, score: result.score, reason: 'low_roi' });
      } else {
        eligible.push(variant);
      }
    }

    return { eligible, skipped, roiScores, engineStatus: 'ok' };
  } catch (err) {
    // fail-soft: use DA tier × 1.0 for all platforms, keeps low-DA filtered
    logger.warn(`[ROI] scorer error — falling back to DA tier scoring: ${err instanceof Error ? err.message : String(err)}`);
    try {
      const config = getDaTierConfig(db);
      const roiScores = new Map<string, number>();
      const eligible: Variant[] = [];
      const skipped: FilterResult['skipped'] = [];

      for (const variant of variants) {
        const daTierScore = config.tiers[variant.platform] ?? 0.3;
        roiScores.set(variant.platform, daTierScore);
        if (daTierScore < config.threshold) {
          skipped.push({ platform: variant.platform, score: daTierScore, reason: 'low_roi_degraded' });
        } else {
          eligible.push(variant);
        }
      }
      return { eligible, skipped, roiScores, engineStatus: 'degraded' };
    } catch (fallbackErr) {
      // If even the fallback fails, pass everything through to keep dispatch alive
      logger.error('[ROI] Fallback DA tier scoring also failed; passing all variants through', {
        message: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
      });
      const roiScores = new Map(variants.map((v) => [v.platform, 0.0]));
      return { eligible: variants, skipped: [], roiScores, engineStatus: 'degraded' };
    }
  }
}
