import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getPlatformDelay, getExponentialBackoffDelay, sleep } from '../platform-delay-config';

describe('PlatformDelayConfig', () => {
  describe('getPlatformDelay', () => {
    it('should return delay within configured range for known platforms', () => {
      const delay = getPlatformDelay('Blogger');
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(3000);
    });

    it('should return different delays for different platforms', () => {
      const bloggerDelay = getPlatformDelay('Blogger');
      const wordpressDelay = getPlatformDelay('WordPress');

      // WordPress should generally be slower than Blogger
      expect(wordpressDelay).toBeGreaterThanOrEqual(4000);
    });

    it('should support environment variable overrides', () => {
      const originalEnv = process.env.DELAY_MEDIUM_MS;
      try {
        process.env.DELAY_MEDIUM_MS = '5000';
        const delay = getPlatformDelay('Medium');
        expect(delay).toBe(5000);
      } finally {
        if (originalEnv) {
          process.env.DELAY_MEDIUM_MS = originalEnv;
        } else {
          delete process.env.DELAY_MEDIUM_MS;
        }
      }
    });

    it('should return default delay for unknown platforms', () => {
      const delay = getPlatformDelay('UnknownPlatform');
      expect(delay).toBeGreaterThanOrEqual(2000);
      expect(delay).toBeLessThanOrEqual(5000);
    });

    it('should return randomized delays (within range)', () => {
      const delays = new Set();
      for (let i = 0; i < 10; i++) {
        delays.add(getPlatformDelay('Dev.to'));
      }
      // Should have multiple different values due to randomization
      expect(delays.size).toBeGreaterThan(1);
    });
  });

  describe('getExponentialBackoffDelay', () => {
    it('should calculate exponential backoff correctly', () => {
      const delay0 = getExponentialBackoffDelay(0, 30000, 1.2, 60000);
      const delay1 = getExponentialBackoffDelay(1, 30000, 1.2, 60000);
      const delay2 = getExponentialBackoffDelay(2, 30000, 1.2, 60000);

      // Each delay should be roughly multiplier times the previous
      expect(delay1).toBeGreaterThan(delay0);
      expect(delay2).toBeGreaterThan(delay1);
    });

    it('should respect maximum delay limit', () => {
      const delay = getExponentialBackoffDelay(10, 30000, 1.2, 60000);
      expect(delay).toBeLessThanOrEqual(60000);
    });

    it('should start at initial delay for iteration 0', () => {
      const delay = getExponentialBackoffDelay(0, 30000, 1.2, 60000);
      // Allow for small jitter
      expect(delay).toBeGreaterThanOrEqual(30000 * 0.95);
      expect(delay).toBeLessThanOrEqual(30000 * 1.15);
    });

    it('should apply jitter to prevent thundering herd', () => {
      const delays = new Set();
      for (let i = 0; i < 5; i++) {
        delays.add(getExponentialBackoffDelay(1, 30000, 1.2, 60000));
      }
      // Should have different values due to jitter
      expect(delays.size).toBeGreaterThan(1);
    });
  });

  describe('sleep', () => {
    it('should sleep for specified milliseconds', async () => {
      const start = Date.now();
      await sleep(100);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(90);
      expect(elapsed).toBeLessThan(200);
    });

    it('should handle zero delay', async () => {
      const start = Date.now();
      await sleep(0);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(50);
    });
  });

  describe('Edge Cases', () => {
    it('should handle negative iteration for exponential backoff gracefully', () => {
      const delay = getExponentialBackoffDelay(-1, 30000, 1.2, 60000);
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(60000);
    });

    it('should handle very large iteration numbers', () => {
      const delay = getExponentialBackoffDelay(100, 30000, 1.2, 60000);
      expect(delay).toBeLessThanOrEqual(60000);
    });

    it('should handle special platform names with dots and spaces', () => {
      const originalEnv = process.env.DELAY_DEV_TO_MS;
      try {
        process.env.DELAY_DEV_TO_MS = '4000';
        const delay = getPlatformDelay('Dev.to');
        expect(delay).toBe(4000);
      } finally {
        if (originalEnv) {
          process.env.DELAY_DEV_TO_MS = originalEnv;
        } else {
          delete process.env.DELAY_DEV_TO_MS;
        }
      }
    });
  });
});
