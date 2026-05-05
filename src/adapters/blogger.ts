import { BaseAdapter, PublishResult, PublishOptions } from './base';
import { google } from 'googleapis';
import { logger } from '../utils/logger';

export class BloggerAdapter extends BaseAdapter {
  name = 'Blogger';

  async publish(options: PublishOptions): Promise<PublishResult> {
    const { title, markdownContent, originalUrl, publishStatus = 'draft', tags } = options;
    const credsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    const blogId = process.env.BLOGGER_BLOG_ID;
    if (!credsJson || !blogId) {
      logger.warn('adapters.blogger.missing_env', {
        missing: 'GOOGLE_APPLICATION_CREDENTIALS_JSON or BLOGGER_BLOG_ID',
      });
      return this.missingEnv('GOOGLE_APPLICATION_CREDENTIALS_JSON', 'BLOGGER_BLOG_ID');
    }

    try {
      logger.debug('adapters.blogger.publish_start', {
        title: title.substring(0, 50),
        status: publishStatus,
      });

      const auth = new google.auth.GoogleAuth({
        credentials: JSON.parse(credsJson),
        scopes: ['https://www.googleapis.com/auth/blogger'],
      });
      const blogger = google.blogger({ version: 'v3', auth });

      const htmlContent = `<div>
${markdownContent.split('\n').map(line => `<p>${line}</p>`).join('\n')}
${originalUrl ? `<hr/><p><em>Originally published at: <a href="${originalUrl}">${originalUrl}</a></em></p>` : ''}
</div>`;

      const response = await blogger.posts.insert({
        blogId,
        isDraft: publishStatus === 'draft',
        requestBody: { title, content: htmlContent, labels: tags },
      });

      const publishedUrl = response.data.url ||
        `https://www.blogger.com/blog/post/edit/${blogId}/${response.data.id}`;

      logger.info('adapters.blogger.publish_success', {
        postId: response.data.id,
        url: publishedUrl,
      });

      return this.ok(publishedUrl);
    } catch (error: any) {
      logger.error('adapters.blogger.publish_error', {
        title: title.substring(0, 50),
        message: error.message,
      });
      return this.fail(error);
    }
  }
}
