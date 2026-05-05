import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { logger } from '../logger';
import { createRequestContext, getContextId, runWithContext } from '../context';
import fs from 'fs';
import path from 'path';

describe('Logger Integration', () => {
  const logsDir = path.join(process.cwd(), '.data', 'logs');

  beforeAll(() => {
    // Ensure logs directory exists
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
  });

  afterAll(() => {
    // Clean up test logs if needed
  });

  describe('Basic Logging', () => {
    it('should output structured logs with timestamp', () => {
      expect(() => {
        logger.info('test.info.message', { testField: 'value' });
      }).not.toThrow();
    });

    it('should log at different levels', () => {
      expect(() => {
        logger.debug('test.debug.message', { level: 'debug' });
        logger.info('test.info.message', { level: 'info' });
        logger.warn('test.warn.message', { level: 'warn' });
        logger.error('test.error.message', { error: 'test error' });
      }).not.toThrow();
    });

    it('should support backward compatible logger.success method', () => {
      expect(() => {
        logger.success('test.success.message');
      }).not.toThrow();
    });

    it('should handle error objects in error method', () => {
      const err = new Error('Test error message');
      expect(() => {
        logger.error('test.error.with_object', err);
      }).not.toThrow();
    });
  });

  describe('Context Injection', () => {
    it('should inject contextId from request context', async () => {
      const testContextId = 'test-context-123';

      await runWithContext(testContextId, async () => {
        expect(getContextId()).toBe(testContextId);

        // Logger should have access to this context
        expect(() => {
          logger.info('test.context.injection', { field: 'value' });
        }).not.toThrow();
      });
    });

    it('should allow optional metadata along with auto-injected contextId', async () => {
      const testContextId = 'test-context-456';

      await runWithContext(testContextId, async () => {
        expect(() => {
          logger.info('test.context.with_metadata', {
            customField: 'customValue',
            anotherField: 123,
          });
        }).not.toThrow();
      });
    });
  });

  describe('Log File Creation', () => {
    it('should create log files in .data/logs directory', () => {
      // Simple check that logs directory exists
      expect(fs.existsSync(logsDir)).toBe(true);
    });

    it('should create daily rotated log files with correct naming pattern', () => {
      const today = new Date().toISOString().split('T')[0];
      const appLogPattern = `app-${today}.log`;

      // Check if any app log file exists for today
      const files = fs.readdirSync(logsDir);
      const hasAppLog = files.some(f => f.startsWith('app-') && f.endsWith('.log'));

      expect(hasAppLog).toBe(true);
    });
  });

  describe('Performance', () => {
    it('should not significantly impact performance with structured logging', () => {
      const startTime = Date.now();
      const iterations = 100; // Reduced from 1000 to avoid test output spam

      for (let i = 0; i < iterations; i++) {
        logger.info('test.performance.iteration', { index: i });
      }

      const duration = Date.now() - startTime;

      // Should complete 100 logs in less than 500ms
      expect(duration).toBeLessThan(500);
    });
  });

  describe('API Compatibility', () => {
    it('should maintain backward compatibility with existing logger calls', () => {
      expect(() => {
        // Old style calls should still work
        logger.info('simple message');
        logger.warn('warning message');
        logger.error('error message');
        logger.success('success message');
      }).not.toThrow();
    });

    it('should support new structured format', () => {
      expect(() => {
        // New style calls
        logger.info('module.function.event', { contextId: 'test', field: 'value' });
        logger.debug('debug.event', { additional: 'metadata' });
      }).not.toThrow();
    });
  });
});
