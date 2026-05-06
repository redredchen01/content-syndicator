/**
 * Lint pipeline (Plan Unit 7, R23).
 *
 * Two-gate pre-publish check:
 *   1. Per-variant: regex lint against brand_profile.exposure_blocklist
 *      → variantViolations map drives Unit 8 single-tab red state.
 *   2. Batch-level: pairwise 5-gram Jaccard ≥ jaccard_threshold (default
 *      0.5 starting threshold per adversarial F5)
 *      → batchViolation forces regenerating the WEAKER variant of the
 *        offending pair.
 *
 * Lint is BLOCKING (the "一键发布" button stays disabled until both
 * gates pass). Decision in Plan Key Decisions.
 */

import type { BrandProfile } from '../../db/repositories';
import type { Variant } from '../../types';
import { pairwiseMaxJaccard } from './jaccard';
import {
  compileBlocklist,
  findFirstExposure,
  type ExposureMatch,
} from './regex-rules';

export interface BatchViolation {
  /** Variant indices ordered as [stronger, weaker]. Regenerate weaker. */
  pair: [number, number];
  /** The platform names (for UI display). */
  platforms: [string, string];
  /** The Jaccard similarity that exceeded the threshold. */
  similarity: number;
  /** The threshold that was exceeded. */
  threshold: number;
}

export interface LintResult {
  /** platform → exposure match (single first hit per variant). */
  variantViolations: Record<string, ExposureMatch>;
  /** null when all pairwise Jaccards stay under threshold. */
  batchViolation: BatchViolation | null;
  /** True when both gates pass. The "publish" button reads this. */
  passed: boolean;
}

/**
 * Picks which variant of a pair to regenerate (the "weaker" one).
 * Heuristics, in order:
 *   1. The one with an exposure violation (already needs editor work).
 *   2. The one with shorter body (less material to keep).
 *   3. Higher index (later in MVP_PLATFORMS = arbitrary tiebreaker).
 *
 * Returns the (stronger, weaker) ordering for `BatchViolation.pair`.
 */
export function orderPairByStrength(
  i: number,
  j: number,
  variants: Variant[],
  exposures: Record<string, ExposureMatch>,
): [number, number] {
  const a = variants[i];
  const b = variants[j];
  const aExposure = exposures[a.platform] ? 1 : 0;
  const bExposure = exposures[b.platform] ? 1 : 0;
  if (aExposure !== bExposure) {
    // The one with an exposure hit is weaker.
    return aExposure > bExposure ? [j, i] : [i, j];
  }
  if (a.body_markdown.length !== b.body_markdown.length) {
    return a.body_markdown.length > b.body_markdown.length ? [i, j] : [j, i];
  }
  return [i, j];
}

export function runLint(
  variants: Variant[],
  brand: Pick<BrandProfile, 'exposure_blocklist' | 'jaccard_threshold'>,
): LintResult {
  // Gate 1: per-variant exposure regex.
  const blocklist = brand.exposure_blocklist;
  const rules = compileBlocklist(blocklist);
  const variantViolations: Record<string, ExposureMatch> = {};
  for (const v of variants) {
    if (v.generation_status !== 'ok') continue;
    const hit = findFirstExposure(v.body_markdown, blocklist, rules);
    if (hit) variantViolations[v.platform] = hit;
  }

  // Gate 2: pairwise Jaccard.
  const successful = variants.filter((v) => v.generation_status === 'ok');
  const indexMap = successful.map((v) => variants.indexOf(v));
  const bodies = successful.map((v) => v.body_markdown);
  const max = pairwiseMaxJaccard(bodies);
  const threshold = brand.jaccard_threshold;

  let batchViolation: BatchViolation | null = null;
  if (max && max.similarity >= threshold) {
    const [li, lj] = max.pair;
    const realI = indexMap[li];
    const realJ = indexMap[lj];
    const ordered = orderPairByStrength(realI, realJ, variants, variantViolations);
    batchViolation = {
      pair: ordered,
      platforms: [variants[ordered[0]].platform, variants[ordered[1]].platform],
      similarity: max.similarity,
      threshold,
    };
  }

  return {
    variantViolations,
    batchViolation,
    passed: Object.keys(variantViolations).length === 0 && batchViolation === null,
  };
}
