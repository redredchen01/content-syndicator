import { logger } from '../utils/logger';
import type { PublishResult, PublishOptions, PlatformAdapter, TestConnectionResult } from '../types';

// Re-export for adapter files that import from './base'
export type { PublishResult, PublishOptions, PlatformAdapter, TestConnectionResult };

/** Shared helpers — extend instead of implementing PlatformAdapter directly. */
export abstract class BaseAdapter implements PlatformAdapter {
  abstract name: string;
  isBrowserAutomation?: boolean;
  canPublishAutomatically?: boolean;
  abstract publish(options: PublishOptions): Promise<PublishResult>;

  protected ok(publishedUrl: string): PublishResult {
    return { platform: this.name, success: true, publishedUrl };
  }

  protected fail(error: any): PublishResult {
    logger.error(`[${this.name}] Publish failed`, error);
    return { platform: this.name, success: false, error: error?.message ?? String(error) };
  }

  protected missingEnv(...vars: string[]): PublishResult {
    return {
      platform: this.name,
      success: false,
      error: `${vars.join(', ')} not configured in .env`,
    };
  }

  /** Appends attribution footer when originalUrl is present. */
  protected withAttribution(content: string, originalUrl?: string): string {
    return originalUrl ? `${content}\n\n> Originally published at: ${originalUrl}` : content;
  }
}
