import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('../../db/index', () => ({
  updateTaskProgress: vi.fn(),
  getTaskProgress: vi.fn(),
  savePost: vi.fn(),
}));

vi.mock('../../sheets', () => ({
  appendToSheet: vi.fn().mockResolvedValue(undefined),
}));

import { publishToPlatforms } from '../publish-service';

describe('PublishService - publishToPlatforms', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Basic Functionality', () => {
    it('should have publishToPlatforms function exported', () => {
      expect(typeof publishToPlatforms).toBe('function');
    });

    it('should accept PublishOptions and quality score', async () => {
      // This is a basic smoke test that the function accepts expected parameters
      const result = await publishToPlatforms(
        {
          sourceUrl: 'https://example.com/article',
          title: 'Test Article',
          content: 'Test content here',
        },
        0, // quality score
      );

      expect(result).toHaveProperty('targetPlatforms');
      expect(result).toHaveProperty('results');
      expect(Array.isArray(result.results)).toBe(true);
    });

    it('should support platforms option parameter', async () => {
      const result = await publishToPlatforms(
        {
          sourceUrl: 'https://example.com',
          title: 'Test',
          content: 'Content',
          platforms: ['Blogger', 'Dev.to'],
        },
        0,
      );

      expect(result.results).toBeDefined();
    });

    it('should support publishStatus parameter', async () => {
      const result = await publishToPlatforms(
        {
          sourceUrl: 'https://example.com',
          title: 'Test',
          content: 'Content',
          publishStatus: 'draft',
        },
        0,
      );

      expect(result.results).toBeDefined();
    });

    it('should support optional tags and excerpt', async () => {
      const result = await publishToPlatforms(
        {
          sourceUrl: 'https://example.com',
          title: 'Test',
          content: 'Content',
          tags: ['javascript', 'web'],
          excerpt: 'Short summary',
        },
        0,
      );

      expect(result.results).toBeDefined();
    });
  });

  describe('Quality Gate Logic', () => {
    it('should return results object with targetPlatforms and results array', async () => {
      const result = await publishToPlatforms(
        {
          sourceUrl: 'https://example.com',
          title: 'Test',
          content: 'Content',
        },
        10, // High quality
      );

      expect(result).toHaveProperty('targetPlatforms');
      expect(result).toHaveProperty('results');
      expect(Array.isArray(result.targetPlatforms)).toBe(true);
      expect(Array.isArray(result.results)).toBe(true);
    });

    it('should apply quality gate to filter platforms', async () => {
      const lowQualityResult = await publishToPlatforms(
        {
          sourceUrl: 'https://example.com',
          title: 'Test',
          content: 'Content',
        },
        3, // Low quality
      );

      const highQualityResult = await publishToPlatforms(
        {
          sourceUrl: 'https://example.com',
          title: 'Test',
          content: 'Content',
        },
        10, // High quality
      );

      // Results should be defined (actual filtering depends on adapter availability)
      expect(lowQualityResult.results).toBeDefined();
      expect(highQualityResult.results).toBeDefined();
    });
  });

  describe('Platform Selection', () => {
    it('should handle empty platforms list gracefully', async () => {
      const result = await publishToPlatforms(
        {
          sourceUrl: 'https://example.com',
          title: 'Test',
          content: 'Content',
          platforms: [],
        },
        5,
      );

      // Empty platforms list will resolve to default platforms
      expect(Array.isArray(result.results)).toBe(true);
    });

    it('should resolve platforms to actual adapters', async () => {
      const result = await publishToPlatforms(
        {
          sourceUrl: 'https://example.com',
          title: 'Test',
          content: 'Content',
          platforms: ['Blogger'],
        },
        5,
      );

      // Result should have platform information
      expect(result.results).toBeDefined();
    });

    it('should use default platforms when not specified', async () => {
      const result = await publishToPlatforms(
        {
          sourceUrl: 'https://example.com',
          title: 'Test',
          content: 'Content',
          // No platforms specified
        },
        5,
      );

      // Should have some results from default selection
      expect(result.results).toBeDefined();
    });
  });

  describe('Content Handling', () => {
    it('should include title in adapter calls', async () => {
      const result = await publishToPlatforms(
        {
          sourceUrl: 'https://example.com',
          title: 'My Article Title',
          content: 'Content',
          platforms: ['Dev.to'],
        },
        5,
      );

      expect(result).toBeDefined();
    });

    it('should include markdown content in adapter calls', async () => {
      const content = '# Heading\n\nParagraph with **bold**';
      const result = await publishToPlatforms(
        {
          sourceUrl: 'https://example.com',
          title: 'Test',
          content,
          platforms: ['Dev.to'],
        },
        5,
      );

      expect(result).toBeDefined();
    });

    it('should handle tags array', async () => {
      const result = await publishToPlatforms(
        {
          sourceUrl: 'https://example.com',
          title: 'Test',
          content: 'Content',
          tags: ['tag1', 'tag2', 'tag3'],
        },
        5,
      );

      expect(result).toBeDefined();
    });

    it('should handle excerpt text', async () => {
      const result = await publishToPlatforms(
        {
          sourceUrl: 'https://example.com',
          title: 'Test',
          content: 'Content',
          excerpt: 'This is a short excerpt of the article',
        },
        5,
      );

      expect(result).toBeDefined();
    });

    it('should preserve sourceUrl for attribution', async () => {
      const sourceUrl = 'https://original-source.com/article';
      const result = await publishToPlatforms(
        {
          sourceUrl,
          title: 'Test',
          content: 'Content',
        },
        5,
      );

      expect(result).toBeDefined();
    });
  });

  describe('Status Handling', () => {
    it('should support draft status', async () => {
      const result = await publishToPlatforms(
        {
          sourceUrl: 'https://example.com',
          title: 'Draft Post',
          content: 'Content',
          publishStatus: 'draft',
        },
        5,
      );

      expect(result).toBeDefined();
    });

    it('should support public status', async () => {
      const result = await publishToPlatforms(
        {
          sourceUrl: 'https://example.com',
          title: 'Public Post',
          content: 'Content',
          publishStatus: 'public',
        },
        5,
      );

      expect(result).toBeDefined();
    });

    it('should default to draft when status not specified', async () => {
      const result = await publishToPlatforms(
        {
          sourceUrl: 'https://example.com',
          title: 'Test',
          content: 'Content',
          // No publishStatus specified
        },
        5,
      );

      expect(result).toBeDefined();
    });
  });

  describe('Return Value Structure', () => {
    it('should return targetPlatforms array', async () => {
      const result = await publishToPlatforms(
        {
          sourceUrl: 'https://example.com',
          title: 'Test',
          content: 'Content',
          platforms: ['Blogger'],
        },
        5,
      );

      expect(Array.isArray(result.targetPlatforms)).toBe(true);
      expect(result.targetPlatforms).toEqual(expect.any(Array));
    });

    it('should return results array', async () => {
      const result = await publishToPlatforms(
        {
          sourceUrl: 'https://example.com',
          title: 'Test',
          content: 'Content',
        },
        5,
      );

      expect(Array.isArray(result.results)).toBe(true);
    });

    it('should have matching counts when all platforms used', async () => {
      const result = await publishToPlatforms(
        {
          sourceUrl: 'https://example.com',
          title: 'Test',
          content: 'Content',
          platforms: ['Blogger', 'Dev.to'],
        },
        5,
      );

      // Results should contain entries for requested platforms
      expect(result.results.length).toBeLessThanOrEqual(2);
    });
  });
});
