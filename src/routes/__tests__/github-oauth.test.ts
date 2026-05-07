import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

// Set OAuth env BEFORE importing app/server so the route module sees them
process.env.GITHUB_OAUTH_CLIENT_ID = 'gh-test-cid';
process.env.GITHUB_OAUTH_CLIENT_SECRET = 'gh-test-secret';
process.env.GITHUB_OAUTH_REDIRECT_URI = 'http://localhost:3000/api/auth/github/callback';

import { app } from '../../server';
import { db } from '../../db';
import { oauthTokens } from '../../db/oauth-tokens';
import { __test as authTest } from '../auth';
import * as githubOAuth from '../../services/github-oauth';

describe('GitHub OAuth routes', () => {
  beforeEach(() => {
    authTest.clearPendingStates();
    oauthTokens.delete(db, 'github');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    oauthTokens.delete(db, 'github');
  });

  describe('GET /api/auth/github/start', () => {
    it('returns 503 when env not configured', async () => {
      const orig = process.env.GITHUB_OAUTH_CLIENT_ID;
      delete process.env.GITHUB_OAUTH_CLIENT_ID;
      try {
        const res = await request(app).get('/api/auth/github/start?platform=github');
        expect(res.status).toBe(503);
      } finally {
        process.env.GITHUB_OAUTH_CLIENT_ID = orig;
      }
    });

    it('returns 400 for unknown platform', async () => {
      const res = await request(app).get('/api/auth/github/start?platform=blogger');
      expect(res.status).toBe(400);
    });

    it('redirects to github.com authorize with gist scope and state', async () => {
      const res = await request(app)
        .get('/api/auth/github/start?platform=github')
        .redirects(0);
      expect(res.status).toBe(302);
      const location = res.headers.location;
      expect(location).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize/);
      const url = new URL(location);
      expect(url.searchParams.get('client_id')).toBe('gh-test-cid');
      expect(url.searchParams.get('scope')).toBe('gist');
      expect(url.searchParams.get('state')).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('GET /api/auth/github/callback', () => {
    async function startAndCaptureState(): Promise<string> {
      const res = await request(app)
        .get('/api/auth/github/start?platform=github')
        .redirects(0);
      const url = new URL(res.headers.location);
      return url.searchParams.get('state')!;
    }

    it('redirects with oauth_error when user denies', async () => {
      const res = await request(app)
        .get('/api/auth/github/callback?error=access_denied')
        .redirects(0);
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/oauth_error=access_denied/);
    });

    it('redirects with invalid_state for unknown state', async () => {
      const res = await request(app)
        .get('/api/auth/github/callback?code=x&state=invalid')
        .redirects(0);
      expect(res.headers.location).toMatch(/oauth_error=invalid_state/);
    });

    it('persists sentinel-shaped tokens on successful callback', async () => {
      const state = await startAndCaptureState();
      vi.spyOn(githubOAuth.githubAuthStrategy, 'exchangeCodeForTokens').mockResolvedValue({
        refresh_token: 'gh-access-xyz',
        access_token: 'gh-access-xyz',
        expires_at: null,
      });

      const res = await request(app)
        .get(`/api/auth/github/callback?code=valid&state=${state}`)
        .redirects(0);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/admin.html?connected=github');

      const stored = oauthTokens.get(db, 'github');
      expect(stored?.refresh_token).toBe('gh-access-xyz');
      expect(stored?.access_token).toBe('gh-access-xyz');
    });

    it('rejects state on second use (one-shot)', async () => {
      const state = await startAndCaptureState();
      vi.spyOn(githubOAuth.githubAuthStrategy, 'exchangeCodeForTokens').mockResolvedValue({
        refresh_token: 't',
        access_token: 't',
        expires_at: null,
      });

      const first = await request(app)
        .get(`/api/auth/github/callback?code=x&state=${state}`)
        .redirects(0);
      expect(first.headers.location).toBe('/admin.html?connected=github');

      const second = await request(app)
        .get(`/api/auth/github/callback?code=x&state=${state}`)
        .redirects(0);
      expect(second.headers.location).toMatch(/oauth_error=invalid_state/);
    });

    it('maps insufficient-scope error to oauth_error=insufficient_scope', async () => {
      const state = await startAndCaptureState();
      vi.spyOn(githubOAuth.githubAuthStrategy, 'exchangeCodeForTokens').mockRejectedValue(
        new Error('Insufficient scope: GitHub did not grant gist permission'),
      );

      const res = await request(app)
        .get(`/api/auth/github/callback?code=bad&state=${state}`)
        .redirects(0);
      expect(res.headers.location).toMatch(/oauth_error=insufficient_scope/);
    });

    it('maps generic exchange errors to oauth_error=exchange_failed', async () => {
      const state = await startAndCaptureState();
      vi.spyOn(githubOAuth.githubAuthStrategy, 'exchangeCodeForTokens').mockRejectedValue(
        new Error('GitHub token exchange failed: bad_verification_code'),
      );

      const res = await request(app)
        .get(`/api/auth/github/callback?code=bad&state=${state}`)
        .redirects(0);
      expect(res.headers.location).toMatch(/oauth_error=exchange_failed/);
    });
  });

  describe('DELETE /api/auth/oauth/github', () => {
    it('clears stored tokens', async () => {
      oauthTokens.save(db, 'github', { refresh_token: 'to-clear' });
      const res = await request(app).delete('/api/auth/oauth/github');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(oauthTokens.exists(db, 'github')).toBe(false);
    });
  });
});

