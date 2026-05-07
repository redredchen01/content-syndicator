import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

// Set OAuth env BEFORE importing app/server so the route module sees them
process.env.WORDPRESS_OAUTH_CLIENT_ID = 'wp-test-cid';
process.env.WORDPRESS_OAUTH_CLIENT_SECRET = 'wp-test-secret';
process.env.WORDPRESS_OAUTH_REDIRECT_URI = 'http://localhost:3000/api/auth/wordpress/callback';

import { app } from '../../server';
import { db } from '../../db';
import { oauthTokens } from '../../db/oauth-tokens';
import { __test as authTest } from '../auth';
import * as wordpressOAuth from '../../services/wordpress-oauth';

describe('WordPress.com OAuth routes', () => {
  beforeEach(() => {
    authTest.clearPendingStates();
    oauthTokens.delete(db, 'wordpress');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    oauthTokens.delete(db, 'wordpress');
  });

  describe('GET /api/auth/wordpress/start', () => {
    it('returns 503 when env not configured', async () => {
      const orig = process.env.WORDPRESS_OAUTH_CLIENT_ID;
      delete process.env.WORDPRESS_OAUTH_CLIENT_ID;
      try {
        const res = await request(app).get('/api/auth/wordpress/start?platform=wordpress');
        expect(res.status).toBe(503);
      } finally {
        process.env.WORDPRESS_OAUTH_CLIENT_ID = orig;
      }
    });

    it('returns 400 for unknown platform', async () => {
      const res = await request(app).get('/api/auth/wordpress/start?platform=blogger');
      expect(res.status).toBe(400);
    });

    it('redirects to wordpress.com with the right OAuth params', async () => {
      const res = await request(app)
        .get('/api/auth/wordpress/start?platform=wordpress')
        .redirects(0);
      expect(res.status).toBe(302);
      const location = res.headers.location;
      expect(location).toMatch(/^https:\/\/public-api\.wordpress\.com\/oauth2\/authorize/);
      const url = new URL(location);
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('client_id')).toBe('wp-test-cid');
      expect(url.searchParams.get('state')).toMatch(/^[0-9a-f]{64}$/);
    });

    it('stores a pending state entry with platform=wordpress', async () => {
      const before = authTest.pendingStatesSize();
      await request(app).get('/api/auth/wordpress/start?platform=wordpress').redirects(0);
      expect(authTest.pendingStatesSize()).toBe(before + 1);
    });
  });

  describe('GET /api/auth/wordpress/callback', () => {
    async function startAndCaptureState(): Promise<string> {
      const res = await request(app)
        .get('/api/auth/wordpress/start?platform=wordpress')
        .redirects(0);
      const url = new URL(res.headers.location);
      return url.searchParams.get('state')!;
    }

    it('redirects with oauth_error when user denies', async () => {
      const res = await request(app)
        .get('/api/auth/wordpress/callback?error=access_denied')
        .redirects(0);
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/oauth_error=access_denied/);
    });

    it('redirects with invalid_state for unknown state', async () => {
      const res = await request(app)
        .get('/api/auth/wordpress/callback?code=x&state=invalid')
        .redirects(0);
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/oauth_error=invalid_state/);
    });

    it('persists sentinel-shaped tokens on successful callback', async () => {
      const state = await startAndCaptureState();
      const tokenJson = JSON.stringify({ token: 'wp-access-xyz', site_id: '12345' });
      vi.spyOn(wordpressOAuth.wordpressAuthStrategy, 'exchangeCodeForTokens').mockResolvedValue({
        refresh_token: 'wp-access-xyz',
        access_token: tokenJson,
        expires_at: null,
      });

      const res = await request(app)
        .get(`/api/auth/wordpress/callback?code=valid&state=${state}`)
        .redirects(0);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/admin.html?connected=wordpress');

      const stored = oauthTokens.get(db, 'wordpress');
      expect(stored?.refresh_token).toBe('wp-access-xyz');
      expect(stored?.access_token).toBe(tokenJson);
      // Adapter-side parser should recover { token, site_id } from this row
      const parsed = wordpressOAuth.parseWordPressToken(stored!);
      expect(parsed).toEqual({ token: 'wp-access-xyz', site_id: '12345' });
    });

    it('rejects state on second use (one-shot)', async () => {
      const state = await startAndCaptureState();
      vi.spyOn(wordpressOAuth.wordpressAuthStrategy, 'exchangeCodeForTokens').mockResolvedValue({
        refresh_token: 't',
        access_token: JSON.stringify({ token: 't', site_id: '1' }),
        expires_at: null,
      });

      const first = await request(app)
        .get(`/api/auth/wordpress/callback?code=x&state=${state}`)
        .redirects(0);
      expect(first.headers.location).toBe('/admin.html?connected=wordpress');

      const second = await request(app)
        .get(`/api/auth/wordpress/callback?code=x&state=${state}`)
        .redirects(0);
      expect(second.headers.location).toMatch(/oauth_error=invalid_state/);
    });

    it('redirects with stable error code on token exchange failure', async () => {
      const state = await startAndCaptureState();
      vi.spyOn(wordpressOAuth.wordpressAuthStrategy, 'exchangeCodeForTokens').mockRejectedValue(
        new Error('WordPress.com token exchange failed (400): invalid_request'),
      );

      const res = await request(app)
        .get(`/api/auth/wordpress/callback?code=bad&state=${state}`)
        .redirects(0);
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/oauth_error=exchange_failed/);
    });

    it('rejects state minted by a different provider', async () => {
      const twitterStart = await request(app)
        .get('/api/auth/twitter/start?platform=twitter')
        .redirects(0);
      if (twitterStart.status !== 302) return; // skip if twitter env not set
      const twitterState = new URL(twitterStart.headers.location).searchParams.get('state')!;

      const res = await request(app)
        .get(`/api/auth/wordpress/callback?code=x&state=${twitterState}`)
        .redirects(0);
      expect(res.headers.location).toMatch(/oauth_error=invalid_state/);
    });
  });

  describe('DELETE /api/auth/oauth/wordpress', () => {
    it('clears stored tokens and is idempotent', async () => {
      oauthTokens.save(db, 'wordpress', {
        refresh_token: 'to-clear',
        access_token: JSON.stringify({ token: 'to-clear', site_id: '1' }),
      });
      const res = await request(app).delete('/api/auth/oauth/wordpress');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(oauthTokens.exists(db, 'wordpress')).toBe(false);

      // second call should still 200 (delete is no-op when row absent)
      const res2 = await request(app).delete('/api/auth/oauth/wordpress');
      expect(res2.status).toBe(200);
    });
  });
});
