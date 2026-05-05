import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BloggerAdapter } from '../blogger';
import { google } from 'googleapis';

vi.mock('googleapis');

describe('BloggerAdapter', () => {
  let adapter: BloggerAdapter;
  let mockBlogger: any;

  beforeEach(() => {
    adapter = new BloggerAdapter();
    mockBlogger = {
      posts: {
        insert: vi.fn(),
      },
    };

    vi.mocked(google.blogger).mockReturnValue(mockBlogger);
    vi.mocked(google.auth.GoogleAuth).mockImplementation(() => ({}));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Happy Path', () => {
    it('should successfully publish to Blogger', async () => {
      const mockResponse = {
        data: {
          id: 'post-123',
          url: 'https://myblog.blogspot.com/2026/05/my-post.html',
        },
      };

      mockBlogger.posts.insert.mockResolvedValue(mockResponse);
      process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = JSON.stringify({ type: 'service_account' });
      process.env.BLOGGER_BLOG_ID = 'blog-456';

      const result = await adapter.publish({
        title: 'Test Post',
        markdownContent: 'This is a test post',
        originalUrl: 'https://example.com',
        publishStatus: 'draft',
        tags: ['test', 'nodejs'],
      });

      expect(result.success).toBe(true);
      expect(result.publishedUrl).toBe('https://myblog.blogspot.com/2026/05/my-post.html');
      expect(mockBlogger.posts.insert).toHaveBeenCalledWith({
        blogId: 'blog-456',
        isDraft: true,
        requestBody: expect.objectContaining({
          title: 'Test Post',
          labels: ['test', 'nodejs'],
        }),
      });
    });

    it('should publish in public status', async () => {
      mockBlogger.posts.insert.mockResolvedValue({
        data: {
          id: 'post-789',
          url: 'https://myblog.blogspot.com/2026/05/public-post.html',
        },
      });
      process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = JSON.stringify({ type: 'service_account' });
      process.env.BLOGGER_BLOG_ID = 'blog-456';

      const result = await adapter.publish({
        title: 'Public Post',
        markdownContent: 'Public content',
        publishStatus: 'public',
      });

      expect(result.success).toBe(true);
      expect(mockBlogger.posts.insert).toHaveBeenCalledWith({
        blogId: 'blog-456',
        isDraft: false,
        requestBody: expect.any(Object),
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle missing credentials gracefully', async () => {
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
      process.env.BLOGGER_BLOG_ID = 'blog-456';

      const result = await adapter.publish({
        title: 'Test',
        markdownContent: 'Content',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('GOOGLE_APPLICATION_CREDENTIALS_JSON');
    });

    it('should handle API errors', async () => {
      mockBlogger.posts.insert.mockRejectedValue(
        new Error('Invalid blog ID'),
      );
      process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = JSON.stringify({ type: 'service_account' });
      process.env.BLOGGER_BLOG_ID = 'invalid-blog';

      const result = await adapter.publish({
        title: 'Test Post',
        markdownContent: 'Test content',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid blog ID');
    });

    it('should handle authentication failures', async () => {
      mockBlogger.posts.insert.mockRejectedValue(
        new Error('401 Unauthorized'),
      );
      process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = JSON.stringify({ type: 'service_account' });
      process.env.BLOGGER_BLOG_ID = 'blog-456';

      const result = await adapter.publish({
        title: 'Test Post',
        markdownContent: 'Test content',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('401');
    });
  });

  describe('Edge Cases', () => {
    it('should handle special characters in title and content', async () => {
      mockBlogger.posts.insert.mockResolvedValue({
        data: {
          id: 'post-special',
          url: 'https://myblog.blogspot.com/2026/05/special.html',
        },
      });
      process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = JSON.stringify({ type: 'service_account' });
      process.env.BLOGGER_BLOG_ID = 'blog-456';

      const result = await adapter.publish({
        title: 'Test & "Special" <Characters>',
        markdownContent: '# Heading\n\nContent with **bold** & _italic_',
        tags: ['tag-with-dash', 'tag_with_underscore'],
      });

      expect(result.success).toBe(true);
      expect(mockBlogger.posts.insert).toHaveBeenCalled();
    });

    it('should handle very long content', async () => {
      mockBlogger.posts.insert.mockResolvedValue({
        data: {
          id: 'post-long',
          url: 'https://myblog.blogspot.com/2026/05/long.html',
        },
      });
      process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = JSON.stringify({ type: 'service_account' });
      process.env.BLOGGER_BLOG_ID = 'blog-456';

      const longContent = 'Lorem ipsum '.repeat(1000); // ~12KB content

      const result = await adapter.publish({
        title: 'Long Post',
        markdownContent: longContent,
      });

      expect(result.success).toBe(true);
    });

    it('should handle empty or minimal content', async () => {
      mockBlogger.posts.insert.mockResolvedValue({
        data: {
          id: 'post-minimal',
          url: 'https://myblog.blogspot.com/2026/05/minimal.html',
        },
      });
      process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = JSON.stringify({ type: 'service_account' });
      process.env.BLOGGER_BLOG_ID = 'blog-456';

      const result = await adapter.publish({
        title: 'X',
        markdownContent: 'Y',
      });

      expect(result.success).toBe(true);
    });

    it('should use fallback URL when response has no URL', async () => {
      mockBlogger.posts.insert.mockResolvedValue({
        data: {
          id: 'post-nourl',
          // No url field in response
        },
      });
      process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = JSON.stringify({ type: 'service_account' });
      process.env.BLOGGER_BLOG_ID = 'blog-456';

      const result = await adapter.publish({
        title: 'Test Post',
        markdownContent: 'Test content',
      });

      expect(result.success).toBe(true);
      expect(result.publishedUrl).toContain('https://www.blogger.com/blog/post/edit');
      expect(result.publishedUrl).toContain('post-nourl');
    });
  });

  describe('Integration with Original URL', () => {
    it('should append original URL to content when provided', async () => {
      mockBlogger.posts.insert.mockResolvedValue({
        data: {
          id: 'post-with-source',
          url: 'https://myblog.blogspot.com/2026/05/sourced.html',
        },
      });
      process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = JSON.stringify({ type: 'service_account' });
      process.env.BLOGGER_BLOG_ID = 'blog-456';

      const originalUrl = 'https://original-source.com/article';
      const result = await adapter.publish({
        title: 'Sourced Post',
        markdownContent: 'Content',
        originalUrl,
      });

      expect(result.success).toBe(true);
      const callArgs = mockBlogger.posts.insert.mock.calls[0][0];
      expect(callArgs.requestBody.content).toContain(originalUrl);
    });
  });
});
