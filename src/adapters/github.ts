import { PlatformAdapter, PublishResult, PublishOptions } from './base';
import { logger } from '../utils/logger';

export class GitHubAdapter implements PlatformAdapter {
  name = 'GitHub';

  async publish(options: PublishOptions): Promise<PublishResult> {
    const { title, markdownContent, originalUrl } = options;
    const token = process.env.GITHUB_TOKEN;

    if (!token) {
      return {
        platform: this.name,
        success: false,
        error: 'GITHUB_TOKEN is not configured in .env'
      };
    }

    try {
      const filename = title.replace(/[^a-z0-9]/gi, '_').toLowerCase() + '.md';
      
      const content = originalUrl 
        ? markdownContent + `\n\n> Originally published at: ${originalUrl}`
        : markdownContent;

      const response = await fetch('https://api.github.com/gists', {
        method: 'POST',
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'Authorization': `token ${token}`
        },
        body: JSON.stringify({
          description: title,
          public: true,
          files: {
            [filename]: {
              content
            }
          }
        })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || 'Failed to create GitHub Gist');
      }

      return {
        platform: this.name,
        success: true,
        publishedUrl: data.html_url
      };
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
