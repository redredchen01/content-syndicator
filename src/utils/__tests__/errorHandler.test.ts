import { describe, it, expect } from 'vitest';
import { errorHandler, handleApiError } from '../errorHandler';

describe('ErrorHandler', () => {
  describe('errorHandler singleton', () => {
    it('should have errorHandler instance exported', () => {
      expect(errorHandler).toBeDefined();
    });

    it('should have handleError method', () => {
      expect(typeof errorHandler.handleError).toBe('function');
    });

    it('should have getErrorHistory method', () => {
      expect(typeof errorHandler.getErrorHistory).toBe('function');
    });

    it('should have getErrorStats method', () => {
      expect(typeof errorHandler.getErrorStats).toBe('function');
    });

    it('should have clearHistory method', () => {
      expect(typeof errorHandler.clearHistory).toBe('function');
    });
  });

  describe('Error Handling', () => {
    it('should handle and record errors', () => {
      const error = new Error('Test error');
      const result = errorHandler.handleError(error, 'test-context');

      expect(result).toBeDefined();
      expect(result).toHaveProperty('type');
      expect(result).toHaveProperty('message');
      expect(result).toHaveProperty('suggestions');
    });

    it('should provide advice for different error types', () => {
      const error = new Error('Network error');
      const result = errorHandler.handleError(error, 'network-test');

      expect(result.suggestions).toBeDefined();
      expect(Array.isArray(result.suggestions)).toBe(true);
    });

    it('should record errors in history', () => {
      errorHandler.clearHistory();
      const error = new Error('History test error');
      errorHandler.handleError(error, 'history-context');

      const history = errorHandler.getErrorHistory({ limit: 10 });
      expect(history.length).toBeGreaterThan(0);
    });

    it('should limit error history to maxHistory size', () => {
      errorHandler.clearHistory();
      // Add many errors
      for (let i = 0; i < 600; i++) {
        errorHandler.handleError(new Error(`Error ${i}`), 'stress-test');
      }

      const history = errorHandler.getErrorHistory();
      // Should be limited to 500
      expect(history.length).toBeLessThanOrEqual(500);
    });
  });

  describe('Error History Management', () => {
    it('should retrieve error history', () => {
      errorHandler.clearHistory();
      errorHandler.handleError(new Error('Test 1'), 'test');
      errorHandler.handleError(new Error('Test 2'), 'test');

      const history = errorHandler.getErrorHistory();
      expect(Array.isArray(history)).toBe(true);
      expect(history.length).toBeGreaterThanOrEqual(2);
    });

    it('should filter history by error type', () => {
      errorHandler.clearHistory();
      errorHandler.handleError(new Error('Network timeout'), 'test');
      errorHandler.handleError(new Error('401 Unauthorized'), 'test');

      const history = errorHandler.getErrorHistory({ limit: 10 });
      expect(history.length).toBeGreaterThan(0);
    });

    it('should filter history by date', () => {
      errorHandler.clearHistory();
      errorHandler.handleError(new Error('Test error'), 'test');

      const since = new Date(Date.now() - 1000); // Last second
      const history = errorHandler.getErrorHistory({ since });
      expect(Array.isArray(history)).toBe(true);
    });

    it('should limit history results', () => {
      errorHandler.clearHistory();
      for (let i = 0; i < 20; i++) {
        errorHandler.handleError(new Error(`Error ${i}`), 'test');
      }

      const history = errorHandler.getErrorHistory({ limit: 5 });
      expect(history.length).toBeLessThanOrEqual(5);
    });

    it('should clear error history', () => {
      errorHandler.handleError(new Error('Test'), 'test');
      errorHandler.clearHistory();

      const history = errorHandler.getErrorHistory();
      expect(history.length).toBe(0);
    });
  });

  describe('Error Statistics', () => {
    it('should provide error statistics', () => {
      errorHandler.clearHistory();
      errorHandler.handleError(new Error('Test error'), 'test');

      const stats = errorHandler.getErrorStats();
      expect(stats).toHaveProperty('total');
      expect(stats).toHaveProperty('byType');
      expect(stats).toHaveProperty('recentErrors');
    });

    it('should count errors by type', () => {
      errorHandler.clearHistory();
      errorHandler.handleError(new Error('Network error'), 'test1');
      errorHandler.handleError(new Error('Another error'), 'test2');

      const stats = errorHandler.getErrorStats();
      expect(stats.total).toBeGreaterThan(0);
      expect(typeof stats.byType).toBe('object');
    });

    it('should track recent errors in last hour', () => {
      errorHandler.clearHistory();
      errorHandler.handleError(new Error('Recent error'), 'test');

      const stats = errorHandler.getErrorStats();
      expect(stats.recentErrors).toBeGreaterThan(0);
    });
  });

  describe('handleApiError Function', () => {
    it('should handle API errors with context', () => {
      const error = new Error('API failed');
      const result = handleApiError(error, 'api-context');

      expect(result).toBeDefined();
      expect(result).toHaveProperty('success', false);
      expect(result).toHaveProperty('error');
      expect(result.error).toHaveProperty('type');
      expect(result.error).toHaveProperty('message');
    });

    it('should handle API errors without context', () => {
      const error = new Error('API failed');
      const result = handleApiError(error);

      expect(result).toBeDefined();
      expect(result).toHaveProperty('success', false);
      expect(result.error).toHaveProperty('type');
    });

    it('should provide error details for different error types', () => {
      const networkError = new Error('Network connection failed');
      const authError = new Error('401 Unauthorized');

      const networkResult = handleApiError(networkError, 'network');
      const authResult = handleApiError(authError, 'auth');

      expect(networkResult.error.suggestions).toBeDefined();
      expect(authResult.error.suggestions).toBeDefined();
    });
  });

  describe('Real-world Scenarios', () => {
    it('should handle fetch errors', () => {
      errorHandler.clearHistory();
      const fetchError = new Error('Failed to fetch');
      const result = errorHandler.handleError(fetchError, 'fetch-request');

      expect(result).toBeDefined();
      expect(result.message).toBeTruthy();
    });

    it('should handle timeout errors', () => {
      errorHandler.clearHistory();
      const timeoutError = new Error('Request timeout');
      const result = errorHandler.handleError(timeoutError, 'timeout');

      expect(result).toBeDefined();
      expect(result.suggestions).toBeDefined();
    });

    it('should handle API response errors', () => {
      errorHandler.clearHistory();
      const apiError: any = new Error('API returned error');
      apiError.status = 500;

      const result = handleApiError(apiError, 'api-response');
      expect(result).toBeDefined();
    });

    it('should provide actionable error suggestions', () => {
      const error = new Error('Network error: connection refused');
      const result = errorHandler.handleError(error, 'production-error');

      expect(result.suggestions).toBeDefined();
      expect(Array.isArray(result.suggestions)).toBe(true);
      expect(result.suggestions.length).toBeGreaterThan(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle null errors gracefully', () => {
      expect(() => {
        errorHandler.handleError(null as any, 'null-error');
      }).not.toThrow();
    });

    it('should handle errors without message', () => {
      const error: any = {};
      expect(() => {
        errorHandler.handleError(error, 'no-message');
      }).not.toThrow();
    });

    it('should handle string errors', () => {
      const stringError = 'String error message';
      const error = new Error(stringError);

      expect(() => {
        errorHandler.handleError(error, 'string-error');
      }).not.toThrow();
    });

    it('should handle errors with stack traces', () => {
      const error = new Error('Error with stack');
      const result = errorHandler.handleError(error, 'stack-error');

      expect(result).toBeDefined();
    });
  });
});
