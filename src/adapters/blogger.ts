import { BaseAdapter, PublishResult, PublishOptions, TestConnectionResult } from './base';
import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { db } from '../db';
import { oauthTokens } from '../db/oauth-tokens';
import { getAuthorizedClient } from '../services/google-oauth';
import { logger } from '../utils/logger';

const BLOGGER_SCOPES = ['https://www.googleapis.com/auth/blogger'];

type AuthOrigin = 'oauth' | 'service-account';
type AuthClient = OAuth2Client | InstanceType<typeof google.auth.GoogleAuth>;

export class BloggerAdapter extends BaseAdapter {
  name = 'Blogger';

  /**
   * Three-tier auth resolution:
   *   1. oauth_tokens row (user OAuth flow — preferred)
   *   2. GOOGLE_APPLICATION_CREDENTIALS_JSON (service account fallback)
   *   3. throw — caller surfaces clear setup hint
   */
  private getAuthClient(): { client: AuthClient; origin: AuthOrigin } {
    if (oauthTokens.exists(db, 'blogger')) {
      return { client: getAuthorizedClient('blogger'), origin: 'oauth' };
    }
    const credsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (credsJson) {
      const auth = new google.auth.GoogleAuth({
        credentials: JSON.parse(credsJson),
        scopes: BLOGGER_SCOPES,
      });
      return { client: auth, origin: 'service-account' };
    }
    throw new Error(
      'Blogger 未授权：请在 admin 页点击「Connect with Google」完成 OAuth 授权，' +
      '或设置 GOOGLE_APPLICATION_CREDENTIALS_JSON 服务账号凭证。',
    );
  }

  /** Detects revoked/invalid OAuth grants so callers can clear stale rows. */
  private isInvalidGrantError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /invalid_grant|invalid_token|Token has been expired or revoked/i.test(msg);
  }

  async testConnection(): Promise<TestConnectionResult> {
    const blogId = process.env.BLOGGER_BLOG_ID;
    if (!blogId) {
      return { ok: false, error: 'BLOGGER_BLOG_ID not set' };
    }

    let auth: AuthClient;
    let origin: AuthOrigin;
    try {
      ({ client: auth, origin } = this.getAuthClient());
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }

    try {
      const blogger = google.blogger({ version: 'v3', auth: auth as any });
      await blogger.blogs.get({ blogId });
      return { ok: true };
    } catch (error: any) {
      const msg = error?.message ?? String(error);
      if (origin === 'oauth' && this.isInvalidGrantError(error)) {
        // Stale grant — clear it so the user is prompted to reconnect rather
        // than hitting the same failure on every publish.
        oauthTokens.delete(db, 'blogger');
        logger.warn('[Blogger] OAuth grant revoked — cleared stored tokens');
        return { ok: false, error: 'Session revoked — please reconnect with Google' };
      }
      return { ok: false, error: msg };
    }
  }

  async publish(options: PublishOptions): Promise<PublishResult> {
    const { title, markdownContent, originalUrl, publishStatus = 'draft', tags } = options;
    const blogId = process.env.BLOGGER_BLOG_ID;
    if (!blogId) return this.missingEnv('BLOGGER_BLOG_ID');

    let auth: AuthClient;
    let origin: AuthOrigin;
    try {
      ({ client: auth, origin } = this.getAuthClient());
    } catch (e: any) {
      return { platform: this.name, success: false, error: e?.message ?? String(e) };
    }

    try {
      const blogger = google.blogger({ version: 'v3', auth: auth as any });

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
      if (origin === 'oauth' && this.isInvalidGrantError(error)) {
        oauthTokens.delete(db, 'blogger');
        logger.warn('[Blogger] OAuth grant revoked during publish — cleared stored tokens');
        return {
          platform: this.name,
          success: false,
          error: 'Session revoked — please reconnect with Google and retry',
        };
      }
      return this.fail(error);
    }
  }
}
