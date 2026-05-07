import { BaseAdapter, PublishResult, PublishOptions, TestConnectionResult } from './base';
import { db } from '../db';
import { oauthTokens } from '../db/oauth-tokens';
import { logger } from '../utils/logger';

type AuthOrigin = 'oauth' | 'pat';

interface AuthHeader {
  origin: AuthOrigin;
  /** Full Authorization header value (already prefixed with Bearer / token). */
  value: string;
}

export class GitHubAdapter extends BaseAdapter {
  name = 'GitHub';

  /**
   * Two-tier auth resolution:
   *   1. oauth_tokens.github (GitHub OAuth — Bearer token, preferred)
   *   2. GITHUB_TOKEN env (legacy PAT — `token` auth)
   *   3. throw — caller surfaces "API key not configured"
   *
   * On decryption failure (typical: ENCRYPTION_KEY rotation) we delete the
   * corrupt row and fall through to PAT, mirroring BloggerAdapter / WordPress.
   */
  private getAuthHeader(): AuthHeader {
    if (oauthTokens.exists(db, 'github')) {
      try {
        const stored = oauthTokens.get(db, 'github');
        if (!stored) throw new Error('oauth_tokens row vanished mid-read');
        // Sentinel layout: refresh_token == access_token. Read either column.
        const token = stored.access_token || stored.refresh_token;
        if (!token) {
          throw new Error('OAuth row missing access_token — please reconnect.');
        }
        return { origin: 'oauth', value: `Bearer ${token}` };
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        if (/Failed to decrypt/i.test(msg)) {
          logger.warn(
            '[GitHub] oauth_tokens row exists but cannot be decrypted ' +
            '(likely ENCRYPTION_KEY rotation). Clearing row and falling back ' +
            'to GITHUB_TOKEN.',
          );
          oauthTokens.delete(db, 'github');
          // fall through to PAT branch
        } else if (/missing access_token/i.test(msg)) {
          logger.warn('[GitHub] oauth_tokens row malformed; clearing.');
          oauthTokens.delete(db, 'github');
        } else {
          throw e;
        }
      }
    }

    const pat = process.env.GITHUB_TOKEN;
    if (pat) {
      // Keep the legacy `token <pat>` header here. GitHub also accepts
      // `Bearer <pat>` for fine-grained PATs but classic PATs work better
      // with the historical `token` prefix; we don't change the format
      // for existing users.
      return { origin: 'pat', value: `token ${pat}` };
    }

    throw new Error('API key not configured');
  }

  /** 401 / Bad credentials means the OAuth token is dead — clear the row. */
  private isInvalidGitHubToken(status: number, body: any): boolean {
    if (status === 401) return true;
    const msg = (body && (body.message || body.error)) ?? '';
    return /bad credentials|invalid_token|401\b/i.test(String(msg));
  }

  async publish(options: PublishOptions): Promise<PublishResult> {
    const { title, markdownContent, originalUrl } = options;
    let auth: AuthHeader;
    try {
      auth = this.getAuthHeader();
    } catch (e: any) {
      // Preserve historical "GITHUB_TOKEN not configured in .env" hint when
      // truly nothing is set, since users may have started from that error.
      if (/API key not configured/.test(e?.message ?? '')) {
        return this.missingEnv('GITHUB_TOKEN');
      }
      return { platform: this.name, success: false, error: e?.message ?? String(e) };
    }

    try {
      const filename = `${title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.md`;
      const response = await fetch('https://api.github.com/gists', {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github.v3+json',
          Authorization: auth.value,
        },
        body: JSON.stringify({
          description: title,
          public: true,
          files: { [filename]: { content: this.withAttribution(markdownContent, originalUrl) } },
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        if (auth.origin === 'oauth' && this.isInvalidGitHubToken(response.status, data)) {
          oauthTokens.delete(db, 'github');
          logger.warn('[GitHub] OAuth token revoked during publish — cleared stored tokens');
          return {
            platform: this.name,
            success: false,
            error: 'GitHub session revoked — please reconnect and retry',
          };
        }
        throw new Error(data.message || 'Failed to create GitHub Gist');
      }
      return this.ok(data.html_url);
    } catch (error: any) {
      return this.fail(error);
    }
  }

  async testConnection(): Promise<TestConnectionResult> {
    let auth: AuthHeader;
    try {
      auth = this.getAuthHeader();
    } catch (e: any) {
      if (/API key not configured/.test(e?.message ?? '')) {
        return { ok: false, error: 'API key not configured' };
      }
      return { ok: false, error: e?.message ?? String(e) };
    }

    try {
      const response = await fetch('https://api.github.com/user', {
        headers: { Authorization: auth.value },
      });

      if (!response.ok) {
        if (auth.origin === 'oauth' && this.isInvalidGitHubToken(response.status, null)) {
          oauthTokens.delete(db, 'github');
          logger.warn('[GitHub] OAuth token revoked — cleared stored tokens');
          return { ok: false, error: 'GitHub session revoked — please reconnect' };
        }
        return { ok: false, error: `${response.status} ${response.statusText}` };
      }
      return { ok: true };
    } catch (error: any) {
      return { ok: false, error: `Network error: ${error.message}` };
    }
  }
}

export type { AuthOrigin };
