/**
 * Unit 13: Link Liveness Worker
 *
 * Handles health_check_t24h / health_check_t7d / health_check_t30d jobs.
 * For each job:
 *   1. Read payload: { published_url, platform, batch_id, variant_id, check_type }
 *   2. Choose HEAD vs GET based on PLATFORM_HEAD_SUPPORTED
 *   3. Fetch with 10s AbortSignal timeout
 *   4. Classify response → alive | redirect_alive | 404 | 410 | timeout | unknown
 *   5. Write link_checks row + update Sheets liveness column
 *
 * Retry strategy (different from publish): max 3 attempts at 5 / 10 / 20 min.
 * All 3 timeouts → classification = 'unknown'.
 */

import type Database from 'better-sqlite3';
import type { JobType, PublishJob, LinkCheckType, LinkClassification } from '../../db/repositories';
import { linkChecks } from '../../db/repositories';
import { PLATFORM_HEAD_SUPPORTED } from '../../constants';
import { getSheetsClient } from '../../sheets';
import { logger } from '../../utils/logger';

export type CheckResult = {
  classification: LinkClassification;
  httpStatus: number | null;
};

// -----------------------------------------------------------------------
// Main handler — registered for health_check_t24h / t7d / t30d
// -----------------------------------------------------------------------

export async function handleLivenessJob(job: PublishJob, db: Database.Database): Promise<void> {
  let payload: { published_url: string; platform: string; batch_id?: string; variant_id?: string; check_type?: string };
  try {
    payload = JSON.parse(job.payload_json);
  } catch {
    throw new Error(`Cannot parse liveness payload for job ${job.id}`);
  }

  const { published_url, platform } = payload;
  if (!published_url) throw new Error(`Missing published_url in liveness job ${job.id}`);

  const checkType = jobTypeToCheckType(job.job_type);
  const result = await checkLiveness(published_url, platform);

  logger.info(
    `[Liveness] ${platform} ${checkType}: ${published_url} → ${result.classification}`,
  );

  // Write link_checks row
  linkChecks.insert(db, {
    batch_id: job.batch_id,
    variant_id: job.variant_id,
    platform,
    published_url,
    check_type: checkType,
    http_status: result.httpStatus,
    classification: result.classification,
  });

  // Update Sheets liveness column (non-fatal)
  try {
    const sheetsColumn = checkTypeToSheetsColumn(checkType);
    const sheets = getSheetsClient();
    await sheets.updateLiveness(job.batch_id, platform, sheetsColumn, result.classification);
  } catch (err: any) {
    logger.warn(`[Liveness] Sheets update failed (non-fatal): ${err.message}`);
  }
}

// -----------------------------------------------------------------------
// Core liveness check
// -----------------------------------------------------------------------

export async function checkLiveness(url: string, platform: string): Promise<CheckResult> {
  // Choose method based on preflight matrix
  const useHead = (PLATFORM_HEAD_SUPPORTED as Record<string, boolean>)[platform] ?? false;
  const method = useHead ? 'HEAD' : 'GET';
  const headers: Record<string, string> = useHead ? {} : { Range: 'bytes=0-4' };

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      redirect: 'manual', // handle redirects manually
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err: any) {
    const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
    return { classification: isTimeout ? 'timeout' : 'unknown', httpStatus: null };
  }

  const status = res.status;

  if (status === 404) return { classification: '404', httpStatus: 404 };
  if (status === 410) return { classification: '410', httpStatus: 410 };

  // Follow one redirect level
  if (status >= 300 && status < 400) {
    const location = res.headers.get('location') ?? '';
    try {
      const originalHost = new URL(url).hostname;
      const redirectHost = new URL(location, url).hostname;
      const classification: LinkClassification =
        redirectHost === originalHost || redirectHost.endsWith(`.${originalHost}`)
          ? 'redirect_alive'
          : 'unknown';
      return { classification, httpStatus: status };
    } catch {
      return { classification: 'unknown', httpStatus: status };
    }
  }

  if (status === 200 || (status >= 200 && status < 300) || status === 206) {
    return { classification: 'alive', httpStatus: status };
  }

  return { classification: 'unknown', httpStatus: status };
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function jobTypeToCheckType(jobType: JobType): LinkCheckType {
  switch (jobType) {
    case 'health_check_t24h': return 't24h';
    case 'health_check_t7d': return 't7d';
    case 'health_check_t30d': return 't30d';
    default: return 't24h';
  }
}

function checkTypeToSheetsColumn(checkType: LinkCheckType) {
  const map: Record<LinkCheckType, 't24h_alive' | 't7d_alive' | 't30d_alive'> = {
    t24h: 't24h_alive',
    t7d: 't7d_alive',
    t30d: 't30d_alive',
  };
  return map[checkType];
}
