import { BaseAdapter, PublishResult, PublishOptions, TestConnectionResult } from './base';
import { db } from '../db';
import { oauthTokens } from '../db/oauth-tokens';
import { parseWordPressToken } from '../services/wordpress-oauth';
import { logger } from '../utils/logger';

function escapeHtml(input: string) {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function markdownToHtml(markdown: string, originalUrl?: string): string {
  const html: string[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    const text = paragraph.join(' ').trim();
    if (text) html.push(`<p>${escapeHtml(text)}</p>`);
    paragraph = [];
  };

  for (const line of markdown.split('\n')) {
    const t = line.trim();
    if (!t) { flush(); continue; }

    const image = t.match(/^!\[([^\]]*)]\((https?:\/\/[^)]+)\)$/);
    if (image) { flush(); html.push(`<figure><img src="${escapeHtml(image[2])}" alt="${escapeHtml(image[1])}" /></figure>`); continue; }

    const heading = t.match(/^(#{1,4})\s+(.+)$/);
    if (heading) { flush(); const lvl = Math.min(heading[1].length + 1, 4); html.push(`<h${lvl}>${escapeHtml(heading[2])}</h${lvl}>`); continue; }

    const quote = t.match(/^>\s*(.+)$/);
    if (quote) { flush(); html.push(`<blockquote>${escapeHtml(quote[1])}</blockquote>`); continue; }

    const li = t.match(/^[-*]\s+(.+)$/);
    if (li) { flush(); html.push(`<p>&bull; ${escapeHtml(li[1])}</p>`); continue; }

    paragraph.push(t);
  }
  flush();

  if (originalUrl) {
    html.push(`<hr /><p><em>Originally published at: <a href="${escapeHtml(originalUrl)}">${escapeHtml(originalUrl)}</a></em></p>`);
  }

  return html.join('\n');
}

type AuthOrigin = 'oauth' | 'app_password';

interface OAuthContext {
  origin: 'oauth';
  baseUrl: 'https://public-api.wordpress.com';
  postsUrl: string; // /wp/v2/sites/{site_id}/posts
  testUrl: string;  // /wp/v2/sites/{site_id}
  authHeader: string;
}

interface AppPasswordContext {
  origin: 'app_password';
  baseUrl: string; // user's self-hosted root
  postsUrl: string; // ${baseUrl}/wp-json/wp/v2/posts
  testUrl: string;  // ${baseUrl}/wp-json/wp/v2/users/me
  authHeader: string;
}

type PublishContext = OAuthContext | AppPasswordContext;

export class WordPressAdapter extends BaseAdapter {
  name = 'WordPress';
  canPublishAutomatically = true;

  /**
   * Three-tier auth resolution:
   *   1. oauth_tokens.wordpress (WordPress.com OAuth — preferred)
   *   2. WORDPRESS_SITE_URL/USERNAME/APP_PASSWORD (self-hosted Application Password)
   *   3. throw — caller surfaces clear setup hint
   *
   * On decryption failure (typical: ENCRYPTION_KEY rotation) we delete the
   * corrupt row and fall through to tier 2, mirroring BloggerAdapter.
   */
  private getPublishContext(): PublishContext {
    if (oauthTokens.exists(db, 'wordpress')) {
      try {
        const stored = oauthTokens.get(db, 'wordpress');
        if (!stored) throw new Error('oauth_tokens row vanished mid-read');
        const { token, site_id } = parseWordPressToken(stored);
        const baseUrl = 'https://public-api.wordpress.com';
        return {
          origin: 'oauth',
          baseUrl,
          postsUrl: `${baseUrl}/wp/v2/sites/${encodeURIComponent(site_id)}/posts`,
          testUrl: `${baseUrl}/wp/v2/sites/${encodeURIComponent(site_id)}`,
          authHeader: `Bearer ${token}`,
        };
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        if (/Failed to decrypt/i.test(msg)) {
          logger.warn(
            '[WordPress] oauth_tokens row exists but cannot be decrypted ' +
            '(likely ENCRYPTION_KEY rotation). Clearing row and falling back ' +
            'to app password / setup-hint.',
          );
          oauthTokens.delete(db, 'wordpress');
          // fall through to app-password branch
        } else if (/missing access_token|missing token or site_id|malformed access_token/i.test(msg)) {
          // Row predates the JSON shape (or got corrupted). Treat as
          // "please reconnect" and fall through.
          logger.warn(`[WordPress] oauth_tokens row malformed (${msg}); clearing.`);
          oauthTokens.delete(db, 'wordpress');
        } else {
          throw e;
        }
      }
    }

    const siteUrl = process.env.WORDPRESS_SITE_URL?.replace(/\/+$/, '');
    const username = process.env.WORDPRESS_USERNAME;
    const appPassword = process.env.WORDPRESS_APP_PASSWORD;
    if (siteUrl && username && appPassword) {
      const basicAuth = Buffer.from(`${username}:${appPassword}`).toString('base64');
      return {
        origin: 'app_password',
        baseUrl: siteUrl,
        postsUrl: `${siteUrl}/wp-json/wp/v2/posts`,
        testUrl: `${siteUrl}/wp-json/wp/v2/users/me`,
        authHeader: `Basic ${basicAuth}`,
      };
    }

    throw new Error(
      'WordPress 未配置：请在 admin 页点击「Connect with WordPress.com」完成 OAuth 授权，' +
      '或设置 WORDPRESS_SITE_URL / WORDPRESS_USERNAME / WORDPRESS_APP_PASSWORD（自托管站点）。',
    );
  }

  /** 401 / authorization_required / invalid_token (any spelling) means the
   *  stored grant is dead — drop the row so the next call can fall back. */
  private isInvalidWordPressToken(err: unknown, status?: number): boolean {
    if (status === 401) return true;
    const msg = err instanceof Error ? err.message : String(err ?? '');
    return /authorization_required|invalid_token|token_revoked|401\b/i.test(msg);
  }

  async testConnection(): Promise<TestConnectionResult> {
    let ctx: PublishContext;
    try {
      ctx = this.getPublishContext();
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }

    try {
      const response = await fetch(ctx.testUrl, {
        headers: { Authorization: ctx.authHeader },
      });

      if (!response.ok) {
        if (ctx.origin === 'oauth' && this.isInvalidWordPressToken(null, response.status)) {
          oauthTokens.delete(db, 'wordpress');
          logger.warn('[WordPress] OAuth grant revoked — cleared stored tokens');
          return { ok: false, error: 'WordPress.com session revoked — please reconnect' };
        }
        return { ok: false, error: `${response.status} ${response.statusText}` };
      }
      return { ok: true };
    } catch (error: any) {
      return { ok: false, error: `Network error: ${error.message}` };
    }
  }

  async publish(options: PublishOptions): Promise<PublishResult> {
    let ctx: PublishContext;
    try {
      ctx = this.getPublishContext();
    } catch (e: any) {
      return { platform: this.name, success: false, error: e?.message ?? String(e) };
    }

    try {
      const response = await fetch(ctx.postsUrl, {
        method: 'POST',
        headers: { Authorization: ctx.authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: options.title,
          content: markdownToHtml(options.markdownContent, options.originalUrl),
          status: options.publishStatus === 'public' ? 'publish' : 'draft',
          excerpt: options.excerpt || undefined,
        }),
      });

      const text = await response.text();
      let data: any = {};
      try { data = text ? JSON.parse(text) : {}; } catch {
        throw new Error(`WordPress returned non-JSON (${response.status}): ${text.substring(0, 160)}`);
      }

      if (!response.ok) {
        if (ctx.origin === 'oauth' && this.isInvalidWordPressToken(data?.error || data?.message, response.status)) {
          oauthTokens.delete(db, 'wordpress');
          logger.warn('[WordPress] OAuth grant revoked during publish — cleared stored tokens');
          return {
            platform: this.name,
            success: false,
            error: 'WordPress.com session revoked — please reconnect and retry',
          };
        }
        throw new Error(data.message || `WordPress API returned HTTP ${response.status}`);
      }
      // OAuth response shape: { URL, ID, ... }; self-hosted: { link, id, ... }
      const publishedUrl =
        data.URL || data.link ||
        (ctx.origin === 'app_password'
          ? `${ctx.baseUrl}/wp-admin/post.php?post=${data.ID || data.id}&action=edit`
          : `https://public-api.wordpress.com/wp/v2/sites/${(ctx as OAuthContext).postsUrl}/posts/${data.ID || data.id}`);
      return this.ok(publishedUrl);
    } catch (error: any) {
      return this.fail(error);
    }
  }
}

// Type-only export for tests that want to assert on AuthOrigin without
// importing the private context shape.
export type { AuthOrigin };
