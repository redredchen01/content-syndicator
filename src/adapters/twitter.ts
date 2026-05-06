import crypto from 'crypto';
import { BaseAdapter, PublishResult, PublishOptions, TestConnectionResult } from './base';

// RFC 3986 percent-encoding (stricter than encodeURIComponent)
function pct(s: string): string {
  return encodeURIComponent(s)
    .replace(/!/g, '%21').replace(/'/g, '%27')
    .replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\*/g, '%2A');
}

function buildOAuthHeader(
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

  // Signature base string
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

export class TwitterAdapter extends BaseAdapter {
  name = 'Twitter';
  canPublishAutomatically = true;

  private configured(): boolean {
    return Boolean(
      process.env.TWITTER_CONSUMER_KEY &&
      process.env.TWITTER_CONSUMER_SECRET &&
      process.env.TWITTER_ACCESS_TOKEN &&
      process.env.TWITTER_ACCESS_TOKEN_SECRET,
    );
  }

  private tweetText({ title, originalUrl }: PublishOptions): string {
    const urlSuffix = originalUrl ? ` ${originalUrl}` : '';
    const maxTitle = 280 - urlSuffix.length;
    const t = title.length > maxTitle ? `${title.slice(0, maxTitle - 1)}…` : title;
    return `${t}${urlSuffix}`;
  }

  async testConnection(): Promise<TestConnectionResult> {
    if (!this.configured()) {
      return {
        ok: false,
        error: 'TWITTER_CONSUMER_KEY, TWITTER_CONSUMER_SECRET, TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_TOKEN_SECRET not configured',
      };
    }
    try {
      const url = 'https://api.twitter.com/2/users/me';
      const auth = buildOAuthHeader(
        'GET', url,
        process.env.TWITTER_CONSUMER_KEY!,
        process.env.TWITTER_CONSUMER_SECRET!,
        process.env.TWITTER_ACCESS_TOKEN!,
        process.env.TWITTER_ACCESS_TOKEN_SECRET!,
      );
      const res = await fetch(url, { headers: { Authorization: auth } });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as any;
        return { ok: false, error: body?.detail ?? `HTTP ${res.status}` };
      }
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  async publish(options: PublishOptions): Promise<PublishResult> {
    if (!this.configured()) {
      return this.missingEnv(
        'TWITTER_CONSUMER_KEY', 'TWITTER_CONSUMER_SECRET',
        'TWITTER_ACCESS_TOKEN', 'TWITTER_ACCESS_TOKEN_SECRET',
      );
    }
    try {
      const apiUrl = 'https://api.twitter.com/2/tweets';
      const auth = buildOAuthHeader(
        'POST', apiUrl,
        process.env.TWITTER_CONSUMER_KEY!,
        process.env.TWITTER_CONSUMER_SECRET!,
        process.env.TWITTER_ACCESS_TOKEN!,
        process.env.TWITTER_ACCESS_TOKEN_SECRET!,
      );
      const text = this.tweetText(options);
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const data = await res.json() as any;
      if (!res.ok) {
        throw new Error(data?.detail ?? data?.title ?? JSON.stringify(data?.errors ?? data));
      }
      const tweetId = data.data?.id;
      return this.ok(tweetId ? `https://x.com/i/web/status/${tweetId}` : 'https://x.com');
    } catch (err: any) {
      return this.fail(err);
    }
  }
}
