import { BaseAdapter, PublishResult, PublishOptions } from './base';
import { google } from 'googleapis';

export class BloggerAdapter extends BaseAdapter {
  name = 'Blogger';

  async publish(options: PublishOptions): Promise<PublishResult> {
    const { title, markdownContent, originalUrl, publishStatus = 'draft', tags } = options;
    const credsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    const blogId = process.env.BLOGGER_BLOG_ID;
    if (!credsJson || !blogId) return this.missingEnv('GOOGLE_APPLICATION_CREDENTIALS_JSON', 'BLOGGER_BLOG_ID');

    try {
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

      return this.ok(
        response.data.url ||
        `https://www.blogger.com/blog/post/edit/${blogId}/${response.data.id}`,
      );
    } catch (error: any) {
      return this.fail(error);
    }
  }
}
