import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isOAuthConfigured,
  createOAuthClient,
  generateAuthUrl,
  BLOGGER_OAUTH_SCOPES,
} from '../google-oauth';

const ORIG_ENV = { ...process.env };

function setOAuthEnv() {
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-client-secret';
  process.env.OAUTH_REDIRECT_URI = 'http://localhost:3000/api/auth/google/callback';
}

function clearOAuthEnv() {
  delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  delete process.env.OAUTH_REDIRECT_URI;
}

describe('google-oauth', () => {
  beforeEach(() => clearOAuthEnv());
  afterEach(() => {
    process.env = { ...ORIG_ENV };
    vi.restoreAllMocks();
  });

  describe('isOAuthConfigured', () => {
    it('returns false when no env set', () => {
      expect(isOAuthConfigured()).toBe(false);
    });

    it('returns false when only some env set', () => {
      process.env.GOOGLE_OAUTH_CLIENT_ID = 'x';
      expect(isOAuthConfigured()).toBe(false);
      process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'y';
      expect(isOAuthConfigured()).toBe(false);
    });

    it('returns true when all three vars set', () => {
      setOAuthEnv();
      expect(isOAuthConfigured()).toBe(true);
    });
  });

  describe('createOAuthClient', () => {
    it('throws when env missing', () => {
      expect(() => createOAuthClient()).toThrow(/not configured/);
    });

    it('returns a configured client when env set', () => {
      setOAuthEnv();
      const client = createOAuthClient();
      expect(client).toBeDefined();
      // OAuth2Client exposes _clientId / redirect uri internally; assert via public method
      expect(typeof client.generateAuthUrl).toBe('function');
    });
  });

  describe('generateAuthUrl', () => {
    it('includes required OAuth params', () => {
      setOAuthEnv();
      const url = generateAuthUrl('test-state-abc', BLOGGER_OAUTH_SCOPES);
      const parsed = new URL(url);
      expect(parsed.host).toBe('accounts.google.com');
      expect(parsed.searchParams.get('access_type')).toBe('offline');
      expect(parsed.searchParams.get('prompt')).toBe('consent');
      expect(parsed.searchParams.get('state')).toBe('test-state-abc');
      expect(parsed.searchParams.get('scope')).toContain('blogger');
      expect(parsed.searchParams.get('client_id')).toBe(
        'test-client-id.apps.googleusercontent.com',
      );
      expect(parsed.searchParams.get('redirect_uri')).toBe(
        'http://localhost:3000/api/auth/google/callback',
      );
    });

    it('throws when env not configured', () => {
      expect(() => generateAuthUrl('s', BLOGGER_OAUTH_SCOPES)).toThrow(/not configured/);
    });
  });

  describe('exchangeCodeForTokens', () => {
    it('returns tokens when Google responds with refresh_token', async () => {
      setOAuthEnv();
      // Re-import after env is set so mock targets fresh module state
      vi.resetModules();
      const googleapis = await import('googleapis');
      vi.spyOn(googleapis.google.auth.OAuth2.prototype, 'getToken').mockResolvedValue({
        tokens: {
          refresh_token: 'r1',
          access_token: 'a1',
          expiry_date: 1234567890,
        },
        res: null,
      } as any);

      const { exchangeCodeForTokens } = await import('../google-oauth');
      const got = await exchangeCodeForTokens('valid-code');
      expect(got.refresh_token).toBe('r1');
      expect(got.access_token).toBe('a1');
      expect(got.expires_at).toBe(1234567890);
    });

    it('throws when Google omits refresh_token', async () => {
      setOAuthEnv();
      vi.resetModules();
      const googleapis = await import('googleapis');
      vi.spyOn(googleapis.google.auth.OAuth2.prototype, 'getToken').mockResolvedValue({
        tokens: { access_token: 'a-only' },
        res: null,
      } as any);

      const { exchangeCodeForTokens } = await import('../google-oauth');
      await expect(exchangeCodeForTokens('code')).rejects.toThrow(
        /did not return a refresh_token/,
      );
    });

    it('propagates getToken errors', async () => {
      setOAuthEnv();
      vi.resetModules();
      const googleapis = await import('googleapis');
      vi.spyOn(googleapis.google.auth.OAuth2.prototype, 'getToken').mockRejectedValue(
        new Error('invalid_grant'),
      );

      const { exchangeCodeForTokens } = await import('../google-oauth');
      await expect(exchangeCodeForTokens('bad-code')).rejects.toThrow(/invalid_grant/);
    });
  });

  describe('getAuthorizedClient', () => {
    it('throws when no tokens stored for platform', async () => {
      setOAuthEnv();
      vi.resetModules();
      // Mock the db oauth-tokens module to return null
      vi.doMock('../../db/oauth-tokens', () => ({
        oauthTokens: { get: () => null },
      }));
      vi.doMock('../../db', () => ({ db: {} }));
      const { getAuthorizedClient } = await import('../google-oauth');
      expect(() => getAuthorizedClient('blogger')).toThrow(/No OAuth tokens for blogger/);
    });

    it('returns a client with credentials set when tokens exist', async () => {
      setOAuthEnv();
      vi.resetModules();
      vi.doMock('../../db/oauth-tokens', () => ({
        oauthTokens: {
          get: () => ({
            refresh_token: 'stored-refresh',
            access_token: 'stored-access',
            expires_at: 9999,
          }),
        },
      }));
      vi.doMock('../../db', () => ({ db: {} }));
      const { getAuthorizedClient } = await import('../google-oauth');
      const client = getAuthorizedClient('blogger');
      expect(client.credentials.refresh_token).toBe('stored-refresh');
      expect(client.credentials.access_token).toBe('stored-access');
    });
  });
});
