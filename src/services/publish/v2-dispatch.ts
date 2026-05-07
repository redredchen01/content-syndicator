/**
 * services/publish/v2-dispatch.ts (Plan 2026-05-07-002 Unit 5)
 *
 * v0.2 publish API orchestration. Wraps four endpoints whose handlers in
 * routes/publish.ts:321-450 already delegated heavily to variant-generator,
 * anchor-generator, lint, scheduler, and roi-scorer — this service is the
 * canonical boundary so the controller can stay parse → delegate → respond.
 *
 *   POST /api/v2/generate            → runV2Generate
 *   POST /api/v2/dispatch            → runV2Dispatch
 *   POST /api/v2/dispatch/override   → runV2DispatchOverride
 *   POST /api/v2/regenerate-variant  → runRegenerateVariant
 *
 * Tagged-result shape mirrors services/admin/brand.ts: predictable business
 * failures return `{ ok: false, error, status }`; programming/config errors
 * still throw and bubble up to asyncRoute's 500 mapper.
 */

import type Database from 'better-sqlite3';
import type { Variant } from '../../types';
import { generateVariants, generateSingleVariant } from '../variant-generator';
import { attachAnchors } from '../anchor-generator';
import { runLint } from '../lint';
import { getProfile } from '../brand-profile';
import { anchorHistory, linkChecks, publishJobs } from '../../db/repositories';
import { dispatchVariantJobs } from '../queue/publish-worker';
import { filterByRoi, getDaTierConfig, type DaTierConfig } from '../roi-scorer';
import { logger } from '../../utils/logger';

// ---------------------------------------------------------------------------
// Compound Backlink Graph — tier-2 target selection
// ---------------------------------------------------------------------------

const TIER2_POOL_MIN = 10;
const TIER2_COOLDOWN_DAYS = 7;

/**
 * Selects a tier-2 target URL from the alive published URL pool.
 *
 * Returns { url, platform } for the highest-DA alive URL that:
 *   - is not a WordPress URL (anti-tier-3 guard: WordPress is always our tier-2 slot)
 *   - has not been used as a tier-2 target within the last 7 days
 *
 * Returns null when the pool is too small (<10) or all URLs are in cooldown.
 */
function selectTier2Target(
  db: Database.Database,
  daTierConfig: DaTierConfig,
): { url: string; platform: string } | null {
  try {
    const pool = linkChecks.aliveUrlsPool(db);

    if (pool.length < TIER2_POOL_MIN) {
      logger.info(`[CompoundGraph] skipped: pool too small (n=${pool.length})`);
      return null;
    }

    const windowIso = new Date(
      Date.now() - TIER2_COOLDOWN_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    const survivors = pool.filter(
      ({ published_url }) => !anchorHistory.usedAsTier2InWindow(db, published_url, windowIso),
    );

    if (survivors.length === 0) {
      logger.info('[CompoundGraph] skipped: all urls in cooldown');
      return null;
    }

    // Sort descending by DA tier score; stable sort preserves original order on ties
    survivors.sort(
      (a, b) => (daTierConfig.tiers[b.platform] ?? 0) - (daTierConfig.tiers[a.platform] ?? 0),
    );

    const { platform, published_url: url } = survivors[0];
    logger.info(`[CompoundGraph] tier-2 assigned: ${platform} ${url}`);
    return { url, platform };
  } catch (err: any) {
    logger.warn(`[CompoundGraph] selector error, skipping tier-2: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// v2/generate
// ---------------------------------------------------------------------------

export interface RunV2GenerateInput {
  draft?: unknown;
  title?: unknown;
  target_url_override?: unknown;
}

export type RunV2GenerateResult =
  | { ok: true; batchId: string; variants: Variant[]; lintResult: ReturnType<typeof runLint> }
  | { ok: false; error: string; status: 400 };

export async function runV2Generate(
  db: Database.Database,
  body: RunV2GenerateInput,
): Promise<RunV2GenerateResult> {
  const draft = typeof body.draft === 'string' ? body.draft : null;
  if (!draft) {
    return { ok: false, error: 'draft is required', status: 400 };
  }

  const brand = getProfile(db);
  if (!brand) {
    return { ok: false, error: 'Brand profile not configured', status: 400 };
  }

  const { batchId, variants } = await generateVariants(
    {
      draft,
      title: typeof body.title === 'string' ? body.title : undefined,
      target_url_override:
        typeof body.target_url_override === 'string' ? body.target_url_override : undefined,
      brand,
    },
    db,
  );

  // Compound backlink graph: attempt to assign a tier-2 target to the WordPress variant.
  const daTierConfig = getDaTierConfig(db);
  const tier2Target = selectTier2Target(db, daTierConfig);
  if (tier2Target !== null) {
    const wpVariant = variants.find(v => v.platform === 'WordPress');
    if (wpVariant) {
      wpVariant.target_url = tier2Target.url;
      wpVariant.is_tier2 = true;
      wpVariant.tier2_platform = tier2Target.platform;
      wpVariant.anchor_words = []; // force fresh anchor generation for tier-2 context
    }
  }

  const recentTopAnchors = anchorHistory.topInRecentBatches(db, 30, 10).map(r => r.anchor);
  const withAnchors = await attachAnchors(variants, brand, recentTopAnchors, db);
  const lintResult = runLint(withAnchors, brand);

  return { ok: true, batchId, variants: withAnchors, lintResult };
}

// ---------------------------------------------------------------------------
// v2/dispatch
// ---------------------------------------------------------------------------

const MIN_BODY_CHARS = 100;

interface DispatchVariantShape {
  platform: string;
  anchor_words?: string[];
  body_markdown?: string;
}

export interface RunV2DispatchInput {
  batchId?: unknown;
  variants?: unknown;
}

export interface InvalidDispatchEntry {
  platform: string;
  reason: 'naked_url_fallback' | 'body_too_short';
}

export type RunV2DispatchResult =
  | {
      ok: true;
      batchId: string;
      jobsCreated: number;
      variants: Variant[];
      skipped: ReturnType<typeof filterByRoi>['skipped'];
      roiEngineStatus: ReturnType<typeof filterByRoi>['engineStatus'];
    }
  | { ok: false; error: string; status: 400 }
  | { ok: false; error: string; status: 422; invalid: InvalidDispatchEntry[] };

export function runV2Dispatch(
  db: Database.Database,
  body: RunV2DispatchInput,
): RunV2DispatchResult {
  const batchId = typeof body.batchId === 'string' ? body.batchId : null;
  if (!batchId || !Array.isArray(body.variants)) {
    return { ok: false, error: 'batchId and variants[] are required', status: 400 };
  }

  const variants = body.variants as DispatchVariantShape[];

  // Server-side guard — frontend should already block these, but defence-in-depth
  // prevents a bypassed UI from enqueuing unusable jobs.
  const invalid: InvalidDispatchEntry[] = [];
  for (const v of variants) {
    if (v.anchor_words?.includes('__naked_url__')) {
      invalid.push({ platform: v.platform, reason: 'naked_url_fallback' });
      continue;
    }
    if (!v.body_markdown || v.body_markdown.trim().length < MIN_BODY_CHARS) {
      invalid.push({ platform: v.platform, reason: 'body_too_short' });
    }
  }
  if (invalid.length > 0) {
    return {
      ok: false,
      error: 'Some variants are not ready to dispatch',
      status: 422,
      invalid,
    };
  }

  const roiResult = filterByRoi(variants as Variant[], db);
  dispatchVariantJobs(roiResult.eligible, batchId, db, roiResult.roiScores);

  const jobs = publishJobs.byBatch(db, batchId);
  return {
    ok: true,
    batchId,
    jobsCreated: jobs.length,
    variants: roiResult.eligible,
    skipped: roiResult.skipped,
    roiEngineStatus: roiResult.engineStatus,
  };
}

// ---------------------------------------------------------------------------
// v2/dispatch/override
// ---------------------------------------------------------------------------

export interface RunV2DispatchOverrideInput {
  batchId?: unknown;
  platforms?: unknown;
  variants?: unknown;
}

export type RunV2DispatchOverrideResult =
  | { ok: true; added: string[] }
  | { ok: false; error: string; status: 400 };

const OVERRIDE_SCORE = 0.5;

export function runV2DispatchOverride(
  db: Database.Database,
  body: RunV2DispatchOverrideInput,
): RunV2DispatchOverrideResult {
  const batchId = typeof body.batchId === 'string' ? body.batchId : null;
  if (!batchId || !Array.isArray(body.platforms) || body.platforms.length === 0) {
    return { ok: false, error: 'batchId and platforms[] are required', status: 400 };
  }
  if (!Array.isArray(body.variants) || body.variants.length === 0) {
    return { ok: false, error: 'variants[] are required', status: 400 };
  }

  const platforms = body.platforms as string[];
  const variants = body.variants as Variant[];
  const added: string[] = [];

  for (const platform of platforms) {
    const variant = variants.find(v => v.platform === platform);
    if (!variant) continue;

    const roiScores = new Map<string, number>([[platform, OVERRIDE_SCORE]]);
    dispatchVariantJobs([variant], batchId, db, roiScores);
    added.push(platform);
  }

  return { ok: true, added };
}

// ---------------------------------------------------------------------------
// v2/regenerate-variant
// ---------------------------------------------------------------------------

export interface RunRegenerateVariantInput {
  batchId?: unknown;
  platform?: unknown;
  draft?: unknown;
  siblings?: unknown;
}

export type RunRegenerateVariantResult =
  | { ok: true; variant: Variant; lintResult: ReturnType<typeof runLint> }
  | { ok: false; error: string; status: 400 };

export async function runRegenerateVariant(
  db: Database.Database,
  body: RunRegenerateVariantInput,
): Promise<RunRegenerateVariantResult> {
  const batchId = typeof body.batchId === 'string' ? body.batchId : null;
  const platform = typeof body.platform === 'string' ? body.platform : null;
  const draft = typeof body.draft === 'string' ? body.draft : null;
  if (!batchId || !platform || !draft) {
    return { ok: false, error: 'batchId, platform, and draft are required', status: 400 };
  }

  const brand = getProfile(db);
  if (!brand) {
    return { ok: false, error: 'Brand profile not configured', status: 400 };
  }

  const newVariant = await generateSingleVariant(platform, { draft, brand }, batchId, db);

  const recentTopAnchors = anchorHistory.topInRecentBatches(db, 30, 10).map(r => r.anchor);
  const [withAnchor] = await attachAnchors([newVariant], brand, recentTopAnchors, db);

  // Merge with siblings (exclude any stale entry for this platform), then
  // re-run full lint so Jaccard is checked against the whole batch.
  const siblings = Array.isArray(body.siblings) ? (body.siblings as Variant[]) : [];
  const otherVariants = siblings.filter(v => v.platform !== platform);
  const allVariants = [...otherVariants, withAnchor];

  const lintResult = runLint(allVariants, brand);

  return { ok: true, variant: withAnchor, lintResult };
}
