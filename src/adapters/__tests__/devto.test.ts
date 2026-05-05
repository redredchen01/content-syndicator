import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DevToAdapter } from '../devto';

global.fetch = vi.fn();

describe('DevToAdapter', () => {
  let adapter: DevToAdapter;

  beforeEach(() => {
    adapter = new DevToAdapter();
    vi.clearAllMocks();
    process.env.DEVTO_API_KEY = 'test-api-key-123';
  });

  afterEach(() => {
    delete process.env.DEVTO_API_KEY;
  });

  describe('Happy Path', () => {
    it('should successfully publish to Dev.to', async () => {
      const mockUrl = 'https://dev.to/user/test-post-123';
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ url: mockUrl }),
        status: 201,
      } as Response);

      const result = await adapter.publish({
        title: 'Test Post',
        markdownContent: 'This is a test post',
        originalUrl: 'https://example.com/article',
        publishStatus: 'public',
        tags: ['javascript', 'nodejs'],
        excerpt: 'A test post excerpt',
      });

      expect(result.success).toBe(true);
      expect(result.publishedUrl).toBe(mockUrl);
      expect(vi.mocked(global.fetch)).toHaveBeenCalledWith(
        'https://dev.to/api/articles',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'api-key': 'test-api-key-123',
          }),
        }),
      );
    });

    it('should publish as draft when publishStatus is draft', async () => {
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ url: 'https://dev.to/user/draft-post' }),
      } as Response);

      const result = await adapter.publish({
        title: 'Draft Post',
        markdownContent: 'Draft content',
        publishStatus: 'draft',
      });

      expect(result.success).toBe(true);
      const callArgs = vi.mocked(global.fetch).mock.calls[0][1] as RequestInit;
      const body = JSON.parse(callArgs.body as string);
      expect(body.article.published).toBe(false);
    });
  });

  describe('Error Handling', () => {
    it('should handle missing API key', async () => {
      delete process.env.DEVTO_API_KEY;

      const result = await adapter.publish({
        title: 'Test',
        markdownContent: 'Content',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('DEVTO_API_KEY');
    });

    it('should handle API errors from Dev.to', async () => {
      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        json: async () => ({ error: 'Invalid API key' }),
        status: 401,
      } as Response);

      const result = await adapter.publish({
        title: 'Test',
        markdownContent: 'Content',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid API key');
    });

    it('should handle network errors', async () => {
      vi.mocked(global.fetch).mockRejectedValue(new Error('Network timeout'));

      const result = await adapter.publish({
        title: 'Test',
        markdownContent: 'Content',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Network timeout');
    });

    it('should handle malformed JSON response', async () => {
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => { throw new Error('Invalid JSON'); },
      } as Response);

      const result = await adapter.publish({
        title: 'Test',
        markdownContent: 'Content',
      });

      expect(result.success).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    it('should handle tags as comma-separated string', async () => {
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ url: 'https://dev.to/user/tagged' }),
      } as Response);

      await adapter.publish({
        title: 'Tagged Post',
        markdownContent: 'Content',
        tags: ['javascript', 'web', 'programming'],
      });

      const callArgs = vi.mocked(global.fetch).mock.calls[0][1] as RequestInit;
      const body = JSON.parse(callArgs.body as string);
      expect(body.article.tags).toBe('javascript, web, programming');
    });

    it('should handle empty tags', async () => {
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ url: 'https://dev.to/user/no-tags' }),
      } as Response);

      await adapter.publish({
        title: 'No Tags Post',
        markdownContent: 'Content',
        tags: [],
      });

      const callArgs = vi.mocked(global.fetch).mock.calls[0][1] as RequestInit;
      const body = JSON.parse(callArgs.body as string);
      // Empty tags array results in empty string from join
      expect(body.article.tags).toBe('');
    });

    it('should include excerpt in request body', async () => {
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ url: 'https://dev.to/user/excerpt' }),
      } as Response);

      const excerpt = 'This is a short excerpt';
      await adapter.publish({
        title: 'Post with Excerpt',
        markdownContent: 'Full content here',
        excerpt,
      });

      const callArgs = vi.mocked(global.fetch).mock.calls[0][1] as RequestInit;
      const body = JSON.parse(callArgs.body as string);
      expect(body.article.description).toBe(excerpt);
    });

    it('should append original URL to markdown when provided', async () => {
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ url: 'https://dev.to/user/sourced' }),
      } as Response);

      const originalUrl = 'https://original.com/article';
      await adapter.publish({
        title: 'Sourced Post',
        markdownContent: 'Original content',
        originalUrl,
      });

      const callArgs = vi.mocked(global.fetch).mock.calls[0][1] as RequestInit;
      const body = JSON.parse(callArgs.body as string);
      expect(body.article.body_markdown).toContain(originalUrl);
    });

    it('should handle very long content', async () => {
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ url: 'https://dev.to/user/long' }),
      } as Response);

      const longContent = 'Lorem ipsum '.repeat(5000); // Very long content

      const result = await adapter.publish({
        title: 'Long Post',
        markdownContent: longContent,
      });

      expect(result.success).toBe(true);
    });
  });
});
