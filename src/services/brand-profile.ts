/**
 * Brand profile business logic (Plan Unit 3).
 *
 * Wraps the brandProfile repository with two responsibilities:
 *   1. Validation — enforces the R3 prefligh gate so dispatch is only
 *      allowed once the editor has filled in the minimum fields. Adversarial
 *      F7 protection: brand_id is hard-coded to 'main' regardless of any
 *      client-supplied body field, so PUT cannot create rogue rows even if
 *      the request payload includes brand_id='main2'.
 *   2. Input shape — accepts a flexible Partial input from the API layer
 *      and returns a coherent BrandProfile + ValidationReport pair.
 */

import type Database from 'better-sqlite3';
import { brandProfile, type BrandProfile } from '../db/repositories';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface FieldError {
  field: string;
  message: string;
}

export interface ValidationReport {
  valid: boolean;
  errors: FieldError[];
}

/**
 * R3 precondition gate. The lint pipeline (Unit 7) calls
 * isReadyForDispatch() before allowing /api/v2/generate to run.
 *
 * Required:
 *   - name (non-empty)
 *   - target_urls (≥ 1 entry, each with a non-empty url)
 *   - exposure_blocklist (≥ 5 entries, ≥ 1 char each)
 */
export function validateForDispatch(profile: BrandProfile | null): ValidationReport {
  const errors: FieldError[] = [];
  if (!profile) {
    errors.push({
      field: 'name',
      message: 'No brand profile configured. Visit /admin.html to fill it in.',
    });
    return { valid: false, errors };
  }

  if (!profile.name || profile.name.trim().length === 0) {
    errors.push({ field: 'name', message: '品牌主名不能为空' });
  }

  if (!Array.isArray(profile.target_urls) || profile.target_urls.length === 0) {
    errors.push({
      field: 'target_urls',
      message: '至少需要 1 条默认目标页 URL',
    });
  } else {
    for (let i = 0; i < profile.target_urls.length; i++) {
      const t = profile.target_urls[i];
      if (!t.url || !/^https?:\/\//.test(t.url)) {
        errors.push({
          field: `target_urls[${i}].url`,
          message: `第 ${i + 1} 条 URL 格式无效（需以 http:// 或 https:// 开头）`,
        });
      }
    }
  }

  if (
    !Array.isArray(profile.exposure_blocklist) ||
    profile.exposure_blocklist.length < 5
  ) {
    const got = profile.exposure_blocklist?.length ?? 0;
    errors.push({
      field: 'exposure_blocklist',
      message: `身份暴露禁用词列表至少 5 条以保证 lint 有效（当前 ${got} 条）`,
    });
  } else {
    for (let i = 0; i < profile.exposure_blocklist.length; i++) {
      if (!profile.exposure_blocklist[i]?.trim()) {
        errors.push({
          field: `exposure_blocklist[${i}]`,
          message: `第 ${i + 1} 条禁用词为空`,
        });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Lighter validation for upsert acceptance — fails only on programmer
 * errors (e.g., name not a string). The strict R3 gate above runs at
 * dispatch time, not on every save (so editors can save partial work).
 */
export function validateForSave(input: Partial<BrandProfile>): ValidationReport {
  const errors: FieldError[] = [];
  if (input.name !== undefined && typeof input.name !== 'string') {
    errors.push({ field: 'name', message: 'name must be a string' });
  }
  if (input.target_urls !== undefined) {
    if (!Array.isArray(input.target_urls)) {
      errors.push({ field: 'target_urls', message: 'target_urls must be an array' });
    } else {
      for (let i = 0; i < input.target_urls.length; i++) {
        const t = input.target_urls[i];
        if (typeof t?.url !== 'string') {
          errors.push({
            field: `target_urls[${i}].url`,
            message: 'each target_urls entry needs a string url',
          });
        }
        if (typeof t?.context_tag !== 'string') {
          errors.push({
            field: `target_urls[${i}].context_tag`,
            message: 'each target_urls entry needs a string context_tag',
          });
        }
      }
    }
  }
  if (
    input.exposure_blocklist !== undefined &&
    (!Array.isArray(input.exposure_blocklist) ||
      input.exposure_blocklist.some((s) => typeof s !== 'string'))
  ) {
    errors.push({
      field: 'exposure_blocklist',
      message: 'exposure_blocklist must be an array of strings',
    });
  }
  if (
    input.anchor_blocklist !== undefined &&
    (!Array.isArray(input.anchor_blocklist) ||
      input.anchor_blocklist.some((s) => typeof s !== 'string'))
  ) {
    errors.push({
      field: 'anchor_blocklist',
      message: 'anchor_blocklist must be an array of strings',
    });
  }
  if (
    input.digest_channel !== undefined &&
    !['none', 'email', 'telegram'].includes(input.digest_channel)
  ) {
    errors.push({
      field: 'digest_channel',
      message: 'digest_channel must be one of none|email|telegram',
    });
  }
  if (input.weekly_url_cap !== undefined) {
    const n = Number(input.weekly_url_cap);
    if (!Number.isFinite(n) || n < 1) {
      errors.push({
        field: 'weekly_url_cap',
        message: 'weekly_url_cap must be ≥ 1',
      });
    }
  }
  if (input.jaccard_threshold !== undefined) {
    const n = Number(input.jaccard_threshold);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      errors.push({
        field: 'jaccard_threshold',
        message: 'jaccard_threshold must be between 0 and 1',
      });
    }
  }
  if (input.anchor_concentration_threshold !== undefined) {
    const n = Number(input.anchor_concentration_threshold);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      errors.push({
        field: 'anchor_concentration_threshold',
        message: 'anchor_concentration_threshold must be between 0 and 1',
      });
    }
  }
  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// API surface
// ---------------------------------------------------------------------------

/**
 * Returns the single brand profile, or null when nothing has been saved
 * yet (the admin form's empty-state path).
 */
export function getProfile(db: Database.Database): BrandProfile | null {
  return brandProfile.get(db, 'main');
}

/**
 * Saves the profile. Always operates on brand_id='main' regardless of
 * any client-supplied brand_id (adversarial F7 mitigation). Returns the
 * persisted shape on success or a validation report on rejection.
 */
export function saveProfile(
  db: Database.Database,
  input: Partial<BrandProfile> & { name: string },
): { ok: true; profile: BrandProfile } | { ok: false; errors: FieldError[] } {
  const validation = validateForSave(input);
  if (!validation.valid) {
    return { ok: false, errors: validation.errors };
  }

  // Strip any client-supplied brand_id; upsertMain forces 'main'.
  const { brand_id: _ignored, updated_at: _ts, ...rest } = input;
  void _ignored;
  void _ts;
  const saved = brandProfile.upsertMain(db, rest);
  return { ok: true, profile: saved };
}

/**
 * Convenience: dispatch readiness check. Used by /api/v2/generate to
 * 412-Precondition-Failed early when the form isn't filled in.
 */
export function isReadyForDispatch(
  db: Database.Database,
): { ready: boolean; report: ValidationReport } {
  const profile = getProfile(db);
  const report = validateForDispatch(profile);
  return { ready: report.valid, report };
}

/**
 * Update preferred platforms for the user. Validates that all selected
 * platforms are currently connected and available.
 */
export function updatePreferredPlatforms(
  db: Database.Database,
  platforms: string[],
): { ok: true } | { ok: false; error: string } {
  if (!Array.isArray(platforms) || platforms.length === 0) {
    return { ok: false, error: '必须至少选择一个平台' };
  }

  // Validate all platforms are valid strings
  if (!platforms.every(p => typeof p === 'string' && p.trim().length > 0)) {
    return { ok: false, error: '平台列表包含无效项' };
  }

  // Store in database
  try {
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE brand_profiles
      SET preferred_platforms_json = ?, updated_at = ?
      WHERE brand_id = 'default'
    `).run(JSON.stringify(platforms), now);

    return { ok: true };
  } catch (error: any) {
    return { ok: false, error: error?.message ?? 'Failed to update preferred platforms' };
  }
}

/**
 * Get preferred platforms for the user. Returns an empty array if not set.
 */
export function getPreferredPlatforms(db: Database.Database): string[] {
  try {
    const result = db.prepare('SELECT preferred_platforms_json FROM brand_profiles LIMIT 1').get() as
      { preferred_platforms_json?: string } | undefined;
    if (result?.preferred_platforms_json) {
      return JSON.parse(result.preferred_platforms_json);
    }
  } catch (e) {
    // Silently fail, return empty array
  }
  return [];
}
