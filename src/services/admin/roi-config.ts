/**
 * services/admin/roi-config.ts (Plan 2026-05-07-002 Unit 1)
 *
 * Platform-health (ROI scoring) read + DA tier configuration write. Originally
 * inline in routes/admin.ts:360-435 (3 endpoints).
 */

import type Database from 'better-sqlite3';
import { computePlatformHealth } from '../roi-scorer';
import { MVP_PLATFORMS } from '../../constants';
import { logger } from '../../utils/logger';

const VALID_TIER_SCORES = new Set([0.3, 0.6, 1.0]);

/**
 * GET /api/v2/platform-health — never throws. On underlying error, returns
 * an "insufficient" fallback array so the UI can render a coherent state
 * during cold-start or missing-data conditions.
 */
export function getPlatformHealth(db: Database.Database) {
  try {
    return computePlatformHealth(db);
  } catch (err) {
    logger.error('[Admin] computePlatformHealth failed, returning insufficient fallback', {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return (MVP_PLATFORMS as readonly string[]).map((platform) => ({
      platform,
      daTierLabel: 'Tier3' as const,
      daTierScore: 0.3,
      t7dRate: null,
      t30dRate: null,
      roiScore: 0.3,
      score: 0.3,
      status: 'insufficient' as const,
      dataInsufficient: true,
      coldStart: true,
    }));
  }
}

export interface UpdateRoiConfigInput {
  daTierConfig?: unknown;
  threshold?: unknown;
}

export interface UpdateRoiConfigResult {
  ok: boolean;
  daTierConfig?: Record<string, number>;
  threshold?: number;
  error?: string;
  status?: 400;
}

/** PATCH /api/v2/roi-config — validates threshold + tier scores, merges and persists. */
export function updateRoiConfig(db: Database.Database, body: unknown): UpdateRoiConfigResult {
  const { daTierConfig, threshold } = (body ?? {}) as UpdateRoiConfigInput;

  // Validate threshold
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    return { ok: false, error: 'threshold must be a number between 0 and 1', status: 400 };
  }

  // Validate daTierConfig values
  if (daTierConfig !== undefined && typeof daTierConfig === 'object' && daTierConfig !== null) {
    for (const [key, val] of Object.entries(daTierConfig as Record<string, unknown>)) {
      if (!(MVP_PLATFORMS as readonly string[]).includes(key)) {
        return { ok: false, error: `Unknown platform: ${key}`, status: 400 };
      }
      // Explicit typeof prevents type coercion attacks
      if (typeof val !== 'number' || !VALID_TIER_SCORES.has(val)) {
        return { ok: false, error: `Invalid tier score for ${key}: must be 0.3, 0.6, or 1.0`, status: 400 };
      }
    }
  }

  // Read existing row
  const row = db.prepare(
    `SELECT da_tier_config_json, roi_threshold FROM brand_profiles WHERE brand_id = 'main' LIMIT 1`,
  ).get() as { da_tier_config_json?: string; roi_threshold?: number | null } | undefined;

  if (!row) {
    return { ok: false, error: 'Brand profile not configured', status: 400 };
  }

  // Merge DA tier config
  let existingTiers: Record<string, number> = {};
  try {
    existingTiers = row.da_tier_config_json ? JSON.parse(row.da_tier_config_json) : {};
  } catch {
    existingTiers = {};
  }
  const mergedTiers: Record<string, number> = {
    ...existingTiers,
    ...((daTierConfig ?? {}) as Record<string, number>),
  };

  db.prepare(
    `UPDATE brand_profiles SET da_tier_config_json = ?, roi_threshold = ? WHERE brand_id = 'main'`,
  ).run(JSON.stringify(mergedTiers), threshold);

  logger.info(`[Admin] Updated ROI config: threshold=${threshold}`);

  return { ok: true, daTierConfig: mergedTiers, threshold };
}
