import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TwitterAdapter } from '../twitter';
import { db } from '../../db';
import { oauthTokens } from '../../db/oauth-tokens';
import * as twitterOAuth from '../../services/twitter-oauth';

const ORIG_ENV = { ...process.env };

function setOAuth2Env() {
  process.env.TWITTER_OAUTH_CLIENT_ID = 'cid';
  process.env.TWITTER_OAUTH_CLIENT_SECRET = 'secret';
  process.env.TWITTER_OAUTH_REDIRECT_URI = 'http://localhost:3000/api/auth/twitter/callback';
}

function setOAuth1aEnv() {
  process.env.TWITTER_CONSUMER_KEY = 'ck';
  process.env.TWITTER_CONSUMER_SECRET = 'cs';
  process.env.TWITTER_ACCESS_TOKEN = 'at';
  process.env.TWITTER_ACCESS_TOKEN_SECRET = 'ats';
}

describe('TwitterAdapter — dual-mode auth', () => {
  let adapter: TwitterAdapter;

  beforeEach(() => {
    process.env = { ...ORIG_ENV };
    delete process.env.TWITTER_CONSUMER_KEY;
    delete process.env.TWITTER_CONSUMER_SECRET;
    delete process.env.TWITTER_ACCESS_TOKEN;
    delete process.env.TWITTER_ACCESS_TOKEN_SECRET;
    delete process.env.TWITTER_OAUTH_CLIENT_ID;
    delete process.env.TWITTER_OAUTH_CLIENT_SECRET;
    delete process.env.TWITTER_OAUTH_REDIRECT_URI;
    oauthTokens.delete(db, 'twitter');
    adapter = new TwitterAdapter();
    global.fetch = vi.fn() as any;
  });

  afterEach(() => {
    oauthTokens.delete(db, 'twitter');
    vi.restoreAllMocks();
  });

  describe('testConnection', () => {
    it('returns guidance when nothing configured', async () => {
      const res = await adapter.testConnection();
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/Connect with X|TWITTER_CONSUMER_KEY/);
    });

    it('uses OAuth 2.0 Bearer when oauth_tokens.twitter exists', async () => {
      setOAuth2Env();
      oauthTokens.save(db, 'twitter', { refresh_token: 'r', access_token: 'a', expires_at: Date.now() + 3600_000 });
      vi.spyOn(twitterOAuth, 'getValidTwitterAccessToken').mockResolvedValue({
        accessToken: 'fresh-access',
        expiresAt: Date.now() + 3600_000,
      });
      (global.fetch as any).mockResolvedValueOnce({ ok: true });

      const res = await adapter.testConnection();
      expect(res.ok).toBe(true);
      const [, opts] = (global.fetch as any).mock.calls[0];
      expect(opts.headers.Authorization).toBe('Bearer fresh-access');
    });

    it('falls back to OAuth 1.0a when no oauth_tokens row', async () => {
      setOAuth1aEnv();
      (global.fetch as any).mockResolvedValueOnce({ ok: true });

      const res = await adapter.testConnection();
      expect(res.ok).toBe(true);
      const [, opts] = (global.fetch as any).mock.calls[0];
      expect(opts.headers.Authorization).toMatch(/^OAuth oauth_consumer_key="ck"/);
    });

    it('clears oauth_tokens.twitter when X returns 401', async () => {
      setOAuth2Env();
      oauthTokens.save(db, 'twitter', { refresh_token: 'r', access_token: 'a', expires_at: Date.now() + 3600_000 });
      vi.spyOn(twitterOAuth, 'getValidTwitterAccessToken').mockResolvedValue({
        accessToken: 'will-be-rejected',
        expiresAt: Date.now() + 3600_000,
      });
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: 'invalid_token' }),
      });

      const res = await adapter.testConnection();
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/Session revoked|reconnect/);
      expect(oauthTokens.exists(db, 'twitter')).toBe(false);
    });

    it('does not clear oauth_tokens on non-auth errors', async () => {
      setOAuth2Env();
      oauthTokens.save(db, 'twitter', { refresh_token: 'r', access_token: 'a', expires_at: Date.now() + 3600_000 });
      vi.spyOn(twitterOAuth, 'getValidTwitterAccessToken').mockResolvedValue({
        accessToken: 'a',
        expiresAt: Date.now() + 3600_000,
      });
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({ detail: 'Service unavailable' }),
      });

      const res = await adapter.testConnection();
      expect(res.ok).toBe(false);
      expect(oauthTokens.exists(db, 'twitter')).toBe(true);
    });

    it('clears corrupt oauth_tokens on decryption failure and falls through', async () => {
      setOAuth2Env();
      setOAuth1aEnv();
      oauthTokens.save(db, 'twitter', { refresh_token: 'r' });
      vi.spyOn(twitterOAuth, 'getValidTwitterAccessToken').mockRejectedValue(
        new Error('Failed to decrypt API key: auth tag mismatch'),
      );
      (global.fetch as any).mockResolvedValueOnce({ ok: true });

      const res = await adapter.testConnection();
      expect(res.ok).toBe(true);
      // Corrupt row cleared
      expect(oauthTokens.exists(db, 'twitter')).toBe(false);
      // Fell back to OAuth 1.0a
      const [, opts] = (global.fetch as any).mock.calls[0];
      expect(opts.headers.Authorization).toMatch(/^OAuth /);
    });
  });

  describe('publish', () => {
    it('uses OAuth 2.0 path when oauth_tokens exists', async () => {
      setOAuth2Env();
      oauthTokens.save(db, 'twitter', { refresh_token: 'r', access_token: 'a', expires_at: Date.now() + 3600_000 });
      vi.spyOn(twitterOAuth, 'getValidTwitterAccessToken').mockResolvedValue({
        accessToken: 'pub-access',
        expiresAt: Date.now() + 3600_000,
      });
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { id: '12345' } }),
      });

      const res = await adapter.publish({ title: 'Hello', markdownContent: 'm' });
      expect(res.success).toBe(true);
      expect(res.publishedUrl).toBe('https://x.com/i/web/status/12345');
      const [, opts] = (global.fetch as any).mock.calls[0];
      expect(opts.headers.Authorization).toBe('Bearer pub-access');
    });

    it('clears oauth_tokens on 401 and surfaces session-revoked error', async () => {
      setOAuth2Env();
      oauthTokens.save(db, 'twitter', { refresh_token: 'r', access_token: 'a', expires_at: Date.now() + 3600_000 });
      vi.spyOn(twitterOAuth, 'getValidTwitterAccessToken').mockResolvedValue({
        accessToken: 'pub-access',
        expiresAt: Date.now() + 3600_000,
      });
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: 'invalid_token' }),
      });

      const res = await adapter.publish({ title: 'Hello', markdownContent: 'm' });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/Session revoked|reconnect/);
      expect(oauthTokens.exists(db, 'twitter')).toBe(false);
    });

    it('OAuth 1.0a path still signs with HMAC-SHA1 when no oauth_tokens row', async () => {
      setOAuth1aEnv();
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { id: 'oauth1a-tweet' } }),
      });

      const res = await adapter.publish({ title: 'Legacy', markdownContent: 'm' });
      expect(res.success).toBe(true);
      const [, opts] = (global.fetch as any).mock.calls[0];
      expect(opts.headers.Authorization).toMatch(/oauth_signature="/);
    });

    it('truncates long titles to fit 280 char limit minus URL', async () => {
      setOAuth1aEnv();
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { id: 't' } }),
      });

      const long = 'x'.repeat(400);
      await adapter.publish({ title: long, markdownContent: 'm', originalUrl: 'https://example.com' });
      const [, opts] = (global.fetch as any).mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.text.length).toBeLessThanOrEqual(280);
      expect(body.text).toContain('https://example.com');
    });
  });
});
