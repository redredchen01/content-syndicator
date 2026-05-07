import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GitHubAdapter } from '../github';
import { db } from '../../db';
import { oauthTokens } from '../../db/oauth-tokens';

const ORIG_ENV = { ...process.env };

describe('GitHubAdapter — two-tier auth resolution', () => {
  let adapter: GitHubAdapter;
  const fetchMock = vi.fn();

  beforeEach(() => {
    adapter = new GitHubAdapter();
    process.env = { ...ORIG_ENV };
    delete process.env.GITHUB_TOKEN;
    oauthTokens.delete(db, 'github');
    fetchMock.mockReset();
    global.fetch = fetchMock as any;
  });

  afterEach(() => {
    oauthTokens.delete(db, 'github');
    vi.restoreAllMocks();
  });

  // ── Auth source resolution ────────────────────────────────────────────

  it('returns "API key not configured" when nothing is set', async () => {
    const res = await adapter.testConnection();
    expect(res.ok).toBe(false);
    expect(res.error).toBe('API key not configured');
  });

  it('uses Bearer header when oauth_tokens.github exists', async () => {
    oauthTokens.save(db, 'github', {
      refresh_token: 'gh-access',
      access_token: 'gh-access',
      expires_at: null,
    });
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });

    const res = await adapter.testConnection();
    expect(res.ok).toBe(true);
    const init = fetchMock.mock.calls[0][1] as any;
    expect(init.headers.Authorization).toBe('Bearer gh-access');
  });

  it('uses `token <pat>` header when only GITHUB_TOKEN env is set', async () => {
    process.env.GITHUB_TOKEN = 'pat_legacy';
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });

    const res = await adapter.testConnection();
    expect(res.ok).toBe(true);
    const init = fetchMock.mock.calls[0][1] as any;
    expect(init.headers.Authorization).toBe('token pat_legacy');
  });

  it('OAuth row takes precedence over GITHUB_TOKEN env', async () => {
    oauthTokens.save(db, 'github', {
      refresh_token: 'gh-access',
      access_token: 'gh-access',
      expires_at: null,
    });
    process.env.GITHUB_TOKEN = 'pat_legacy';
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });

    await adapter.testConnection();
    const init = fetchMock.mock.calls[0][1] as any;
    expect(init.headers.Authorization).toBe('Bearer gh-access');
  });

  // ── Publish wiring ────────────────────────────────────────────────────

  it('publishes a Gist via OAuth Bearer header', async () => {
    oauthTokens.save(db, 'github', {
      refresh_token: 'gh-access',
      access_token: 'gh-access',
      expires_at: null,
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ html_url: 'https://gist.github.com/u/abc123' }),
    });

    const res = await adapter.publish({
      title: 'Hello',
      markdownContent: 'Body',
      publishStatus: 'public',
    });
    expect(res.success).toBe(true);
    expect((res as any).publishedUrl).toBe('https://gist.github.com/u/abc123');
    const init = fetchMock.mock.calls[0][1] as any;
    expect(init.headers.Authorization).toBe('Bearer gh-access');
  });

  it('publishes a Gist via PAT `token` header', async () => {
    process.env.GITHUB_TOKEN = 'pat_legacy';
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ html_url: 'https://gist.github.com/u/def456' }),
    });

    const res = await adapter.publish({
      title: 'Hello',
      markdownContent: 'Body',
      publishStatus: 'public',
    });
    expect(res.success).toBe(true);
    const init = fetchMock.mock.calls[0][1] as any;
    expect(init.headers.Authorization).toBe('token pat_legacy');
  });

  // ── 401 path: clear OAuth row, allow fallback ─────────────────────────

  it('clears OAuth row on 401 during testConnection', async () => {
    oauthTokens.save(db, 'github', {
      refresh_token: 'gh-access',
      access_token: 'gh-access',
      expires_at: null,
    });
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized' });

    const res = await adapter.testConnection();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/session revoked/i);
    expect(oauthTokens.exists(db, 'github')).toBe(false);
  });

  it('clears OAuth row on 401 during publish', async () => {
    oauthTokens.save(db, 'github', {
      refresh_token: 'gh-access',
      access_token: 'gh-access',
      expires_at: null,
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ message: 'Bad credentials' }),
    });

    const res = await adapter.publish({
      title: 'X',
      markdownContent: 'Y',
      publishStatus: 'public',
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/session revoked/i);
    expect(oauthTokens.exists(db, 'github')).toBe(false);
  });

  it('falls back to PAT immediately after OAuth row is cleared (no restart)', async () => {
    oauthTokens.save(db, 'github', {
      refresh_token: 'gh-access',
      access_token: 'gh-access',
      expires_at: null,
    });
    process.env.GITHUB_TOKEN = 'pat_legacy';

    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized' })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });

    const first = await adapter.testConnection();
    expect(first.ok).toBe(false);
    expect(oauthTokens.exists(db, 'github')).toBe(false);

    const second = await adapter.testConnection();
    expect(second.ok).toBe(true);
    const init2 = fetchMock.mock.calls[1][1] as any;
    expect(init2.headers.Authorization).toBe('token pat_legacy');
  });

  // ── Network error stays transient (does not clear OAuth row) ──────────

  it('treats network errors as transient', async () => {
    oauthTokens.save(db, 'github', {
      refresh_token: 'gh-access',
      access_token: 'gh-access',
      expires_at: null,
    });
    fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    const res = await adapter.testConnection();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Network error/);
    expect(oauthTokens.exists(db, 'github')).toBe(true);
  });
});
