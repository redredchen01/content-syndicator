import { PlatformAdapter } from '../adapters/base';
import { allAdapters } from '../adapters';
import { updateTaskProgress, getTaskProgress, savePost } from '../db/index';
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
  if (Array.isArray(platforms) && (platforms as any[]).length > 0) {
    return (platforms as any[]).filter((p): p is string => typeof p === 'string' && p.trim() !== '');
  }
  return getDefaultPublishingPlatforms();
}

function getDefaultPublishingPlatforms(): string[] {
  return allAdapters
    .filter(a => isDefaultPublishTarget(a))
    .map(a => a.name);
}

function isDefaultPublishTarget(adapter: PlatformAdapter): boolean {
  if (!isAdapterConnected(adapter)) return false;
  if (adapter.isBrowserAutomation) return Boolean(adapter.canPublishAutomatically);
  return true;
}

function isAdapterConnected(adapter: PlatformAdapter): boolean {
  // Simplified check - in real implementation, check API keys etc.
  return true;
}
export async function publishToPlatforms(options: PublishOptions, qualityScore: number = 0): Promise<{
  targetPlatforms: string[];
  results: any[];
}> {
    let targetPlatforms = resolveTargetPlatforms(options.platforms);

    // 内容分层逻辑：如果质量评分 < 7，仅发布到基础渠道（过滤掉某些要求高质的 adapter）
    if (qualityScore < 7) {
        logger.info(`Quality score ${qualityScore} is low. Filtering out premium platforms.`);
        targetPlatforms = targetPlatforms.filter(p => !['Hashnode', 'Medium'].includes(p));
    }

    // ... 后续逻辑保持不变 ...
    const taskId = options.sourceUrl;

    const progress = getTaskProgress(taskId) as { platform: string; status: string; last_error: string | null }[];
    const successfulPlatforms = progress
      .filter(p => p.status === 'success')
      .map(p => p.platform);

    const adapters = allAdapters.filter(
      a => targetPlatforms.includes(a.name) && !successfulPlatforms.includes(a.name)
    );

    if (adapters.length === 0) {
      logger.info(`All target platforms already processed for ${taskId}.`);
      return { targetPlatforms, results: progress };
    }

    const results: any[] = [];
    logger.info(`Publishing: Processing ${adapters.length} pending platforms for ${taskId}...`);

    const publishStatus = options.publishStatus === 'public' ? 'public' : 'draft';

    for (const adapter of adapters) {
      let retries = 2;
      let success = false;

      while (retries >= 0 && !success) {
        try {
          const result = await adapter.publish({
            title: options.title,
            markdownContent: options.content,
            tags: options.tags,
            excerpt: options.excerpt,
            // 自动注入 UTM 参数
            originalUrl: `${options.sourceUrl}${options.sourceUrl.includes('?') ? '&' : '?'}utm_source=${adapter.name.toLowerCase().replace(/[^a-z0-9]/g, '')}&utm_medium=syndicator&utm_campaign=auto_publish`,
            publishStatus,
          });

          if (result.success) {
            updateTaskProgress(taskId, adapter.name, 'success');
            logger.success(`[${adapter.name}] Published!`);
            success = true;
            results.push(result);
          } else {
            throw new Error(result.error);
          }
        } catch (error: any) {
          retries--;
          logger.warn(`[${adapter.name}] Attempt failed, ${retries + 1} retries left. Error: ${error.message}`);
          if (retries < 0) {
            updateTaskProgress(taskId, adapter.name, 'failed', error.message);
            results.push({ platform: adapter.name, success: false, error: error.message });
          } else {
            await randomSleep(5000, 10000);
          }
        }
      }
    }

    savePost(options.sourceUrl, options.title, options.content, results);
    return { targetPlatforms, results };
}
