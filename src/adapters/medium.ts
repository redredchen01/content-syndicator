import { PlatformAdapter, PublishResult, PublishOptions } from './base';
import { logger } from '../utils/logger';

export class MediumAdapter implements PlatformAdapter {
  name = 'Medium';
  private authorId?: string;

  private async getAuthorId(token: string): Promise<string> {
    if (this.authorId) return this.authorId;

    const res = await fetch('https://api.medium.com/v1/me', {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    
    if (!res.ok) {
      throw new Error('Failed to fetch Medium user ID');
    }
    
    const data = await res.json();
    this.authorId = data.data.id;
    return this.authorId!;
  }

  async publish(options: PublishOptions): Promise<PublishResult> {
    const { title, markdownContent, originalUrl, publishStatus = 'draft', tags } = options;
    const token = process.env.MEDIUM_INTEGRATION_TOKEN;
    if (!token) {
      return {
        platform: this.name,
        success: false,
        error: 'MEDIUM_INTEGRATION_TOKEN is not configured in .env'
      };
    }

    try {
      const authorId = await this.getAuthorId(token);
      
      const response = await fetch(`https://api.medium.com/v1/users/${authorId}/posts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          title,
          contentFormat: 'markdown',
          content: markdownContent,
          canonicalUrl: originalUrl || '',
          tags: tags && tags.length > 0 ? tags.slice(0, 5) : undefined, // Medium allows max 5 tags
          publishStatus: publishStatus === 'public' ? 'public' : 'draft'
        })
      });

      const data = await response.json();

      if (response.ok) {
        return {
          platform: this.name,
          success: true,
          publishedUrl: data.data.url
        };
      }

      throw new Error(data.errors?.[0]?.message || 'Failed to publish to Medium');
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
