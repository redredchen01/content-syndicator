import { BaseAdapter, PublishResult, PublishOptions, TestConnectionResult } from './base';
import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { db } from '../db';
import { oauthTokens } from '../db/oauth-tokens';
import { BLOGGER_OAUTH_SCOPES, getAuthorizedClient } from '../services/google-oauth';
import { logger } from '../utils/logger';

type AuthOrigin = 'oauth' | 'service-account';
type AuthClient = OAuth2Client | InstanceType<typeof google.auth.GoogleAuth>;

export class BloggerAdapter extends BaseAdapter {
  name = 'Blogger';

  /**
   * Three-tier auth resolution:
   *   1. oauth_tokens row (user OAuth flow — preferred)
   *   2. GOOGLE_APPLICATION_CREDENTIALS_JSON (service account fallback)
   *   3. throw — caller surfaces clear setup hint
   *
   * If the OAuth row exists but its ciphertext can no longer be decrypted
   * (typical cause: ENCRYPTION_KEY was rotated without re-encrypting rows),
   * we delete the corrupt row and fall through to tier 2 instead of letting
   * the decryption error stop the chain. This keeps the documented fallback
   * order intact even after a key rotation incident.
   */
  private getAuthClient(): { client: AuthClient; origin: AuthOrigin } {
    if (oauthTokens.exists(db, 'blogger')) {
      try {
        return { client: getAuthorizedClient('blogger'), origin: 'oauth' };
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        if (/Failed to decrypt/i.test(msg)) {
          logger.warn(
            '[Blogger] oauth_tokens row exists but cannot be decrypted ' +
            '(likely ENCRYPTION_KEY rotation). Clearing row and falling back ' +
            'to service-account / setup-hint.',
          );
          oauthTokens.delete(db, 'blogger');
          // fall through to service-account branch
        } else {
          throw e;
        }
      }
    }
    const credsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (credsJson) {
      let credentials: object;
      try {
        credentials = JSON.parse(credsJson);
      } catch (e: any) {
        throw new Error(
          'GOOGLE_APPLICATION_CREDENTIALS_JSON is not valid JSON. Re-export the ' +
          'service-account key from Google Cloud Console: ' + (e?.message ?? String(e)),
        );
      }
      const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: BLOGGER_OAUTH_SCOPES,
      });
      return { client: auth, origin: 'service-account' };
    }
    throw new Error(
      'Blogger 未授权：请在 admin 页点击「Connect with Google」完成 OAuth 授权，' +
      '或设置 GOOGLE_APPLICATION_CREDENTIALS_JSON 服务账号凭证。',
    );
  }

  /** Detects revoked/invalid OAuth grants so callers can clear stale rows.
   *  Checks googleapis' structured error fields first; falls back to message
   *  regex for older library versions or wrapped errors. */
  private isInvalidGrantError(err: unknown): boolean {
    const e = err as { response?: { data?: { error?: string } }; code?: string; message?: string };
    if (e?.response?.data?.error === 'invalid_grant') return true;
    if (e?.code === 'invalid_grant') return true;
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
      const blogger = google.blogger({ version: 'v3', auth });
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
