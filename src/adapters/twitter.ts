import crypto from 'crypto';
import { BaseAdapter, PublishResult, PublishOptions, TestConnectionResult } from './base';
import { db } from '../db';
import { oauthTokens } from '../db/oauth-tokens';
import { getValidTwitterAccessToken } from '../services/twitter-oauth';
import { logger } from '../utils/logger';

// RFC 3986 percent-encoding (stricter than encodeURIComponent)
function pct(s: string): string {
  return encodeURIComponent(s)
    .replace(/!/g, '%21').replace(/'/g, '%27')
    .replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\*/g, '%2A');
}

function buildOAuth1aHeader(
  method: string,
  url: string,
  consumerKey: string,
  consumerSecret: string,
  accessToken: string,
  tokenSecret: string,
): string {
  const nonce = crypto.randomBytes(16).toString('hex');
  const timestamp = String(Math.floor(Date.now() / 1000));

  const params: Record<string, string> = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp,
    oauth_token: accessToken,
    oauth_version: '1.0',
  };

  const sortedParams = Object.keys(params)
    .sort()
    .map(k => `${pct(k)}=${pct(params[k])}`)
    .join('&');
  const baseString = `${method}&${pct(url)}&${pct(sortedParams)}`;
  const signingKey = `${pct(consumerSecret)}&${pct(tokenSecret)}`;
  params.oauth_signature = crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');

  const headerValue = Object.keys(params)
    .sort()
    .map(k => `${pct(k)}="${pct(params[k])}"`)
    .join(', ');
  return `OAuth ${headerValue}`;
}

type AuthOrigin = 'oauth2' | 'oauth1a';

export class TwitterAdapter extends BaseAdapter {
  name = 'Twitter';
  canPublishAutomatically = true;

  private hasOAuth1aEnv(): boolean {
    return Boolean(
      process.env.TWITTER_CONSUMER_KEY &&
      process.env.TWITTER_CONSUMER_SECRET &&
      process.env.TWITTER_ACCESS_TOKEN &&
      process.env.TWITTER_ACCESS_TOKEN_SECRET,
    );
  }

  /**
   * Two-tier auth resolution:
   *   1. oauth_tokens row (OAuth 2.0 user-flow — preferred)
   *   2. TWITTER_* env keys (OAuth 1.0a — legacy, retained for back-compat)
   *   3. throw — caller surfaces clear setup hint
   *
   * Returns an `Authorization` header value plus the origin so callers can
   * route invalid_token cleanup correctly (only OAuth 2.0 rows get cleared
   * automatically; OAuth 1.0a env keys are left to the operator).
   */
  private async getAuthHeader(method: string, url: string): Promise<{ header: string; origin: AuthOrigin }> {
    if (oauthTokens.exists(db, 'twitter')) {
      try {
        const { accessToken } = await getValidTwitterAccessToken('twitter');
        return { header: `Bearer ${accessToken}`, origin: 'oauth2' };
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        if (/Failed to decrypt/i.test(msg)) {
          // Encryption key rotation — clear the corrupt row and fall through.
          logger.warn(
            '[Twitter] oauth_tokens row exists but cannot be decrypted ' +
            '(likely ENCRYPTION_KEY rotation). Clearing row and falling back.',
          );
          oauthTokens.delete(db, 'twitter');
        } else {
          throw e;
        }
      }
    }

    if (this.hasOAuth1aEnv()) {
      const header = buildOAuth1aHeader(
        method, url,
        process.env.TWITTER_CONSUMER_KEY!,
        process.env.TWITTER_CONSUMER_SECRET!,
        process.env.TWITTER_ACCESS_TOKEN!,
        process.env.TWITTER_ACCESS_TOKEN_SECRET!,
      );
      return { header, origin: 'oauth1a' };
    }

    throw new Error(
      'Twitter 未授权：请在 admin 页点击「Connect with X」完成 OAuth 2.0 授权，' +
      '或设置 TWITTER_CONSUMER_KEY / TWITTER_CONSUMER_SECRET / TWITTER_ACCESS_TOKEN / TWITTER_ACCESS_TOKEN_SECRET（OAuth 1.0a 回退）。',
    );
  }

  /** Detects revoked/invalid OAuth 2.0 tokens so callers can clear stale rows. */
  private isInvalidOAuth2Error(status: number, body: any): boolean {
    if (status === 401) return true;
    const code = body?.error ?? body?.errors?.[0]?.code;
    return code === 'invalid_token' || code === 'invalid_grant';
  }

  private tweetText({ title, originalUrl }: PublishOptions): string {
    const urlSuffix = originalUrl ? ` ${originalUrl}` : '';
    const maxTitle = 280 - urlSuffix.length;
    const t = title.length > maxTitle ? `${title.slice(0, maxTitle - 1)}…` : title;
    return `${t}${urlSuffix}`;
  }

  async testConnection(): Promise<TestConnectionResult> {
    const url = 'https://api.twitter.com/2/users/me';
    let header: string;
    let origin: AuthOrigin;
    try {
      ({ header, origin } = await this.getAuthHeader('GET', url));
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }

    try {
      const res = await fetch(url, {
        headers: { Authorization: header },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as any;
        if (origin === 'oauth2' && this.isInvalidOAuth2Error(res.status, body)) {
          oauthTokens.delete(db, 'twitter');
          logger.warn('[Twitter] OAuth 2.0 grant revoked — cleared stored tokens');
          return { ok: false, error: 'Session revoked — please reconnect with X' };
        }
        return { ok: false, error: body?.detail ?? body?.error ?? `HTTP ${res.status}` };
      }
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  async publish(options: PublishOptions): Promise<PublishResult> {
    const apiUrl = 'https://api.twitter.com/2/tweets';
    let header: string;
    let origin: AuthOrigin;
    try {
      ({ header, origin } = await this.getAuthHeader('POST', apiUrl));
    } catch (e: any) {
      return { platform: this.name, success: false, error: e?.message ?? String(e) };
    }

    try {
      const text = this.tweetText(options);
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { Authorization: header, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(15_000),
      });
      const data = await res.json().catch(() => ({})) as any;
      if (!res.ok) {
        if (origin === 'oauth2' && this.isInvalidOAuth2Error(res.status, data)) {
          oauthTokens.delete(db, 'twitter');
          logger.warn('[Twitter] OAuth 2.0 grant revoked during publish — cleared stored tokens');
          return {
            platform: this.name,
            success: false,
            error: 'Session revoked — please reconnect with X and retry',
          };
        }
        throw new Error(data?.detail ?? data?.title ?? JSON.stringify(data?.errors ?? data));
      }
      const tweetId = data.data?.id;
      return this.ok(tweetId ? `https://x.com/i/web/status/${tweetId}` : 'https://x.com');
    } catch (err: any) {
      return this.fail(err);
    }
  }
}
