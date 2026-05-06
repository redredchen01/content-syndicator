import { BaseAdapter, PublishResult, PublishOptions, TestConnectionResult } from './base';
import { google } from 'googleapis';
import { db, oauthTokens } from '../db';

const BLOGGER_SCOPE = 'https://www.googleapis.com/auth/blogger';

export class BloggerAdapter extends BaseAdapter {
  name = 'Blogger';

  /**
   * Build an authenticated Google API client.
   * Priority: OAuth2 user token (from DB) > Service Account JSON (env).
   * Throws if neither is available or blogId is missing.
   */
  private async buildAuth(): Promise<{ auth: any; blogId: string }> {
    const blogId = process.env.BLOGGER_BLOG_ID;
    if (!blogId) throw new Error('BLOGGER_BLOG_ID not configured');

    // 1. Try OAuth2 user token stored in DB
    const stored = oauthTokens.get(db, 'blogger');
    if (stored) {
      const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_OAUTH_CLIENT_ID,
        process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      );
      oauth2Client.setCredentials({
        access_token: stored.access_token,
        refresh_token: stored.refresh_token,
        expiry_date: stored.expires_at,
      });
      // Persist refreshed token back to DB when the library auto-refreshes
      oauth2Client.on('tokens', (tokens) => {
        oauthTokens.upsert(db, 'blogger', {
          access_token: tokens.access_token ?? stored.access_token,
          refresh_token: tokens.refresh_token ?? stored.refresh_token,
          expires_at: tokens.expiry_date ?? stored.expires_at,
        });
      });
      return { auth: oauth2Client, blogId };
    }

    // 2. Fall back to Service Account JSON
    const credsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (credsJson) {
      const auth = new google.auth.GoogleAuth({
        credentials: JSON.parse(credsJson),
        scopes: [BLOGGER_SCOPE],
      });
      return { auth, blogId };
    }

    throw new Error(
      'Blogger not authorized. Visit /api/auth/google/start to connect your Google account, ' +
      'or set GOOGLE_APPLICATION_CREDENTIALS_JSON in .env.',
    );
  }

  async testConnection(): Promise<TestConnectionResult> {
    try {
      const { auth, blogId } = await this.buildAuth();
      const blogger = google.blogger({ version: 'v3', auth });
      await blogger.blogs.get({ blogId });
      return { ok: true };
    } catch (error: any) {
      return { ok: false, error: error?.message ?? String(error) };
    }
  }

  async publish(options: PublishOptions): Promise<PublishResult> {
    const { title, markdownContent, originalUrl, publishStatus = 'draft', tags } = options;

    try {
      const { auth, blogId } = await this.buildAuth();
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
