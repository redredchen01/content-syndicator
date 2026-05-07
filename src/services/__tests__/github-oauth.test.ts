import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isGitHubOAuthConfigured,
  generateGitHubAuthUrl,
  exchangeGitHubCode,
  githubAuthStrategy,
  GITHUB_AUTH_URL,
  GITHUB_TOKEN_URL,
} from '../github-oauth';

describe('github-oauth', () => {
  const ENV = {
    GITHUB_OAUTH_CLIENT_ID: 'gh_id_test',
    GITHUB_OAUTH_CLIENT_SECRET: 'gh_secret_test',
    GITHUB_OAUTH_REDIRECT_URI: 'http://localhost:3000/api/auth/github/callback',
  };

  beforeEach(() => {
    Object.assign(process.env, ENV);
    vi.restoreAllMocks();
  });

  afterEach(() => {
    delete process.env.GITHUB_OAUTH_CLIENT_ID;
    delete process.env.GITHUB_OAUTH_CLIENT_SECRET;
    delete process.env.GITHUB_OAUTH_REDIRECT_URI;
  });

  describe('isGitHubOAuthConfigured', () => {
    it('returns true when all three env vars are set', () => {
      expect(isGitHubOAuthConfigured()).toBe(true);
    });
    it('returns false when any env missing', () => {
      delete process.env.GITHUB_OAUTH_CLIENT_SECRET;
      expect(isGitHubOAuthConfigured()).toBe(false);
    });
  });

  describe('generateGitHubAuthUrl', () => {
    it('returns a github.com authorize URL with gist scope and state', () => {
      const url = generateGitHubAuthUrl({ state: 'state_xyz' });
      expect(url.startsWith(GITHUB_AUTH_URL)).toBe(true);
      const parsed = new URL(url);
      expect(parsed.searchParams.get('client_id')).toBe('gh_id_test');
      expect(parsed.searchParams.get('redirect_uri')).toBe(ENV.GITHUB_OAUTH_REDIRECT_URI);
      expect(parsed.searchParams.get('scope')).toBe('gist');
      expect(parsed.searchParams.get('state')).toBe('state_xyz');
      expect(parsed.searchParams.get('response_type')).toBe('code');
    });

    it('throws when env not configured', () => {
      delete process.env.GITHUB_OAUTH_CLIENT_ID;
      expect(() => generateGitHubAuthUrl({ state: 'x' })).toThrow(/not configured/);
    });
  });

  describe('exchangeGitHubCode', () => {
    it('returns sentinel-shaped tokens (refresh_token == access_token)', async () => {
      const fetchMock = vi.spyOn(global, 'fetch' as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'gh_access_xyz',
          scope: 'gist',
          token_type: 'bearer',
        }),
      } as any);

      const tokens = await exchangeGitHubCode('valid_code');
      expect(tokens.refresh_token).toBe('gh_access_xyz');
      expect(tokens.access_token).toBe('gh_access_xyz');
      expect(tokens.expires_at).toBeNull();

      // Verify the Accept: application/json header is sent (GitHub requires it
      // to return JSON instead of urlencoded body)
      const init = fetchMock.mock.calls[0][1] as any;
      expect(init.headers.Accept).toBe('application/json');
    });

    it('throws when access_token is missing from response', async () => {
      vi.spyOn(global, 'fetch' as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ scope: 'gist' }),
      } as any);
      await expect(exchangeGitHubCode('valid')).rejects.toThrow(/missing access_token/);
    });

    it('throws insufficient_scope error when gist not granted', async () => {
      vi.spyOn(global, 'fetch' as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'gh_access_xyz',
          scope: 'user',
          token_type: 'bearer',
        }),
      } as any);
      await expect(exchangeGitHubCode('valid')).rejects.toThrow(/Insufficient scope/);
    });

    it('throws on bad_verification_code (200 with error field)', async () => {
      vi.spyOn(global, 'fetch' as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          error: 'bad_verification_code',
          error_description: 'The code passed is incorrect or expired.',
        }),
      } as any);
      await expect(exchangeGitHubCode('bad')).rejects.toThrow(/bad_verification_code|incorrect or expired/);
    });

    it('throws on non-2xx HTTP status', async () => {
      vi.spyOn(global, 'fetch' as any).mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: 'server_error' }),
      } as any);
      await expect(exchangeGitHubCode('x')).rejects.toThrow(/500/);
    });
  });

  describe('AuthStrategy registration', () => {
    it('registers under providerId="github"', () => {
      expect(githubAuthStrategy.providerId).toBe('github');
      expect(githubAuthStrategy.providerLabel).toBe('GitHub');
      expect(githubAuthStrategy.supportedAdapters).toContain('GitHub');
    });
  });
});
