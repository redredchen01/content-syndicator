import { describe, it, expect, beforeEach, afterEach, vi, beforeAll } from 'vitest';
import request from 'supertest';

// Set OAuth env BEFORE importing app/server so the route module reads them
process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-cid.apps.googleusercontent.com';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-secret';
process.env.OAUTH_REDIRECT_URI = 'http://localhost:3000/api/auth/google/callback';

import { app } from '../../server';
import { db } from '../../db';
import { oauthTokens } from '../../db/oauth-tokens';
import { __test as authTest } from '../auth';

describe('Google OAuth routes', () => {
  beforeEach(() => {
    authTest.clearPendingStates();
    oauthTokens.delete(db, 'blogger');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    oauthTokens.delete(db, 'blogger');
  });

  describe('GET /api/auth/google/start', () => {
    it('returns 503 when OAuth env not configured', async () => {
      const orig = process.env.GOOGLE_OAUTH_CLIENT_ID;
      delete process.env.GOOGLE_OAUTH_CLIENT_ID;
      try {
        const res = await request(app).get('/api/auth/google/start?platform=blogger');
        expect(res.status).toBe(503);
        expect(res.body.error).toMatch(/not configured/);
      } finally {
        process.env.GOOGLE_OAUTH_CLIENT_ID = orig;
      }
    });

    it('returns 400 for unknown platform', async () => {
      const res = await request(app).get('/api/auth/google/start?platform=unknown');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Unknown OAuth platform/);
    });

    it('returns 302 to Google with proper params for blogger', async () => {
      const res = await request(app)
        .get('/api/auth/google/start?platform=blogger')
        .redirects(0);
      expect(res.status).toBe(302);
      const location = res.headers.location;
      expect(location).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2/);
      const url = new URL(location);
      expect(url.searchParams.get('access_type')).toBe('offline');
      expect(url.searchParams.get('prompt')).toBe('consent');
      expect(url.searchParams.get('state')).toMatch(/^[0-9a-f]{64}$/);
      expect(url.searchParams.get('scope')).toContain('blogger');
    });

    it('stores a pending state per request', async () => {
      const before = authTest.pendingStatesSize();
      await request(app).get('/api/auth/google/start?platform=blogger').redirects(0);
      expect(authTest.pendingStatesSize()).toBe(before + 1);
    });
  });

  describe('GET /api/auth/google/callback', () => {
    async function startAndCaptureState(): Promise<string> {
      const res = await request(app)
        .get('/api/auth/google/start?platform=blogger')
        .redirects(0);
      const url = new URL(res.headers.location);
      return url.searchParams.get('state')!;
    }

    it('redirects with oauth_error when user denies', async () => {
      const res = await request(app)
        .get('/api/auth/google/callback?error=access_denied')
        .redirects(0);
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/oauth_error=access_denied/);
    });

    it('returns 400 with no code or state', async () => {
      const res = await request(app).get('/api/auth/google/callback');
      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid state', async () => {
      const res = await request(app).get('/api/auth/google/callback?code=x&state=invalid');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid or expired state/);
    });

    it('rejects state on second use (one-shot)', async () => {
      const state = await startAndCaptureState();

      // Mock the underlying OAuth2 client so the first call succeeds
      const googleapis = await import('googleapis');
      vi.spyOn(googleapis.google.auth.OAuth2.prototype, 'getToken').mockResolvedValue({
        tokens: { refresh_token: 'r1', access_token: 'a1', expiry_date: 1 },
        res: null,
      } as any);

      const first = await request(app)
        .get(`/api/auth/google/callback?code=valid&state=${state}`)
        .redirects(0);
      expect(first.status).toBe(302);
      expect(first.headers.location).toBe('/admin.html?connected=blogger');

      // Second use must fail
      const second = await request(app)
        .get(`/api/auth/google/callback?code=valid&state=${state}`)
        .redirects(0);
      expect(second.status).toBe(400);
    });

    it('persists tokens on successful callback', async () => {
      const state = await startAndCaptureState();
      const googleapis = await import('googleapis');
      vi.spyOn(googleapis.google.auth.OAuth2.prototype, 'getToken').mockResolvedValue({
        tokens: { refresh_token: 'persisted-r', access_token: 'a', expiry_date: 99 },
        res: null,
      } as any);

      const res = await request(app)
        .get(`/api/auth/google/callback?code=c&state=${state}`)
        .redirects(0);
      expect(res.status).toBe(302);
      const stored = oauthTokens.get(db, 'blogger');
      expect(stored?.refresh_token).toBe('persisted-r');
    });

    it('redirects with oauth_error when token exchange fails', async () => {
      const state = await startAndCaptureState();
      const googleapis = await import('googleapis');
      vi.spyOn(googleapis.google.auth.OAuth2.prototype, 'getToken').mockRejectedValue(
        new Error('invalid_grant'),
      );

      const res = await request(app)
        .get(`/api/auth/google/callback?code=bad&state=${state}`)
        .redirects(0);
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/oauth_error=invalid_grant/);
    });
  });

  describe('DELETE /api/auth/oauth/:platform', () => {
    it('clears stored tokens', async () => {
      oauthTokens.save(db, 'blogger', { refresh_token: 'to-be-deleted' });
      expect(oauthTokens.exists(db, 'blogger')).toBe(true);

      const res = await request(app).delete('/api/auth/oauth/blogger');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(oauthTokens.exists(db, 'blogger')).toBe(false);
    });

    it('returns 400 for unknown platform', async () => {
      const res = await request(app).delete('/api/auth/oauth/nope');
      expect(res.status).toBe(400);
    });

    it('is a no-op when nothing stored', async () => {
      const res = await request(app).delete('/api/auth/oauth/blogger');
      expect(res.status).toBe(200);
    });
  });
});
