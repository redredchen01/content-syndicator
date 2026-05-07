import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WordPressAdapter } from '../wordpress';
import { db } from '../../db';
import { oauthTokens } from '../../db/oauth-tokens';

const ORIG_ENV = { ...process.env };

function setOAuthEnv() {
  process.env.WORDPRESS_OAUTH_CLIENT_ID = 'wp-test-cid';
  process.env.WORDPRESS_OAUTH_CLIENT_SECRET = 'wp-test-secret';
  process.env.WORDPRESS_OAUTH_REDIRECT_URI = 'http://localhost:3000/api/auth/wordpress/callback';
}

function setAppPasswordEnv() {
  process.env.WORDPRESS_SITE_URL = 'https://my-self-hosted.example.com';
  process.env.WORDPRESS_USERNAME = 'admin';
  process.env.WORDPRESS_APP_PASSWORD = 'app-pass-123';
}

function makeOAuthRow() {
  oauthTokens.save(db, 'wordpress', {
    refresh_token: 'wp-access-xyz',
    access_token: JSON.stringify({ token: 'wp-access-xyz', site_id: '12345' }),
    expires_at: null,
  });
}

describe('WordPressAdapter — three-tier auth resolution', () => {
  let adapter: WordPressAdapter;
  const fetchMock = vi.fn();

  beforeEach(() => {
    adapter = new WordPressAdapter();
    process.env = { ...ORIG_ENV };
    delete process.env.WORDPRESS_SITE_URL;
    delete process.env.WORDPRESS_USERNAME;
    delete process.env.WORDPRESS_APP_PASSWORD;
    delete process.env.WORDPRESS_OAUTH_CLIENT_ID;
    delete process.env.WORDPRESS_OAUTH_CLIENT_SECRET;
    delete process.env.WORDPRESS_OAUTH_REDIRECT_URI;
    oauthTokens.delete(db, 'wordpress');
    fetchMock.mockReset();
    global.fetch = fetchMock as any;
  });

  afterEach(() => {
    oauthTokens.delete(db, 'wordpress');
    vi.restoreAllMocks();
  });

  // ── Tier resolution + setup hints ─────────────────────────────────────

  it('returns auth-hint when nothing configured', async () => {
    const res = await adapter.testConnection();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Connect with WordPress|WORDPRESS_SITE_URL/);
  });

  it('uses OAuth path when oauth_tokens row present (preferred over app password)', async () => {
    setOAuthEnv();
    setAppPasswordEnv();
    makeOAuthRow();
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });

    const res = await adapter.testConnection();
    expect(res.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('public-api.wordpress.com/wp/v2/sites/12345');
    expect((init as any).headers.Authorization).toBe('Bearer wp-access-xyz');
  });

  it('uses Application Password path when no OAuth row', async () => {
    setAppPasswordEnv();
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });

    const res = await adapter.testConnection();
    expect(res.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://my-self-hosted.example.com/wp-json/wp/v2/users/me');
    expect((init as any).headers.Authorization).toMatch(/^Basic /);
  });

  // ── Publish wiring ────────────────────────────────────────────────────

  it('publishes against wp.com /wp/v2/sites/{id}/posts via OAuth', async () => {
    makeOAuthRow();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ ID: 7, URL: 'https://example.wordpress.com/?p=7' }),
    });

    const res = await adapter.publish({
      title: 'Hello',
      markdownContent: 'Body',
      publishStatus: 'public',
    });
    expect(res.success).toBe(true);
    expect((res as any).publishedUrl).toBe('https://example.wordpress.com/?p=7');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('public-api.wordpress.com/wp/v2/sites/12345/posts');
    expect((init as any).method).toBe('POST');
  });

  it('publishes against self-hosted /wp-json/wp/v2/posts via App Password', async () => {
    setAppPasswordEnv();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ id: 5, link: 'https://my-self-hosted.example.com/?p=5' }),
    });

    const res = await adapter.publish({
      title: 'Hi',
      markdownContent: 'Body',
      publishStatus: 'public',
    });
    expect(res.success).toBe(true);
    expect((res as any).publishedUrl).toBe('https://my-self-hosted.example.com/?p=5');
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://my-self-hosted.example.com/wp-json/wp/v2/posts');
  });

  // ── Invalid token clears OAuth row → falls back next call ─────────────

  it('clears OAuth row on 401 invalid_token (testConnection)', async () => {
    makeOAuthRow();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized' });

    const res = await adapter.testConnection();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/session revoked/i);
    expect(oauthTokens.exists(db, 'wordpress')).toBe(false);
  });

  it('clears OAuth row on 401 during publish', async () => {
    makeOAuthRow();
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: 'authorization_required', message: 'token expired' }),
    });

    const res = await adapter.publish({
      title: 'X',
      markdownContent: 'Y',
      publishStatus: 'public',
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/session revoked/i);
    expect(oauthTokens.exists(db, 'wordpress')).toBe(false);
  });

  it('after OAuth row cleared, immediate next call falls back to App Password (no restart)', async () => {
    setAppPasswordEnv();
    makeOAuthRow();

    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized' })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const first = await adapter.testConnection();
    expect(first.ok).toBe(false);
    expect(oauthTokens.exists(db, 'wordpress')).toBe(false);

    const second = await adapter.testConnection();
    expect(second.ok).toBe(true);
    const [url2, init2] = fetchMock.mock.calls[1];
    expect(url2).toBe('https://my-self-hosted.example.com/wp-json/wp/v2/users/me');
    expect((init2 as any).headers.Authorization).toMatch(/^Basic /);
  });

  // ── Malformed OAuth row clean-up ──────────────────────────────────────

  it('clears OAuth row when access_token JSON is malformed and falls back', async () => {
    setAppPasswordEnv();
    oauthTokens.save(db, 'wordpress', {
      refresh_token: 'sentinel',
      access_token: 'not-json-at-all',
      expires_at: null,
    });
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });

    const res = await adapter.testConnection();
    expect(res.ok).toBe(true);
    expect(oauthTokens.exists(db, 'wordpress')).toBe(false);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://my-self-hosted.example.com/wp-json/wp/v2/users/me');
  });

  it('returns clear error when OAuth row malformed AND no fallback configured', async () => {
    oauthTokens.save(db, 'wordpress', {
      refresh_token: 'sentinel',
      access_token: 'not-json',
      expires_at: null,
    });

    const res = await adapter.testConnection();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Connect with WordPress|WORDPRESS_SITE_URL/);
    expect(oauthTokens.exists(db, 'wordpress')).toBe(false);
  });

  // ── Network failure path stays separate from token-revocation path ────

  it('treats network errors as transient (does not clear OAuth row)', async () => {
    makeOAuthRow();
    fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    const res = await adapter.testConnection();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Network error/);
    expect(oauthTokens.exists(db, 'wordpress')).toBe(true);
  });
});
