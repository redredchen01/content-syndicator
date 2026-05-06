import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock playwright before importing browserManager
vi.mock('playwright', () => {
  const mockPage = { close: vi.fn().mockResolvedValue(undefined) };
  const mockContext = {
    newPage: vi.fn().mockResolvedValue(mockPage),
  };
  const mockBrowser = {
    isConnected: vi.fn().mockReturnValue(true),
    launch: vi.fn(),
  };
  return {
    chromium: {
      launch: vi.fn().mockResolvedValue(mockBrowser),
    },
  };
});

vi.mock('../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../constants', () => ({
  CONCURRENCY_CONFIG: { BROWSER_MAX_TABS: 3 },
}));

describe('browserManager', () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  describe('acquirePage — concurrency limit', () => {
    it('allows up to MAX_TABS concurrent pages', async () => {
      const { acquirePage, _resetActivePages } = await import('../browserManager');
      _resetActivePages();

      const { chromium } = await import('playwright');
      const mockPage = { close: vi.fn().mockResolvedValue(undefined) };
      const mockContext = {
        newPage: vi.fn().mockResolvedValue(mockPage),
      } as any;

      // First 3 requests should go through without blocking
      const p1 = acquirePage(mockContext);
      const p2 = acquirePage(mockContext);
      const p3 = acquirePage(mockContext);

      const [pg1, pg2, pg3] = await Promise.all([p1, p2, p3]);
      expect(pg1).toBe(mockPage);
      expect(pg2).toBe(mockPage);
      expect(pg3).toBe(mockPage);
    });

    it('decrements counter when page creation fails', async () => {
      vi.resetModules();
      const { acquirePage, releasePage, _resetActivePages } = await import('../browserManager');
      _resetActivePages();

      const failingContext = {
        newPage: vi.fn().mockRejectedValue(new Error('page creation failed')),
      } as any;

      await expect(acquirePage(failingContext)).rejects.toThrow('page creation failed');

      // Counter should be back to 0 — next page should succeed immediately
      const okContext = {
        newPage: vi.fn().mockResolvedValue({ close: vi.fn() }),
      } as any;
      const page = await acquirePage(okContext);
      expect(page).toBeDefined();
    });
  });

  describe('releasePage', () => {
    it('closes the page and decrements counter', async () => {
      vi.resetModules();
      const { acquirePage, releasePage, _resetActivePages } = await import('../browserManager');
      _resetActivePages();

      const closeFn = vi.fn().mockResolvedValue(undefined);
      const mockPage = { close: closeFn } as any;
      const mockContext = { newPage: vi.fn().mockResolvedValue(mockPage) } as any;

      const page = await acquirePage(mockContext);
      await releasePage(page);

      expect(closeFn).toHaveBeenCalled();
    });
  });
});
