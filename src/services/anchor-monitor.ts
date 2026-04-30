/**
 * Anchor distribution monitoring + weekly URL cap (Plan Unit 11, R10b/R10c).
 *
 * Two soft-control mechanisms triggered via /api/v2/precheck:
 *
 *   R10b — Anchor concentration: if any single anchor has been used in
 *   > brand.anchor_concentration_threshold fraction of the last 30
 *   batches, the editor must provide a reason before proceeding.
 *
 *   R10c — Weekly URL cap: if a target URL would exceed
 *   brand.weekly_url_cap links in a rolling 7-day window, same gate.
 *
 * Neither is a hard block — the editor can override with a reason
 * (stored in publish_jobs.metadata.bypass_reasons for monthly audit).
 * This is intentional per origin Scope Boundaries ("不硬阻断").
 */

import type Database from 'better-sqlite3';
import { anchorHistory } from '../db/repositories';
import type { BrandProfile } from '../db/repositories';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WarningType = 'anchor_concentration' | 'weekly_url_cap';

export interface PrecheckWarning {
  type: WarningType;
  /** Short title shown in the UI. */
  title: string;
  /** Full explanation for the reason text box. */
  message: string;
  /** Must be true — editor must provide a reason before submitting. */
  reasonRequired: true;
}

export interface PrecheckResult {
  /** Summary: how many warnings the editor needs to acknowledge. */
  warningCount: number;
  warnings: PrecheckWarning[];
  /**
   * How many times in the past 7 days the editor bypassed a cap.
   * Shown in the UI as a friction signal ("this is the Nth bypass
   * this week").
   */
  bypassCountThisWeek: number;
  /**
   * Detailed anchor concentration breakdown for UI and LLM hint.
   * Sent to Unit 6's anchor-generator prompt as `recent_top_anchors`.
   */
  topAnchors: Array<{ anchor: string; count: number; ratio: number }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sevenDaysAgoIso(): string {
  const d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  return d.toISOString();
}

function countBypassesThisWeek(db: Database.Database): number {
  const since = sevenDaysAgoIso();
  const rows = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM publish_jobs
       WHERE metadata_json LIKE '%bypass_reasons%'
       AND created_at >= ?`,
    )
    .get(since) as { cnt: number };
  return rows.cnt;
}

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * Runs the precheck for a single submission.
 *
 * @param targetUrls - the landing URLs this batch will link to (may be
 *   multiple if the editor plans parallel batches — usually just one).
 */
export function runPrecheck(
  db: Database.Database,
  targetUrls: string[],
  brand: Pick<BrandProfile, 'anchor_concentration_threshold' | 'weekly_url_cap'>,
): PrecheckResult {
  const warnings: PrecheckWarning[] = [];
  const since7d = sevenDaysAgoIso();

  // R10b — anchor concentration
  const topAnchors = anchorHistory.topInRecentBatches(db, 30, 10);
  const maxRatio = topAnchors.length > 0 ? topAnchors[0].ratio : 0;
  if (maxRatio > brand.anchor_concentration_threshold) {
    const worst = topAnchors[0];
    warnings.push({
      type: 'anchor_concentration',
      title: '锚词集中度超过阈值',
      message:
        `"${worst.anchor}" 在近 30 篇中出现比例 ${(worst.ratio * 100).toFixed(0)}%，` +
        `超过 ${(brand.anchor_concentration_threshold * 100).toFixed(0)}% 阈值。` +
        `请在下方说明继续的原因（如有意策略），或在发布后优化锚词生成 prompt。`,
      reasonRequired: true,
    });
  }

  // R10c — weekly URL cap (one warning per over-cap URL)
  for (const url of targetUrls) {
    const count = anchorHistory.weeklyCountForUrl(db, url, since7d);
    if (count >= brand.weekly_url_cap) {
      warnings.push({
        type: 'weekly_url_cap',
        title: `本周已达 ${url} 的反链上限`,
        message:
          `"${url}" 在过去 7 天内已积累 ${count} 条反链，` +
          `达到或超过 ${brand.weekly_url_cap} 的建议上限。` +
          `可改选其他目标页或说明原因继续。`,
        reasonRequired: true,
      });
    }
  }

  return {
    warningCount: warnings.length,
    warnings,
    bypassCountThisWeek: countBypassesThisWeek(db),
    topAnchors,
  };
}

/**
 * Convenience check for a single URL with default 7-day window.
 * Used by Unit 10 worker at dequeue time to avoid counting retries
 * toward the cap (learning #3: dedup before rate-limit count).
 */
export function isUrlOverCap(
  db: Database.Database,
  targetUrl: string,
  cap: number,
): boolean {
  return anchorHistory.weeklyCountForUrl(db, targetUrl, sevenDaysAgoIso()) >= cap;
}
