import type { PlatformAdapter } from '../adapters/base';
import { allAdapters } from '../adapters';
import { updateTaskProgress, getTaskProgress, savePost } from '../db/index';
import { appendToSheet } from '../sheets';
import { logger, randomSleep } from '../utils/logger';
import { CONCURRENCY_CONFIG } from '../constants';
import { runParallel } from '../utils/parallel';

export interface PublishOptions {
  sourceUrl: string;
  title: string;
  content: string;
  tags?: string[];
  excerpt?: string;
  platforms?: unknown;
  publishStatus?: 'draft' | 'public';
}

function resolveTargetPlatforms(platforms?: unknown): string[] {
  if (Array.isArray(platforms) && (platforms as unknown[]).length > 0) {
    return (platforms as unknown[]).filter((p): p is string => typeof p === 'string' && p.trim() !== '');
  }
  return allAdapters
    .filter(a => !a.isBrowserAutomation || Boolean(a.canPublishAutomatically))
    .map(a => a.name);
}

function buildUtmUrl(sourceUrl: string, adapterName: string): string {
  const utmSource = adapterName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const sep = sourceUrl.includes('?') ? '&' : '?';
  return `${sourceUrl}${sep}utm_source=${utmSource}&utm_medium=syndicator&utm_campaign=auto_publish`;
}

/**
 * Unified publish function: quality-score filtering, UTM injection,
 * API adapters concurrently, browser adapters sequentially.
 * Retry logic is handled by the caller (queue layer), not here.
 */
export async function publishToPlatforms(
  options: PublishOptions,
  qualityScore: number = 0,
): Promise<{ targetPlatforms: string[]; results: Array<{ platform: string; success: boolean; publishedUrl?: string; error?: string }> }> {
  let targetPlatforms = resolveTargetPlatforms(options.platforms);

  // Quality-score gate: low-quality content skips premium platforms
  if (qualityScore < 7) {
    logger.info(`Quality score ${qualityScore} < 7 — filtering out Hashnode and Medium`);
    targetPlatforms = targetPlatforms.filter(p => !['Hashnode', 'Medium'].includes(p));
  }

  const adapters = allAdapters.filter(a => targetPlatforms.includes(a.name));
  if (adapters.length === 0) {
    logger.info('All target platforms already processed or none available.');
    return { targetPlatforms, results: [] };
  }

  const publishStatus = options.publishStatus === 'public' ? 'public' : 'draft';
  const results: Array<{ platform: string; success: boolean; publishedUrl?: string; error?: string }> = [];

  logger.info(`Publishing to ${adapters.map(a => a.name).join(', ')}...`);

  const apiAdapters = adapters.filter(a => !a.isBrowserAutomation);
  const browserAdapters = adapters.filter(a => a.isBrowserAutomation);

  // API platforms — publish concurrently
  if (apiAdapters.length > 0) {
    logger.info(`Concurrently publishing to ${apiAdapters.length} API platform(s)...`);
    const apiResults = await Promise.all(
      apiAdapters.map(async adapter => {
        try {
          const result = await adapter.publish({
            title: options.title,
            markdownContent: options.content,
            tags: options.tags,
            excerpt: options.excerpt,
            originalUrl: buildUtmUrl(options.sourceUrl, adapter.name),
            publishStatus,
          });
          if (result.success) {
            logger.info(`[${adapter.name}] Published: ${result.publishedUrl}`);
            updateTaskProgress(options.sourceUrl, adapter.name, 'success');
          } else {
            logger.warn(`[${adapter.name}] Failed: ${result.error}`);
            updateTaskProgress(options.sourceUrl, adapter.name, 'failed', result.error);
          }
          return result;
        } catch (error: any) {
          logger.error(`[${adapter.name}] Unexpected error`, error);
          updateTaskProgress(options.sourceUrl, adapter.name, 'failed', error.message);
          return { platform: adapter.name, success: false, error: error.message };
        }
      }),
    );
    results.push(...apiResults);
  }

  // Browser platforms — publish with controlled concurrency (capped at BROWSER_MAX_TABS)
  if (browserAdapters.length > 0) {
    const concurrency = CONCURRENCY_CONFIG.BROWSER_MAX_TABS;
    logger.info(`Publishing to ${browserAdapters.length} browser platform(s) with concurrency=${concurrency}...`);
    const browserResults = await runParallel(
      browserAdapters,
      async adapter => {
        try {
          const result = await adapter.publish({
            title: options.title,
            markdownContent: options.content,
            tags: options.tags,
            excerpt: options.excerpt,
            originalUrl: buildUtmUrl(options.sourceUrl, adapter.name),
            publishStatus,
          });
          if (result.success) {
            logger.info(`[${adapter.name}] Published: ${result.publishedUrl}`);
            updateTaskProgress(options.sourceUrl, adapter.name, 'success');
          } else {
            logger.warn(`[${adapter.name}] Failed: ${result.error}`);
            updateTaskProgress(options.sourceUrl, adapter.name, 'failed', result.error);
          }
          return result;
        } catch (error: any) {
          logger.error(`[${adapter.name}] Unexpected error`, error);
          updateTaskProgress(options.sourceUrl, adapter.name, 'failed', error.message);
          return { platform: adapter.name, success: false, error: error.message };
        }
      },
      concurrency,
    );
    // Extract successful results from ParallelResult wrapper
    browserResults.forEach((result, index) => {
      if (result.ok) {
        results.push(result.value);
      } else {
        results.push({
          platform: browserAdapters[index]?.name || 'unknown',
          success: false,
          error: result.error.message,
        });
      }
    });
  }

  savePost(options.sourceUrl, options.title, options.content, results);
  await appendToSheet(options.sourceUrl, options.title, results);

  return { targetPlatforms, results };
}
