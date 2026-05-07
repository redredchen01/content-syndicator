/**
 * services/admin/brand.ts (Plan 2026-05-07-002 Unit 1)
 *
 * Brand-profile read/write + dispatch readiness + precheck orchestration.
 * Five endpoints in routes/admin.ts (GET/PUT brand-profile, POST precheck,
 * GET/PATCH preferred-platforms) delegate here.
 *
 * Underlying domain logic still lives in services/brand-profile.ts and
 * services/anchor-monitor.ts; this service only adapts those building
 * blocks into HTTP-shaped tagged results with status hints.
 */

import type Database from 'better-sqlite3';
import {
  getProfile,
  saveProfile,
  isReadyForDispatch,
  updatePreferredPlatforms,
  getPreferredPlatforms,
  type FieldError,
  type ValidationReport,
} from '../brand-profile';
import type { BrandProfile } from '../../db/repositories';
import { runPrecheck } from '../anchor-monitor';
import { logger } from '../../utils/logger';

export interface BrandProfileWithDispatch {
  profile: BrandProfile | null;
  dispatchReady: boolean;
  dispatchReport: ValidationReport;
}

export interface SaveBrandProfileResult {
  ok: boolean;
  profile?: BrandProfile;
  errors?: FieldError[];
  dispatchReady?: boolean;
  dispatchReport?: ValidationReport;
  status?: 400 | 422;
}

export interface RunPrecheckResult {
  ok: boolean;
  /** runPrecheck output shape (per-platform anchor monitor results). */
  result?: ReturnType<typeof runPrecheck>;
  error?: string;
  status?: 412;
}

export interface UpdatePreferredPlatformsResult {
  ok: boolean;
  preferredPlatforms?: string[];
  error?: string;
  status?: 400 | 422;
}

/** GET /api/v2/brand-profile */
export function getBrandProfileWithDispatch(db: Database.Database): BrandProfileWithDispatch {
  const profile = getProfile(db);
  const dispatch = isReadyForDispatch(db);
  return { profile, dispatchReady: dispatch.ready, dispatchReport: dispatch.report };
}

/** PUT /api/v2/brand-profile */
export function saveBrandProfileFromInput(
  db: Database.Database,
  body: unknown,
): SaveBrandProfileResult {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, errors: [{ field: 'body', message: 'JSON body required' }], status: 400 };
  }
  const input = body as Record<string, unknown>;
  if (typeof input.name !== 'string' || input.name.trim().length === 0) {
    return { ok: false, errors: [{ field: 'name', message: '品牌主名不能为空' }], status: 422 };
  }
  const result = saveProfile(db, input as any);
  if (!result.ok) return { ok: false, errors: result.errors, status: 422 };
  const dispatch = isReadyForDispatch(db);
  return {
    ok: true,
    profile: result.profile,
    dispatchReady: dispatch.ready,
    dispatchReport: dispatch.report,
  };
}

/** POST /api/v2/precheck */
export function runPrecheckForDispatch(db: Database.Database, body: unknown): RunPrecheckResult {
  const profile = getProfile(db);
  if (!profile) {
    return { ok: false, error: '品牌资料库未配置，请先访问 /admin.html 填写。', status: 412 };
  }
  const input = (body ?? {}) as { target_urls?: unknown };
  const urls: string[] = Array.isArray(input.target_urls)
    ? input.target_urls.filter((u: unknown): u is string => typeof u === 'string' && u.trim() !== '')
    : [];
  return { ok: true, result: runPrecheck(db, urls, profile) };
}

/** PATCH /api/v2/brand-profile/preferred-platforms */
export function updatePreferredPlatformsForBrand(
  db: Database.Database,
  body: unknown,
): UpdatePreferredPlatformsResult {
  const input = (body ?? {}) as { platforms?: unknown };
  if (!Array.isArray(input.platforms)) {
    return { ok: false, error: 'platforms must be an array', status: 400 };
  }
  const result = updatePreferredPlatforms(db, input.platforms as string[]);
  if (!result.ok) {
    return { ok: false, error: result.error, status: 422 };
  }
  const preferred = getPreferredPlatforms(db);
  logger.info(`[Admin] Updated preferred platforms: ${preferred.join(', ')}`);
  return { ok: true, preferredPlatforms: preferred };
}

/** GET /api/v2/brand-profile/preferred-platforms */
export function getPreferredPlatformsForBrand(db: Database.Database): string[] {
  return getPreferredPlatforms(db);
}
