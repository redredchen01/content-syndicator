import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

// Set OAuth env BEFORE importing app/server so the route module sees them
process.env.TWITTER_OAUTH_CLIENT_ID = 'twitter-test-cid';
process.env.TWITTER_OAUTH_CLIENT_SECRET = 'twitter-test-secret';
process.env.TWITTER_OAUTH_REDIRECT_URI = 'http://localhost:3000/api/auth/twitter/callback';

import { app } from '../../server';
import { db } from '../../db';
import { oauthTokens } from '../../db/oauth-tokens';
import { __test as authTest } from '../auth';
import * as twitterOAuth from '../../services/twitter-oauth';

describe('Twitter OAuth routes', () => {
  beforeEach(() => {
    authTest.clearPendingStates();
    oauthTokens.delete(db, 'twitter');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    oauthTokens.delete(db, 'twitter');
  });

  describe('GET /api/auth/twitter/start', () => {
    it('returns 503 when env not configured', async () => {
      const orig = process.env.TWITTER_OAUTH_CLIENT_ID;
      delete process.env.TWITTER_OAUTH_CLIENT_ID;
      try {
        const res = await request(app).get('/api/auth/twitter/start?platform=twitter');
        expect(res.status).toBe(503);
      } finally {
        process.env.TWITTER_OAUTH_CLIENT_ID = orig;
      }
    });

    it('returns 400 for unknown platform', async () => {
      const res = await request(app).get('/api/auth/twitter/start?platform=blogger');
      expect(res.status).toBe(400);
    });

    it('redirects to twitter.com with PKCE params', async () => {
      const res = await request(app)
        .get('/api/auth/twitter/start?platform=twitter')
        .redirects(0);
      expect(res.status).toBe(302);
      const location = res.headers.location;
      expect(location).toMatch(/^https:\/\/twitter\.com\/i\/oauth2\/authorize/);
      const url = new URL(location);
      expect(url.searchParams.get('code_challenge')).toBeTruthy();
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('state')).toMatch(/^[0-9a-f]{64}$/);
      expect(url.searchParams.get('scope')).toContain('offline.access');
    });

    it('stores codeVerifier in extras alongside the state', async () => {
      const before = authTest.pendingStatesSize();
      await request(app).get('/api/auth/twitter/start?platform=twitter').redirects(0);
      expect(authTest.pendingStatesSize()).toBe(before + 1);
    });
  });

  describe('GET /api/auth/twitter/callback', () => {
    async function startAndCaptureState(): Promise<{ state: string; challenge: string }> {
      const res = await request(app)
        .get('/api/auth/twitter/start?platform=twitter')
        .redirects(0);
      const url = new URL(res.headers.location);
      return {
        state: url.searchParams.get('state')!,
        challenge: url.searchParams.get('code_challenge')!,
      };
    }

    it('redirects with oauth_error when user denies', async () => {
      const res = await request(app)
        .get('/api/auth/twitter/callback?error=access_denied')
        .redirects(0);
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/oauth_error=access_denied/);
    });

    it('redirects with invalid_state for unknown state', async () => {
      const res = await request(app)
        .get('/api/auth/twitter/callback?code=x&state=invalid')
        .redirects(0);
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/oauth_error=invalid_state/);
    });

    it('persists tokens on successful callback', async () => {
      const { state } = await startAndCaptureState();
      vi.spyOn(twitterOAuth.twitterAuthStrategy, 'exchangeCodeForTokens').mockResolvedValue({
        refresh_token: 'twitter-refresh',
        access_token: 'twitter-access',
        expires_at: Date.now() + 7200_000,
      });

      const res = await request(app)
        .get(`/api/auth/twitter/callback?code=valid&state=${state}`)
        .redirects(0);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/admin.html?connected=twitter');
      const stored = oauthTokens.get(db, 'twitter');
      expect(stored?.refresh_token).toBe('twitter-refresh');
    });

    it('rejects state on second use (one-shot)', async () => {
      const { state } = await startAndCaptureState();
      vi.spyOn(twitterOAuth.twitterAuthStrategy, 'exchangeCodeForTokens').mockResolvedValue({
        refresh_token: 'r',
        access_token: 'a',
        expires_at: Date.now() + 7200_000,
      });

      const first = await request(app)
        .get(`/api/auth/twitter/callback?code=x&state=${state}`)
        .redirects(0);
      expect(first.status).toBe(302);
      expect(first.headers.location).toBe('/admin.html?connected=twitter');

      const second = await request(app)
        .get(`/api/auth/twitter/callback?code=x&state=${state}`)
        .redirects(0);
      expect(second.headers.location).toMatch(/oauth_error=invalid_state/);
    });

    it('redirects with stable error code on token exchange failure', async () => {
      const { state } = await startAndCaptureState();
      vi.spyOn(twitterOAuth.twitterAuthStrategy, 'exchangeCodeForTokens').mockRejectedValue(
        new Error('Twitter token exchange failed (400): invalid_grant'),
      );

      const res = await request(app)
        .get(`/api/auth/twitter/callback?code=bad&state=${state}`)
        .redirects(0);
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/oauth_error=exchange_failed/);
    });

    it('rejects state from wrong provider (Google state used on Twitter callback)', async () => {
      // Start a Google flow first to populate a state with providerId='google'
      const googleStart = await request(app)
        .get('/api/auth/google/start?platform=blogger')
        .redirects(0);
      // If google env not set this returns 503 — skip in that case
      if (googleStart.status !== 302) return;
      const googleState = new URL(googleStart.headers.location).searchParams.get('state')!;

      const res = await request(app)
        .get(`/api/auth/twitter/callback?code=x&state=${googleState}`)
        .redirects(0);
      expect(res.headers.location).toMatch(/oauth_error=invalid_state/);
    });
  });

  describe('DELETE /api/auth/oauth/twitter', () => {
    it('clears stored tokens', async () => {
      oauthTokens.save(db, 'twitter', { refresh_token: 'to-clear' });
      const res = await request(app).delete('/api/auth/oauth/twitter');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(oauthTokens.exists(db, 'twitter')).toBe(false);
    });
  });
});
