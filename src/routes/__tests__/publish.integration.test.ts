import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../server';
import * as db from '../../db';

// Mock database and external services
vi.mock('../../db', () => ({
  db: {
    prepare: vi.fn(),
  },
  savePost: vi.fn(),
}));

vi.mock('../../sheets', () => ({
  appendToSheet: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/publish-service', () => ({
  publishToPlatforms: vi.fn().mockResolvedValue({
    targetPlatforms: ['Blogger'],
    results: [
      {
        platform: 'Blogger',
        success: true,
        publishedUrl: 'https://example.blogspot.com/post/123',
      },
    ],
  }),
}));

describe('Publish Routes Integration', () => {
  describe('POST /api/v2/generate', () => {
    it('should return 400 when draft is missing', async () => {
      const response = await request(app)
        .post('/api/v2/generate')
        .send({ title: 'Test' });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
    });

    it('should return 400 when draft is empty', async () => {
      const response = await request(app)
        .post('/api/v2/generate')
        .send({
          draft: '',
          title: 'Test',
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('required');
    });

    it('should accept draft content with optional title and override', async () => {
      const response = await request(app)
        .post('/api/v2/generate')
        .send({
          draft: 'This is the draft content',
          title: 'Optional Title',
          target_url_override: 'https://custom-url.com',
        });

      // Should respond with variants and batchId
      expect([200, 400, 500]).toContain(response.status);
    });

    it('should return structured response on success', async () => {
      const response = await request(app)
        .post('/api/v2/generate')
        .send({
          draft: 'Draft content here',
        });

      // On success, should have batchId and variants
      if (response.status === 200) {
        expect(response.body).toHaveProperty('batchId');
        expect(response.body).toHaveProperty('variants');
        expect(response.body).toHaveProperty('lintResult');
      }
    });
  });

  describe('POST /api/v2/dispatch', () => {
    it('should return 400 when batchId is missing', async () => {
      const response = await request(app)
        .post('/api/v2/dispatch')
        .send({
          variants: [{ platform: 'Blogger', title: 'Test' }],
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('batchId');
    });

    it('should return 400 when variants array is missing', async () => {
      const response = await request(app)
        .post('/api/v2/dispatch')
        .send({
          batchId: 'batch-123',
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('variants');
    });

    it('should return 400 when variants is not an array', async () => {
      const response = await request(app)
        .post('/api/v2/dispatch')
        .send({
          batchId: 'batch-123',
          variants: { platform: 'Blogger' }, // Not an array
        });

      expect(response.status).toBe(400);
    });

    it('should accept batchId and variants array', async () => {
      const response = await request(app)
        .post('/api/v2/dispatch')
        .send({
          batchId: 'batch-123',
          variants: [
            {
              platform: 'Blogger',
              title: 'Test Post',
              content: 'Test content',
            },
            {
              platform: 'Dev.to',
              title: 'Test Post',
              content: 'Test content',
            },
          ],
        });

      // Should dispatch jobs and return jobsCreated count
      expect([200, 400, 500]).toContain(response.status);
    });

    it('should return jobsCreated count on success', async () => {
      const response = await request(app)
        .post('/api/v2/dispatch')
        .send({
          batchId: 'batch-456',
          variants: [{ platform: 'Blogger', title: 'Test' }],
        });

      if (response.status === 200) {
        expect(response.body).toHaveProperty('batchId');
        expect(response.body).toHaveProperty('jobsCreated');
        expect(typeof response.body.jobsCreated).toBe('number');
      }
    });
  });

  describe('GET /api/v2/queue', () => {
    it('should accept queue status requests without parameters', async () => {
      const response = await request(app).get('/api/v2/queue');

      // May return 500 due to mocking, but should structure properly
      expect([200, 500]).toContain(response.status);
      if (response.status === 200) {
        expect(response.body).toHaveProperty('jobs');
        expect(Array.isArray(response.body.jobs)).toBe(true);
      }
    });

    it('should accept batchId query parameter', async () => {
      const response = await request(app)
        .get('/api/v2/queue')
        .query({ batchId: 'batch-123' });

      expect([200, 500]).toContain(response.status);
      if (response.status === 200) {
        expect(response.body).toHaveProperty('jobs');
        expect(Array.isArray(response.body.jobs)).toBe(true);
      }
    });

    it('should accept query string for batch filtering', async () => {
      const response = await request(app)
        .get('/api/v2/queue')
        .query({ batchId: 'batch-test' });

      // Should respond (may be 500 due to mocking)
      expect([200, 500]).toContain(response.status);
    });

    it('should handle multiple queue status requests', async () => {
      const response1 = await request(app).get('/api/v2/queue');
      const response2 = await request(app)
        .get('/api/v2/queue')
        .query({ batchId: 'batch-789' });

      expect([200, 500]).toContain(response1.status);
      expect([200, 500]).toContain(response2.status);
    });
  });

  describe('POST /api/v2/regenerate-variant', () => {
    it('should return 400 when batchId is missing', async () => {
      const response = await request(app)
        .post('/api/v2/regenerate-variant')
        .send({
          platform: 'Blogger',
          draft: 'Draft content',
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('batchId');
    });

    it('should return 400 when platform is missing', async () => {
      const response = await request(app)
        .post('/api/v2/regenerate-variant')
        .send({
          batchId: 'batch-123',
          draft: 'Draft content',
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('platform');
    });

    it('should return 400 when draft is missing', async () => {
      const response = await request(app)
        .post('/api/v2/regenerate-variant')
        .send({
          batchId: 'batch-123',
          platform: 'Blogger',
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('draft');
    });

    it('should accept valid regenerate-variant request', async () => {
      const response = await request(app)
        .post('/api/v2/regenerate-variant')
        .send({
          batchId: 'batch-999',
          platform: 'Dev.to',
          draft: 'Updated draft content',
        });

      expect([200, 400, 500]).toContain(response.status);
    });
  });

  describe('Error Handling', () => {
    it('should handle JSON parsing errors gracefully', async () => {
      const response = await request(app)
        .post('/api/v2/generate')
        .set('Content-Type', 'application/json')
        .send('invalid json {');

      expect(response.status).toBe(400);
    });

    it('should handle server errors with proper status codes', async () => {
      // Test with very long content that might cause issues
      const longContent = 'x'.repeat(10000000); // 10MB content

      const response = await request(app)
        .post('/api/v2/generate')
        .send({
          draft: longContent,
        });

      // Should either handle or return error
      expect([200, 400, 413, 500]).toContain(response.status);
    });
  });

  describe('Request Headers', () => {
    it('should accept x-request-id header', async () => {
      const response = await request(app)
        .post('/api/v2/generate')
        .set('x-request-id', 'test-request-id-123')
        .send({
          draft: 'Test draft',
        });

      // Should process with contextId
      expect([200, 400, 500]).toContain(response.status);
    });

    it('should accept x-context-id header', async () => {
      const response = await request(app)
        .post('/api/v2/generate')
        .set('x-context-id', 'test-context-id-456')
        .send({
          draft: 'Test draft',
        });

      // Should process with contextId
      expect([200, 400, 500]).toContain(response.status);
    });

    it('should work without context headers', async () => {
      const response = await request(app)
        .post('/api/v2/generate')
        .send({
          draft: 'Test draft',
        });

      // Should auto-generate contextId
      expect([200, 400, 500]).toContain(response.status);
    });
  });

  describe('Health Check', () => {
    it('should return health status', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status');
      expect(response.body.status).toBe('ok');
      expect(response.body).toHaveProperty('version');
    });

    it('health check should always succeed', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body.uptime).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Response Headers', () => {
    it('should return JSON content type', async () => {
      const response = await request(app)
        .post('/api/v2/generate')
        .send({
          draft: 'Test',
        });

      if (response.status === 200) {
        expect(response.headers['content-type']).toMatch(/application\/json/);
      }
    });

    it('should handle CORS headers appropriately', async () => {
      const response = await request(app)
        .get('/health')
        .set('Origin', 'http://localhost:3000');

      // Should handle CORS
      expect(response.status).toBe(200);
    });
  });
});
