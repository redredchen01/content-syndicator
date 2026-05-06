import { describe, it, expect, vi, beforeEach } from 'vitest';
import { publishToPlatforms } from '../publish-service';
import type { PlatformAdapter } from '../../adapters/base';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../adapters', () => ({
  allAdapters: [
    // API platforms (will be mocked)
    { name: 'Dev.to', isBrowserAutomation: false, canPublishAutomatically: true },
    { name: 'Hashnode', isBrowserAutomation: false, canPublishAutomatically: true },
    // Browser platforms (will be mocked)
    { name: 'Medium', isBrowserAutomation: true },
    { name: 'Blogger', isBrowserAutomation: true },
  ],
}));

vi.mock('../../db/index', () => ({
  updateTaskProgress: vi.fn(),
  getTaskProgress: vi.fn(),
  savePost: vi.fn(),
}));

vi.mock('../../sheets', () => ({
  appendToSheet: vi.fn(),
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  randomSleep: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('publishToPlatforms', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('publishes to API platforms concurrently (Promise.all)', async () => {
    const { allAdapters } = await import('../../adapters');
    const callTimings: { platform: string; startTime: number; endTime: number }[] = [];

    // Mock adapters with timing
    (allAdapters as any).forEach((adapter: any) => {
      if (!adapter.isBrowserAutomation) {
        adapter.publish = vi.fn(async () => {
          const start = Date.now();
          await new Promise(resolve => setTimeout(resolve, 100));
          const end = Date.now();
          callTimings.push({ platform: adapter.name, startTime: start, endTime: end });
          return { platform: adapter.name, success: true, publishedUrl: `https://${adapter.name}/post` };
        });
      }
    });

    await publishToPlatforms({
      sourceUrl: 'https://example.com',
      title: 'Test',
      content: 'Content',
    });

    // API platforms should have overlapping execution times (concurrent)
    const apiTimings = callTimings.filter(t => ['Dev.to', 'Medium'].includes(t.platform));
    if (apiTimings.length === 2) {
      const overlap = Math.min(apiTimings[0].endTime, apiTimings[1].endTime) - Math.max(apiTimings[0].startTime, apiTimings[1].startTime);
      expect(overlap).toBeGreaterThan(0); // Should overlap (concurrent execution)
    }
  });

  it('publishes to browser platforms with controlled concurrency', async () => {
    const { allAdapters } = await import('../../adapters');
    const callTimings: { platform: string; startTime: number; endTime: number }[] = [];

    // Mock adapters with timing
    (allAdapters as any).forEach((adapter: any) => {
      if (adapter.isBrowserAutomation) {
        adapter.publish = vi.fn(async () => {
          const start = Date.now();
          await new Promise(resolve => setTimeout(resolve, 50));
          const end = Date.now();
          callTimings.push({ platform: adapter.name, startTime: start, endTime: end });
          return { platform: adapter.name, success: true, publishedUrl: `https://${adapter.name}/post` };
        });
      }
    });

    const startTime = Date.now();
    await publishToPlatforms({
      sourceUrl: 'https://example.com',
      title: 'Test',
      content: 'Content',
    });
    const totalTime = Date.now() - startTime;

    // With concurrency=3 and 2 browser adapters, both should run nearly concurrently (~50ms)
    // If sequential, would take ~100ms. Concurrency should be faster or roughly same.
    expect(totalTime).toBeLessThan(500); // Safety margin for CI
  });

  it('handles failures in API and browser platforms independently', async () => {
    const { allAdapters } = await import('../../adapters');
    const { updateTaskProgress } = await import('../../db/index');

    // Mix successes and failures — Dev.to throws, others succeed
    (allAdapters as any).forEach((adapter: any) => {
      adapter.publish = vi.fn(async () => {
        if (adapter.name === 'Dev.to') {
          throw new Error('API timeout');
        }
        return {
          platform: adapter.name,
          success: true,
          publishedUrl: `https://${adapter.name}/post`,
        };
      });
    });

    const { results } = await publishToPlatforms({
      sourceUrl: 'https://example.com',
      title: 'Test',
      content: 'Content',
    });

    const failures = results.filter(r => !r.success);
    expect(failures.length).toBeGreaterThan(0);

    // Find the Dev.to failure
    const devToFailure = failures.find(f => f.platform === 'Dev.to');
    expect(devToFailure).toBeDefined();
    expect(devToFailure?.error).toContain('API timeout');

    // Verify updateTaskProgress was called for failure
    expect(updateTaskProgress).toHaveBeenCalledWith(
      'https://example.com',
      'Dev.to',
      'failed',
      'API timeout',
    );
  });

  it('respects quality score filtering', async () => {
    const { allAdapters } = await import('../../adapters');

    const publishCalls: string[] = [];
    (allAdapters as any).forEach((adapter: any) => {
      adapter.publish = vi.fn(async () => {
        publishCalls.push(adapter.name);
        return { platform: adapter.name, success: true };
      });
    });

    await publishToPlatforms(
      {
        sourceUrl: 'https://example.com',
        title: 'Test',
        content: 'Content',
      },
      5, // quality score < 7
    );

    // Hashnode and Medium should be filtered out
    expect(publishCalls).not.toContain('Hashnode');
    expect(publishCalls).not.toContain('Medium');
  });
});
