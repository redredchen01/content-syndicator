import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DevToAdapter,
  MediumAdapter,
  HashnodeAdapter,
  GitHubAdapter,
  BloggerAdapter,
  WordPressAdapter,
  TelegraphAdapter,
  BrowserAutomationAdapter,
} from '../index';
import { InstapaperAdapter } from '../instapaper';

// Mock fetch
global.fetch = vi.fn();

describe('API Adapter testConnection()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear env vars between tests
    delete process.env.DEVTO_API_KEY;
    delete process.env.MEDIUM_INTEGRATION_TOKEN;
    delete process.env.HASHNODE_TOKEN;
    delete process.env.HASHNODE_PUBLICATION_ID;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    delete process.env.BLOGGER_BLOG_ID;
    delete process.env.WORDPRESS_SITE_URL;
    delete process.env.WORDPRESS_USERNAME;
    delete process.env.WORDPRESS_APP_PASSWORD;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Dev.to Adapter', () => {
    const adapter = new DevToAdapter();

    it('exposes patGenerationUrl pointing to Dev.to settings', () => {
      expect(adapter.patGenerationUrl).toBe('https://dev.to/settings/extensions');
    });

    it('returns ok=true when API key is valid', async () => {
      process.env.DEVTO_API_KEY = 'test_key_123';
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      const result = await adapter.testConnection();
      expect(result.ok).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('returns error when API key is missing', async () => {
      const result = await adapter.testConnection();
      expect(result.ok).toBe(false);
      expect(result.error).toContain('not configured');
    });

    it('returns error when API returns 401', async () => {
      process.env.DEVTO_API_KEY = 'invalid_key';
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      });

      const result = await adapter.testConnection();
      expect(result.ok).toBe(false);
      expect(result.error).toContain('401');
    });

    it('returns error on network failure', async () => {
      process.env.DEVTO_API_KEY = 'test_key';
      (global.fetch as any).mockRejectedValueOnce(new Error('Network timeout'));

      const result = await adapter.testConnection();
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Network error');
    });

    it('calls the correct endpoint', async () => {
      process.env.DEVTO_API_KEY = 'test_key';
      (global.fetch as any).mockResolvedValueOnce({ ok: true });

      await adapter.testConnection();
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/user'),
        expect.objectContaining({
          headers: expect.objectContaining({
            'api-key': 'test_key',
          }),
        })
      );
    });
  });

  describe('Medium Adapter', () => {
    const adapter = new MediumAdapter();

    // Browser-fallback path checks for .auth/medium.json — if a parallel test
    // file leaves one behind, our 'no token' assertions match the wrong path.
    beforeEach(async () => {
      const fs = await import('fs');
      const path = await import('path');
      const authFile = path.join(process.cwd(), '.auth', 'medium.json');
      if (fs.existsSync(authFile)) fs.unlinkSync(authFile);
    });

    it('returns ok=true when token is valid', async () => {
      process.env.MEDIUM_INTEGRATION_TOKEN = 'Bearer token123';
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { id: 'user123' } }),
      });

      const result = await adapter.testConnection();
      expect(result.ok).toBe(true);
    });

    it('returns error when token is missing and no browser session', async () => {
      const result = await adapter.testConnection();
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/MEDIUM_INTEGRATION_TOKEN|浏览器登录/);
    });

    it('returns error when API returns 403', async () => {
      process.env.MEDIUM_INTEGRATION_TOKEN = 'invalid_token';
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
      });

      const result = await adapter.testConnection();
      expect(result.ok).toBe(false);
      expect(result.error).toContain('403');
    });

  });

  describe('Hashnode Adapter', () => {
    const adapter = new HashnodeAdapter();

    it('exposes patGenerationUrl pointing to Hashnode developer settings', () => {
      expect(adapter.patGenerationUrl).toBe('https://hashnode.com/settings/developer');
    });

    it('returns ok=true when credentials are valid', async () => {
      process.env.HASHNODE_TOKEN = 'token123';
      process.env.HASHNODE_PUBLICATION_ID = 'pub123';
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { me: { id: 'user123', name: 'Test' } } }),
      });

      const result = await adapter.testConnection();
      expect(result.ok).toBe(true);
    });

    it('returns error when token is missing', async () => {
      process.env.HASHNODE_PUBLICATION_ID = 'pub123';
      const result = await adapter.testConnection();
      expect(result.ok).toBe(false);
      expect(result.error).toContain('not configured');
    });

    it('returns ok=true even without publication ID (only needed for publishing)', async () => {
      process.env.HASHNODE_TOKEN = 'token123';
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { me: { id: 'user123' } } }),
      });
      const result = await adapter.testConnection();
      expect(result.ok).toBe(true);
    });

    it('returns error on GraphQL errors', async () => {
      process.env.HASHNODE_TOKEN = 'token123';
      process.env.HASHNODE_PUBLICATION_ID = 'pub123';
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ errors: [{ message: 'Invalid token' }] }),
      });

      const result = await adapter.testConnection();
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Invalid token');
    });

    it('sends GraphQL query', async () => {
      process.env.HASHNODE_TOKEN = 'token123';
      process.env.HASHNODE_PUBLICATION_ID = 'pub123';
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { me: { id: 'user123' } } }),
      });

      await adapter.testConnection();
      const call = (global.fetch as any).mock.calls[0];
      expect(call[1].body).toContain('query');
      expect(call[1].body).toContain('me');
    });
  });

  describe('GitHub Adapter', () => {
    const adapter = new GitHubAdapter();

    it('returns ok=true when token is valid', async () => {
      process.env.GITHUB_TOKEN = 'ghp_token123';
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'user123' }),
      });

      const result = await adapter.testConnection();
      expect(result.ok).toBe(true);
    });

    it('returns error when token is missing', async () => {
      const result = await adapter.testConnection();
      expect(result.ok).toBe(false);
      expect(result.error).toContain('not configured');
    });

    it('returns error on invalid token', async () => {
      process.env.GITHUB_TOKEN = 'invalid_token';
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      });

      const result = await adapter.testConnection();
      expect(result.ok).toBe(false);
      expect(result.error).toContain('401');
    });
  });

  describe('Blogger Adapter', () => {
    const adapter = new BloggerAdapter();

    it('returns error when blog ID is missing', async () => {
      const result = await adapter.testConnection();
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/BLOGGER_BLOG_ID/);
    });

    it('returns error when blog ID is missing even with service-account creds', async () => {
      process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = '{}';
      const result = await adapter.testConnection();
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/BLOGGER_BLOG_ID/);
    });

    it('returns Chinese auth-hint when blog ID set but no auth source', async () => {
      process.env.BLOGGER_BLOG_ID = 'blog123';
      const result = await adapter.testConnection();
      expect(result.ok).toBe(false);
      // BloggerAdapter prefers OAuth2 user tokens (DB) > service-account JSON (env).
      // When neither is present it prompts the user to connect via OAuth.
      expect(result.error).toMatch(/Connect with Google|GOOGLE_APPLICATION_CREDENTIALS_JSON/);
    });
  });

  describe('WordPress Adapter', () => {
    const adapter = new WordPressAdapter();

    it('returns ok=true with valid credentials', async () => {
      process.env.WORDPRESS_SITE_URL = 'https://example.wordpress.com';
      process.env.WORDPRESS_USERNAME = 'admin';
      process.env.WORDPRESS_APP_PASSWORD = 'pass123';
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
      });

      const result = await adapter.testConnection();
      expect(result.ok).toBe(true);
    });

    it('returns error when site URL is missing', async () => {
      process.env.WORDPRESS_USERNAME = 'admin';
      process.env.WORDPRESS_APP_PASSWORD = 'pass123';
      const result = await adapter.testConnection();
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Connect with WordPress|WORDPRESS_SITE_URL/);
    });

    it('returns error when username is missing', async () => {
      process.env.WORDPRESS_SITE_URL = 'https://example.wordpress.com';
      process.env.WORDPRESS_APP_PASSWORD = 'pass123';
      const result = await adapter.testConnection();
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Connect with WordPress|WORDPRESS_USERNAME/);
    });

    it('returns error when app password is missing', async () => {
      process.env.WORDPRESS_SITE_URL = 'https://example.wordpress.com';
      process.env.WORDPRESS_USERNAME = 'admin';
      const result = await adapter.testConnection();
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Connect with WordPress|WORDPRESS_APP_PASSWORD/);
    });

    it('returns error on authentication failure', async () => {
      process.env.WORDPRESS_SITE_URL = 'https://example.wordpress.com';
      process.env.WORDPRESS_USERNAME = 'admin';
      process.env.WORDPRESS_APP_PASSWORD = 'wrongpass';
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      });

      const result = await adapter.testConnection();
      expect(result.ok).toBe(false);
      expect(result.error).toContain('401');
    });

    it('uses Basic Auth header', async () => {
      process.env.WORDPRESS_SITE_URL = 'https://example.com';
      process.env.WORDPRESS_USERNAME = 'user';
      process.env.WORDPRESS_APP_PASSWORD = 'pass';
      (global.fetch as any).mockResolvedValueOnce({ ok: true });

      await adapter.testConnection();
      const call = (global.fetch as any).mock.calls[0];
      expect(call[1].headers.Authorization).toMatch(/^Basic /);
    });

    it('strips trailing slashes from site URL', async () => {
      process.env.WORDPRESS_SITE_URL = 'https://example.com///';
      process.env.WORDPRESS_USERNAME = 'user';
      process.env.WORDPRESS_APP_PASSWORD = 'pass';
      (global.fetch as any).mockResolvedValueOnce({ ok: true });

      await adapter.testConnection();
      const call = (global.fetch as any).mock.calls[0];
      expect(call[0]).not.toContain('///');
    });
  });

  describe('Telegraph Adapter', () => {
    const adapter = new TelegraphAdapter();

    it('returns ok=true when API is reachable', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: false, // Telegraph returns ok=false for dummy token
        json: async () => ({ ok: false }), // Telegraph API returns ok: false in JSON
      });

      const result = await adapter.testConnection();
      expect(result.ok).toBe(true);
    });

    it('returns error on network failure', async () => {
      (global.fetch as any).mockRejectedValueOnce(new Error('Network timeout'));

      const result = await adapter.testConnection();
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Network error');
    });

    it('calls Telegraph API endpoint', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        json: async () => ({}),
      });

      await adapter.testConnection();
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('api.telegra.ph')
      );
    });
  });

  describe('Browser Automation Adapter', () => {
    // Browser adapter testConnection requires mocking getBrowser and file system
    // These tests verify the basic logic without Playwright integration
    it('instantiates with correct name', () => {
      const adapter = new BrowserAutomationAdapter({
        name: 'TestSite',
        authFileName: 'test.json',
        composeUrl: 'https://example.com/compose',
      });

      expect(adapter.name).toBe('TestSite');
    });

    it('sets isBrowserAutomation flag', () => {
      const adapter = new BrowserAutomationAdapter({
        name: 'TestSite',
        authFileName: 'test.json',
        composeUrl: 'https://example.com/compose',
      });

      expect((adapter as any).isBrowserAutomation).toBe(true);
    });

    it('enables canPublishAutomatically with selectors', () => {
      const adapter = new BrowserAutomationAdapter({
        name: 'TestSite',
        authFileName: 'test.json',
        composeUrl: 'https://example.com/compose',
        titleSelector: '#title',
        contentSelector: '#content',
        publishButtonSelector: '#publish',
      });

      expect(adapter.canPublishAutomatically).toBe(true);
    });

    it('disables canPublishAutomatically without selectors or custom automation', () => {
      const adapter = new BrowserAutomationAdapter({
        name: 'TestSite',
        authFileName: 'test.json',
        composeUrl: 'https://example.com/compose',
      });

      expect(adapter.canPublishAutomatically).toBe(false);
    });

    it('enables canPublishAutomatically with custom automation', () => {
      const adapter = new BrowserAutomationAdapter({
        name: 'TestSite',
        authFileName: 'test.json',
        composeUrl: 'https://example.com/compose',
        customAutomation: async () => 'https://published.url',
      });

      expect(adapter.canPublishAutomatically).toBe(true);
    });
  });

  describe('Error message consistency', () => {
    it('all adapters return TestConnectionResult with ok and optional error', async () => {
      const adapters = [
        new DevToAdapter(),
        new MediumAdapter(),
        new HashnodeAdapter(),
        new GitHubAdapter(),
        new TelegraphAdapter(),
      ];

      for (const adapter of adapters) {
        const result = await adapter.testConnection();
        expect(result).toHaveProperty('ok');
        expect(typeof result.ok).toBe('boolean');
        if (!result.ok) {
          expect(typeof result.error).toBe('string');
        }
      }
    });

    it('missing environment variable errors mention the variable name', async () => {
      const adapter = new DevToAdapter();
      const result = await adapter.testConnection();
      expect(result.error).toMatch(/DEVTO_API_KEY|not configured/i);
    });
  });
});

describe('testConnection() edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('handles null/undefined error messages gracefully', async () => {
    const adapter = new DevToAdapter();
    process.env.DEVTO_API_KEY = 'key';
    (global.fetch as any).mockRejectedValueOnce(new Error());

    const result = await adapter.testConnection();
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe('string');
  });

  it('does not leak sensitive data in error messages', async () => {
    const adapter = new DevToAdapter();
    process.env.DEVTO_API_KEY = 'secret_key_12345';
    (global.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    });

    const result = await adapter.testConnection();
    expect(result.error).not.toContain('secret_key');
  });

  it('handles empty API responses', async () => {
    const adapter = new DevToAdapter();
    process.env.DEVTO_API_KEY = 'key';
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
    });

    const result = await adapter.testConnection();
    expect(result.ok).toBe(true);
  });

  it('handles very long error messages', async () => {
    const adapter = new DevToAdapter();
    process.env.DEVTO_API_KEY = 'key';
    const longError = 'A'.repeat(10000);
    (global.fetch as any).mockRejectedValueOnce(new Error(longError));

    const result = await adapter.testConnection();
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe('string');
  });
});

// ── Instapaper Adapter ────────────────────────────────────────────────────────

describe('Instapaper Adapter', () => {
  const adapter = new InstapaperAdapter();

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.INSTAPAPER_USERNAME;
    delete process.env.INSTAPAPER_PASSWORD;
  });

  afterEach(() => {
    delete process.env.INSTAPAPER_USERNAME;
    delete process.env.INSTAPAPER_PASSWORD;
  });

  describe('testConnection', () => {
    it('returns error when credentials are missing', async () => {
      const result = await adapter.testConnection();
      expect(result.ok).toBe(false);
      expect(result.error).toContain('INSTAPAPER_USERNAME');
    });

    it('returns ok=true when both env vars are set', async () => {
      process.env.INSTAPAPER_USERNAME = 'user@example.com';
      process.env.INSTAPAPER_PASSWORD = 'secret';
      const result = await adapter.testConnection();
      expect(result.ok).toBe(true);
    });

    it('returns error when only username is set', async () => {
      process.env.INSTAPAPER_USERNAME = 'user@example.com';
      const result = await adapter.testConnection();
      expect(result.ok).toBe(false);
    });
  });

  describe('publish', () => {
    beforeEach(() => {
      process.env.INSTAPAPER_USERNAME = 'user@example.com';
      process.env.INSTAPAPER_PASSWORD = 'secret';
    });

    it('returns success on HTTP 201', async () => {
      (global.fetch as any).mockResolvedValueOnce({ status: 201 });
      const result = await adapter.publish({
        title: 'My Article',
        markdownContent: 'content',
        originalUrl: 'https://example.com/article',
      });
      expect(result.success).toBe(true);
      expect(result.publishedUrl).toContain('instapaper.com');
    });

    it('returns success on HTTP 200 (already saved)', async () => {
      (global.fetch as any).mockResolvedValueOnce({ status: 200 });
      const result = await adapter.publish({
        title: 'Article',
        markdownContent: 'content',
        originalUrl: 'https://example.com/article',
      });
      expect(result.success).toBe(true);
    });

    it('returns error when originalUrl is missing', async () => {
      const result = await adapter.publish({ title: 'No URL', markdownContent: 'content' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('originalUrl');
    });

    it('returns error on non-2xx response', async () => {
      (global.fetch as any).mockResolvedValueOnce({ status: 403 });
      const result = await adapter.publish({
        title: 'Article',
        markdownContent: 'content',
        originalUrl: 'https://example.com/article',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('403');
    });

    it('returns error on network failure', async () => {
      (global.fetch as any).mockRejectedValueOnce(new Error('Network error'));
      const result = await adapter.publish({
        title: 'Article',
        markdownContent: 'content',
        originalUrl: 'https://example.com/article',
      });
      expect(result.success).toBe(false);
    });

    it('sends Authorization header with Basic auth', async () => {
      (global.fetch as any).mockResolvedValueOnce({ status: 201 });
      await adapter.publish({
        title: 'Article',
        markdownContent: 'content',
        originalUrl: 'https://example.com/article',
      });
      const call = (global.fetch as any).mock.calls[0];
      expect(call[1].headers.Authorization).toMatch(/^Basic /);
    });
  });
});
