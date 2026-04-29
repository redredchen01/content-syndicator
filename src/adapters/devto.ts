import { PlatformAdapter, PublishResult, PublishOptions } from './base';
import { logger } from '../utils/logger';

export class DevToAdapter implements PlatformAdapter {
  name = 'Dev.to';

  async publish(options: PublishOptions): Promise<PublishResult> {
    const { title, markdownContent, originalUrl, publishStatus = 'draft', tags, excerpt } = options;
    const apiKey = process.env.DEVTO_API_KEY;
    if (!apiKey) {
      return {
        platform: this.name,
        success: false,
        error: 'DEVTO_API_KEY is not configured in .env'
      };
    }

    try {
      const response = await fetch('https://dev.to/api/articles', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': apiKey
        },
        body: JSON.stringify({
          article: {
            title,
            body_markdown: markdownContent + (originalUrl ? `\n\n> Originally published at: ${originalUrl}` : ''),
            published: publishStatus === 'public',
            tags: tags ? tags.join(', ') : undefined,
            description: excerpt
          }
        })
      });

      const data = await response.json();

      if (response.ok) {
        return {
          platform: this.name,
          success: true,
          publishedUrl: data.url
        };
      }

      throw new Error(data.error || 'Failed to publish to Dev.to');
    } catch (error: any) {
      logger.error(`[${this.name}] Publish failed`, error);
      return {
        platform: this.name,
        success: false,
        error: error.message
      };
    }
  }
}
