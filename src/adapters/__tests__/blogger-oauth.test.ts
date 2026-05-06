import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { google } from 'googleapis';
import { BloggerAdapter } from '../blogger';
import { db } from '../../db';
import { oauthTokens } from '../../db/oauth-tokens';

const ORIG_ENV = { ...process.env };

function setOAuthEnv() {
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-cid';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-secret';
  process.env.OAUTH_REDIRECT_URI = 'http://localhost:3000/api/auth/google/callback';
}

describe('BloggerAdapter — three-tier auth resolution', () => {
  let adapter: BloggerAdapter;

  beforeEach(() => {
    adapter = new BloggerAdapter();
    process.env = { ...ORIG_ENV };
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    delete process.env.BLOGGER_BLOG_ID;
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    delete process.env.OAUTH_REDIRECT_URI;
    oauthTokens.delete(db, 'blogger');
  });

  afterEach(() => {
    oauthTokens.delete(db, 'blogger');
    vi.restoreAllMocks();
  });

  it('returns BLOGGER_BLOG_ID error when blogId missing', async () => {
    const res = await adapter.testConnection();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/BLOGGER_BLOG_ID/);
  });

  it('returns auth-hint when only blogId set', async () => {
    process.env.BLOGGER_BLOG_ID = 'b1';
    const res = await adapter.testConnection();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Connect with Google|GOOGLE_APPLICATION_CREDENTIALS_JSON/);
  });

  it('uses oauth_tokens when present (takes precedence over service account)', async () => {
    process.env.BLOGGER_BLOG_ID = 'b1';
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = '{}';
    setOAuthEnv();
    oauthTokens.save(db, 'blogger', { refresh_token: 'r-stored' });

    const blogsGet = vi.fn().mockResolvedValue({ data: { id: 'b1', name: 'Test Blog' } });
    const bloggerSpy = vi.spyOn(google, 'blogger').mockReturnValue({
      blogs: { get: blogsGet },
    } as any);

    const res = await adapter.testConnection();
    expect(res.ok).toBe(true);

    // Verify auth was an OAuth2Client (has setCredentials method) — i.e. service
    // account fallback was not used.
    const authArg = bloggerSpy.mock.calls[0][0]?.auth;
    expect(authArg).toBeDefined();
    expect(typeof (authArg as any).setCredentials).toBe('function');
  });

  it('falls back to service account when oauth_tokens absent', async () => {
    process.env.BLOGGER_BLOG_ID = 'b1';
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = '{"type":"service_account"}';

    const blogsGet = vi.fn().mockResolvedValue({ data: { id: 'b1' } });
    const bloggerSpy = vi.spyOn(google, 'blogger').mockReturnValue({
      blogs: { get: blogsGet },
    } as any);

    const res = await adapter.testConnection();
    expect(res.ok).toBe(true);

    // Verify GoogleAuth (service-account) was used — has getClient method
    const authArg = bloggerSpy.mock.calls[0][0]?.auth as any;
    expect(authArg).toBeDefined();
    expect(typeof authArg.getClient).toBe('function');
  });

  it('clears oauth_tokens when grant is invalid (testConnection)', async () => {
    process.env.BLOGGER_BLOG_ID = 'b1';
    setOAuthEnv();
    oauthTokens.save(db, 'blogger', { refresh_token: 'will-be-revoked' });

    const blogsGet = vi.fn().mockRejectedValue(new Error('invalid_grant: Token has been expired or revoked.'));
    vi.spyOn(google, 'blogger').mockReturnValue({
      blogs: { get: blogsGet },
    } as any);

    const res = await adapter.testConnection();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Session revoked|reconnect/);
    expect(oauthTokens.exists(db, 'blogger')).toBe(false);
  });

  it('does not clear service-account auth on errors (only OAuth)', async () => {
    process.env.BLOGGER_BLOG_ID = 'b1';
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = '{"type":"service_account"}';

    const blogsGet = vi.fn().mockRejectedValue(new Error('invalid_grant'));
    vi.spyOn(google, 'blogger').mockReturnValue({
      blogs: { get: blogsGet },
    } as any);

    const res = await adapter.testConnection();
    expect(res.ok).toBe(false);
    // No oauth_tokens row to clear in the first place; just verify error is surfaced raw
    expect(res.error).toMatch(/invalid_grant/);
  });

  it('falls through to service account when oauth_tokens row is corrupt (decryption fails)', async () => {
    process.env.BLOGGER_BLOG_ID = 'b1';
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = '{"type":"service_account"}';
    setOAuthEnv();

    // Manually insert a row with garbage ciphertext that cannot be decrypted.
    // Bypasses oauthTokens.save (which would encrypt valid input).
    db.prepare(`
      INSERT OR REPLACE INTO oauth_tokens (platform, refresh_token, updated_at)
      VALUES ('blogger', 'corrupt-ciphertext-that-will-fail-aes-gcm-decrypt', CURRENT_TIMESTAMP)
    `).run();

    const blogsGet = vi.fn().mockResolvedValue({ data: { id: 'b1' } });
    const bloggerSpy = vi.spyOn(google, 'blogger').mockReturnValue({
      blogs: { get: blogsGet },
    } as any);

    const res = await adapter.testConnection();
    expect(res.ok).toBe(true);

    // Verify service-account auth was used (not OAuth client)
    const authArg = bloggerSpy.mock.calls[0][0]?.auth as any;
    expect(typeof authArg.getClient).toBe('function'); // GoogleAuth has getClient

    // Corrupt row should have been cleared
    expect(oauthTokens.exists(db, 'blogger')).toBe(false);
  });

  it('publish() uses oauth_tokens when present and surfaces invalid_grant', async () => {
    process.env.BLOGGER_BLOG_ID = 'b1';
    setOAuthEnv();
    oauthTokens.save(db, 'blogger', { refresh_token: 'r-pub' });

    const insert = vi.fn().mockRejectedValue(new Error('invalid_grant'));
    vi.spyOn(google, 'blogger').mockReturnValue({
      posts: { insert },
    } as any);

    const res = await adapter.publish({
      title: 't',
      markdownContent: 'hi',
      publishStatus: 'draft',
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Session revoked|reconnect/);
    expect(oauthTokens.exists(db, 'blogger')).toBe(false);
  });
});
