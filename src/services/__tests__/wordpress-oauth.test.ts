import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isWordPressOAuthConfigured,
  generateWordPressAuthUrl,
  exchangeWordPressCode,
  parseWordPressToken,
  wordpressAuthStrategy,
  WORDPRESS_AUTH_URL,
  WORDPRESS_TOKEN_URL,
} from '../wordpress-oauth';

describe('wordpress-oauth', () => {
  const ENV = {
    WORDPRESS_OAUTH_CLIENT_ID: 'wp_id_test',
    WORDPRESS_OAUTH_CLIENT_SECRET: 'wp_secret_test',
    WORDPRESS_OAUTH_REDIRECT_URI: 'http://localhost:3000/api/auth/wordpress/callback',
  };

  beforeEach(() => {
    Object.assign(process.env, ENV);
    vi.restoreAllMocks();
  });

  afterEach(() => {
    delete process.env.WORDPRESS_OAUTH_CLIENT_ID;
    delete process.env.WORDPRESS_OAUTH_CLIENT_SECRET;
    delete process.env.WORDPRESS_OAUTH_REDIRECT_URI;
  });

  describe('isWordPressOAuthConfigured', () => {
    it('returns true when all three env vars are set', () => {
      expect(isWordPressOAuthConfigured()).toBe(true);
    });

    it('returns false when client_id is missing', () => {
      delete process.env.WORDPRESS_OAUTH_CLIENT_ID;
      expect(isWordPressOAuthConfigured()).toBe(false);
    });

    it('returns false when client_secret is missing', () => {
      delete process.env.WORDPRESS_OAUTH_CLIENT_SECRET;
      expect(isWordPressOAuthConfigured()).toBe(false);
    });

    it('returns false when redirect_uri is missing', () => {
      delete process.env.WORDPRESS_OAUTH_REDIRECT_URI;
      expect(isWordPressOAuthConfigured()).toBe(false);
    });
  });

  describe('generateWordPressAuthUrl', () => {
    it('returns a wordpress.com URL with required params', () => {
      const url = generateWordPressAuthUrl({ state: 'state_abc' });
      expect(url.startsWith(WORDPRESS_AUTH_URL)).toBe(true);
      const parsed = new URL(url);
      expect(parsed.searchParams.get('response_type')).toBe('code');
      expect(parsed.searchParams.get('client_id')).toBe('wp_id_test');
      expect(parsed.searchParams.get('redirect_uri')).toBe(ENV.WORDPRESS_OAUTH_REDIRECT_URI);
      expect(parsed.searchParams.get('state')).toBe('state_abc');
    });

    it('throws when env not configured', () => {
      delete process.env.WORDPRESS_OAUTH_CLIENT_ID;
      expect(() => generateWordPressAuthUrl({ state: 'x' })).toThrow(/not configured/);
    });
  });

  describe('exchangeWordPressCode', () => {
    it('returns sentinel-shaped tokens with embedded site_id', async () => {
      const fetchMock = vi.spyOn(global, 'fetch' as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'wp_access_xyz',
          blog_id: '12345',
          blog_url: 'https://example.wordpress.com',
          token_type: 'bearer',
        }),
      } as any);

      const tokens = await exchangeWordPressCode('valid_code');
      expect(fetchMock).toHaveBeenCalledWith(WORDPRESS_TOKEN_URL, expect.any(Object));
      expect(tokens.refresh_token).toBe('wp_access_xyz');
      expect(tokens.access_token).toBe(JSON.stringify({ token: 'wp_access_xyz', site_id: '12345' }));
      expect(tokens.expires_at).toBeNull();
    });

    it('throws when blog_id missing', async () => {
      vi.spyOn(global, 'fetch' as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'wp_access_xyz' }),
      } as any);
      await expect(exchangeWordPressCode('valid_code')).rejects.toThrow(/missing blog_id/);
    });

    it('throws when access_token missing', async () => {
      vi.spyOn(global, 'fetch' as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ blog_id: '1' }),
      } as any);
      await expect(exchangeWordPressCode('valid_code')).rejects.toThrow(/missing access_token/);
    });

    it('throws when token endpoint returns 400', async () => {
      vi.spyOn(global, 'fetch' as any).mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error: 'invalid_request', error_description: 'bad code' }),
      } as any);
      await expect(exchangeWordPressCode('bad')).rejects.toThrow(/bad code/);
    });
  });

  describe('parseWordPressToken', () => {
    it('returns { token, site_id } from a JSON-encoded access_token', () => {
      const parsed = parseWordPressToken({
        refresh_token: 't',
        access_token: JSON.stringify({ token: 't', site_id: '99' }),
        expires_at: null,
      });
      expect(parsed).toEqual({ token: 't', site_id: '99' });
    });

    it('throws when access_token is null', () => {
      expect(() => parseWordPressToken({ refresh_token: 't', access_token: null })).toThrow(/missing access_token/);
    });

    it('throws when JSON is malformed', () => {
      expect(() => parseWordPressToken({
        refresh_token: 't',
        access_token: 'not-json',
      })).toThrow(/malformed access_token/);
    });

    it('throws when token or site_id missing inside JSON', () => {
      expect(() => parseWordPressToken({
        refresh_token: 't',
        access_token: JSON.stringify({ token: 't' }),
      })).toThrow(/missing token or site_id/);
    });
  });

  describe('AuthStrategy registration', () => {
    it('registers under providerId="wordpress"', () => {
      expect(wordpressAuthStrategy.providerId).toBe('wordpress');
      expect(wordpressAuthStrategy.providerLabel).toBe('WordPress.com');
      expect(wordpressAuthStrategy.supportedAdapters).toContain('WordPress');
    });
  });
});
