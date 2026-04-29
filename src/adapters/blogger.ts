import { PlatformAdapter, PublishResult, PublishOptions } from './base';
import { logger } from '../utils/logger';
import { google } from 'googleapis';

export class BloggerAdapter implements PlatformAdapter {
  name = 'Blogger';

  async publish(options: PublishOptions): Promise<PublishResult> {
    const { title, markdownContent, originalUrl, publishStatus = 'draft', tags } = options;
    const credsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    const blogId = process.env.BLOGGER_BLOG_ID;

    if (!credsJson || !blogId) {
      return {
        platform: this.name,
        success: false,
        error: 'GOOGLE_APPLICATION_CREDENTIALS_JSON or BLOGGER_BLOG_ID is not configured in .env'
      };
    }

    try {
      const credentials = JSON.parse(credsJson);
      const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/blogger']
      });

      const blogger = google.blogger({ version: 'v3', auth });

      const htmlContent = `
        <div>
          ${markdownContent.split('\n').map(line => `<p>${line}</p>`).join('')}
          ${originalUrl ? `<hr/><p><em>Originally published at: <a href="${originalUrl}">${originalUrl}</a></em></p>` : ''}
        </div>
      `;

      const response = await blogger.posts.insert({
        blogId,
        isDraft: publishStatus === 'draft',
        requestBody: {
          title,
          content: htmlContent,
          labels: tags
        }
      });

      return {
        platform: this.name,
        success: true,
        publishedUrl: response.data.url || `https://www.blogger.com/blog/post/edit/${blogId}/${response.data.id}`
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
