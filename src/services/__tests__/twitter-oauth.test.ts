import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  generateCodeVerifier,
  codeChallengeFromVerifier,
  generateTwitterAuthUrl,
  exchangeTwitterCode,
  refreshTwitterToken,
  isTwitterOAuthConfigured,
  twitterAuthStrategy,
  TWITTER_OAUTH2_SCOPES,
} from '../twitter-oauth';

const ORIG_ENV = { ...process.env };

function setEnv() {
  process.env.TWITTER_OAUTH_CLIENT_ID = 'twitter-client-id';
  process.env.TWITTER_OAUTH_CLIENT_SECRET = 'twitter-client-secret';
  process.env.TWITTER_OAUTH_REDIRECT_URI = 'http://localhost:3000/api/auth/twitter/callback';
}

function clearEnv() {
  delete process.env.TWITTER_OAUTH_CLIENT_ID;
  delete process.env.TWITTER_OAUTH_CLIENT_SECRET;
  delete process.env.TWITTER_OAUTH_REDIRECT_URI;
}

describe('twitter-oauth', () => {
  beforeEach(() => clearEnv());
  afterEach(() => {
    process.env = { ...ORIG_ENV };
    vi.restoreAllMocks();
  });

  describe('PKCE helpers', () => {
    it('generateCodeVerifier returns a 43+ char URL-safe string', () => {
      const v = generateCodeVerifier();
      expect(v.length).toBeGreaterThanOrEqual(43);
      expect(v.length).toBeLessThanOrEqual(128); // RFC 7636 bounds
      expect(v).toMatch(/^[A-Za-z0-9_-]+$/); // base64url chars only
    });

    it('generates different verifiers each call', () => {
      const a = generateCodeVerifier();
      const b = generateCodeVerifier();
      expect(a).not.toBe(b);
    });

    it('codeChallengeFromVerifier matches RFC 7636 test vector (S256)', () => {
      // RFC 7636 Appendix B
      const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
      const expected = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
      expect(codeChallengeFromVerifier(verifier)).toBe(expected);
    });
  });

  describe('isTwitterOAuthConfigured', () => {
    it('returns false when no env set', () => {
      expect(isTwitterOAuthConfigured()).toBe(false);
    });

    it('returns false when only some env set', () => {
      process.env.TWITTER_OAUTH_CLIENT_ID = 'x';
      expect(isTwitterOAuthConfigured()).toBe(false);
      process.env.TWITTER_OAUTH_CLIENT_SECRET = 'y';
      expect(isTwitterOAuthConfigured()).toBe(false);
    });

    it('returns true when all three vars set', () => {
      setEnv();
      expect(isTwitterOAuthConfigured()).toBe(true);
    });
  });

  describe('generateTwitterAuthUrl', () => {
    it('includes required PKCE + OAuth params', () => {
      setEnv();
      const url = generateTwitterAuthUrl({
        state: 'state-abc',
        codeChallenge: 'challenge-xyz',
      });
      const parsed = new URL(url);
      expect(parsed.host).toBe('twitter.com');
      expect(parsed.pathname).toBe('/i/oauth2/authorize');
      expect(parsed.searchParams.get('response_type')).toBe('code');
      expect(parsed.searchParams.get('state')).toBe('state-abc');
      expect(parsed.searchParams.get('code_challenge')).toBe('challenge-xyz');
      expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
      expect(parsed.searchParams.get('client_id')).toBe('twitter-client-id');
      expect(parsed.searchParams.get('scope')).toContain('tweet.write');
      expect(parsed.searchParams.get('scope')).toContain('offline.access');
    });

    it('throws when env not configured', () => {
      expect(() =>
        generateTwitterAuthUrl({ state: 's', codeChallenge: 'c' }),
      ).toThrow(/not configured/);
    });

    it('respects custom scopes when provided', () => {
      setEnv();
      const url = generateTwitterAuthUrl({
        state: 's',
        codeChallenge: 'c',
        scopes: ['tweet.read'],
      });
      expect(new URL(url).searchParams.get('scope')).toBe('tweet.read');
    });
  });

  describe('exchangeTwitterCode', () => {
    beforeEach(() => {
      setEnv();
      global.fetch = vi.fn() as any;
    });

    it('returns tokens on success', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'a-tok',
          refresh_token: 'r-tok',
          expires_in: 7200,
        }),
      });
      const res = await exchangeTwitterCode('code-x', 'verifier-y');
      expect(res.refresh_token).toBe('r-tok');
      expect(res.access_token).toBe('a-tok');
      expect(res.expires_at).toBeGreaterThan(Date.now());
    });

    it('sends correct grant_type, code, code_verifier, redirect_uri', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'a', refresh_token: 'r' }),
      });
      await exchangeTwitterCode('code-x', 'verifier-y');
      const [url, opts] = (global.fetch as any).mock.calls[0];
      expect(url).toBe('https://api.twitter.com/2/oauth2/token');
      expect(opts.method).toBe('POST');
      expect(opts.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
      expect(opts.headers.Authorization).toMatch(/^Basic /);
      const body = new URLSearchParams(opts.body);
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code')).toBe('code-x');
      expect(body.get('code_verifier')).toBe('verifier-y');
      expect(body.get('redirect_uri')).toBe('http://localhost:3000/api/auth/twitter/callback');
    });

    it('throws on non-2xx with error_description', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error: 'invalid_grant', error_description: 'bad code' }),
      });
      await expect(exchangeTwitterCode('c', 'v')).rejects.toThrow(/bad code/);
    });

    it('throws when refresh_token missing (offline.access not approved)', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'only-access' }),
      });
      await expect(exchangeTwitterCode('c', 'v')).rejects.toThrow(/refresh_token/i);
    });
  });

  describe('refreshTwitterToken', () => {
    beforeEach(() => {
      setEnv();
      global.fetch = vi.fn() as any;
    });

    it('returns refreshed tokens', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 7200,
        }),
      });
      const res = await refreshTwitterToken('old-refresh');
      expect(res.access_token).toBe('new-access');
      expect(res.refresh_token).toBe('new-refresh'); // X rotated it
    });

    it('falls back to old refresh_token when X does not rotate', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'new-access', expires_in: 7200 }),
      });
      const res = await refreshTwitterToken('old-refresh');
      expect(res.refresh_token).toBe('old-refresh');
    });

    it('throws on invalid_grant', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error: 'invalid_grant' }),
      });
      await expect(refreshTwitterToken('bad')).rejects.toThrow(/invalid_grant/);
    });
  });

  describe('twitterAuthStrategy (registry interface)', () => {
    beforeEach(() => setEnv());

    it('declares correct providerId and label', () => {
      expect(twitterAuthStrategy.providerId).toBe('twitter');
      expect(twitterAuthStrategy.providerLabel).toBe('X');
      expect(twitterAuthStrategy.supportedAdapters).toContain('Twitter');
    });

    it('default scopes include offline.access', () => {
      expect(twitterAuthStrategy.defaultScopes).toContain('offline.access');
      expect(twitterAuthStrategy.defaultScopes).toContain('tweet.write');
    });

    it('generateAuthUrl attaches codeVerifier via the attach hook', () => {
      const captured: Record<string, unknown> = {};
      const url = twitterAuthStrategy.generateAuthUrl({
        state: 'st',
        attach: (extras) => Object.assign(captured, extras),
      });
      expect(typeof captured.codeVerifier).toBe('string');
      expect((captured.codeVerifier as string).length).toBeGreaterThanOrEqual(43);
      // The URL's code_challenge should be SHA-256(verifier) as base64url
      const expected = codeChallengeFromVerifier(captured.codeVerifier as string);
      expect(new URL(url).searchParams.get('code_challenge')).toBe(expected);
    });

    it('exchangeCodeForTokens requires codeVerifier in extras', async () => {
      await expect(
        twitterAuthStrategy.exchangeCodeForTokens('code', {}),
      ).rejects.toThrow(/codeVerifier/);
    });
  });
});
