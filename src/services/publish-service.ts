import type { PlatformAdapter } from '../adapters/base';
import { allAdapters } from '../adapters';
import { updateTaskProgress, getTaskProgress, savePost } from '../db/index';
import { appendToSheet } from '../sheets';
import { logger, randomSleep } from '../utils/logger';

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
  logger.info('services.publish.start', {
    sourceUrl: options.sourceUrl,
    title: options.title.substring(0, 50),
    qualityScore,
  });

  let targetPlatforms = resolveTargetPlatforms(options.platforms);

  // Quality-score gate: low-quality content skips premium platforms
  if (qualityScore < 7) {
    logger.warn('services.publish.quality_gate', {
      qualityScore,
      filtered: ['Hashnode', 'Medium'],
    });
    targetPlatforms = targetPlatforms.filter(p => !['Hashnode', 'Medium'].includes(p));
  }

  const adapters = allAdapters.filter(a => targetPlatforms.includes(a.name));
  if (adapters.length === 0) {
    logger.info('services.publish.skip', { reason: 'No valid platforms' });
    return { targetPlatforms, results: [] };
  }

  const publishStatus = options.publishStatus === 'public' ? 'public' : 'draft';
  const results: Array<{ platform: string; success: boolean; publishedUrl?: string; error?: string }> = [];

  logger.info('services.publish.platforms', {
    targetCount: adapters.length,
    platforms: adapters.map(a => a.name).join(','),
  });

  const apiAdapters = adapters.filter(a => !a.isBrowserAutomation);
  const browserAdapters = adapters.filter(a => a.isBrowserAutomation);

  // API platforms — publish concurrently
  if (apiAdapters.length > 0) {
    logger.debug('services.publish.api_adapters_start', {
      count: apiAdapters.length,
      adapters: apiAdapters.map(a => a.name).join(','),
    });
    const apiResults = await Promise.all(
      apiAdapters.map(async adapter => {
        try {
          logger.debug('services.publish.adapter_invoke', { platform: adapter.name });
          const result = await adapter.publish({
            title: options.title,
            markdownContent: options.content,
            tags: options.tags,
            excerpt: options.excerpt,
            originalUrl: buildUtmUrl(options.sourceUrl, adapter.name),
            publishStatus,
          });
          if (result.success) {
            logger.info('services.publish.adapter_success', {
              platform: adapter.name,
              url: result.publishedUrl,
            });
            updateTaskProgress(options.sourceUrl, adapter.name, 'success');
          } else {
            logger.warn('services.publish.adapter_failed', {
              platform: adapter.name,
              error: result.error,
            });
            updateTaskProgress(options.sourceUrl, adapter.name, 'failed', result.error);
          }
          return result;
        } catch (error: any) {
          logger.error('services.publish.adapter_error', {
            platform: adapter.name,
            message: error.message,
          });
          updateTaskProgress(options.sourceUrl, adapter.name, 'failed', error.message);
          return { platform: adapter.name, success: false, error: error.message };
        }
      }),
    );
    results.push(...apiResults);
    logger.debug('services.publish.api_adapters_done', {
      successful: apiResults.filter(r => r.success).length,
      failed: apiResults.filter(r => !r.success).length,
    });
  }

  // Browser platforms — publish sequentially with sleep between
  if (browserAdapters.length > 0) {
    logger.debug('services.publish.browser_adapters_start', {
      count: browserAdapters.length,
      adapters: browserAdapters.map(a => a.name).join(','),
    });
    for (let i = 0; i < browserAdapters.length; i++) {
      const adapter = browserAdapters[i];
      try {
        logger.debug('services.publish.browser_adapter_invoke', {
          platform: adapter.name,
          index: `${i + 1}/${browserAdapters.length}`,
        });
        const result = await adapter.publish({
          title: options.title,
          markdownContent: options.content,
          tags: options.tags,
          excerpt: options.excerpt,
          originalUrl: buildUtmUrl(options.sourceUrl, adapter.name),
          publishStatus,
        });
        results.push(result);
        if (result.success) {
          logger.info('services.publish.browser_adapter_success', {
            platform: adapter.name,
            url: result.publishedUrl,
          });
          updateTaskProgress(options.sourceUrl, adapter.name, 'success');
        } else {
          logger.warn('services.publish.browser_adapter_failed', {
            platform: adapter.name,
            error: result.error,
          });
          updateTaskProgress(options.sourceUrl, adapter.name, 'failed', result.error);
        }
      } catch (error: any) {
        logger.error('services.publish.browser_adapter_error', {
          platform: adapter.name,
          message: error.message,
        });
        updateTaskProgress(options.sourceUrl, adapter.name, 'failed', error.message);
        results.push({ platform: adapter.name, success: false, error: error.message });
      }

      if (i < browserAdapters.length - 1) {
        const sleepMs = 5000 + Math.floor(Math.random() * 10000);
        logger.debug('services.publish.sleep_before_next', { delayMs: sleepMs });
        await randomSleep(sleepMs, sleepMs);
      }
    }
  }

  logger.debug('services.publish.save_start', { resultCount: results.length });
  savePost(options.sourceUrl, options.title, options.content, results);
  await appendToSheet(options.sourceUrl, options.title, results);
  logger.debug('services.publish.save_done');

  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  logger.info('services.publish.complete', {
    successful,
    failed,
    total: results.length,
  });

  return { targetPlatforms, results };
}
