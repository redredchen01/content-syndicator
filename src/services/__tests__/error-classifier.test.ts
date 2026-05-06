import { describe, it, expect } from 'vitest';
import {
  classifyError,
  getRetryPolicy,
  calculateBackoffMs,
  type ErrorClassification,
} from '../error-classifier';

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

describe('Error Classifier', () => {
  describe('classifyError - HTTP Status Codes (priority over message)', () => {
    it('classifies 5xx as temporary', () => {
      expect(classifyError('Any message', { httpStatus: 500 })).toBe('temporary');
      expect(classifyError('', { httpStatus: 502 })).toBe('temporary');
      expect(classifyError('', { httpStatus: 503 })).toBe('temporary');
      expect(classifyError('', { httpStatus: 599 })).toBe('temporary');
    });

    it('classifies 4xx as permanent (except 429)', () => {
      expect(classifyError('', { httpStatus: 400 })).toBe('permanent');
      expect(classifyError('', { httpStatus: 401 })).toBe('permanent');
      expect(classifyError('', { httpStatus: 403 })).toBe('permanent');
      expect(classifyError('', { httpStatus: 404 })).toBe('permanent');
      expect(classifyError('', { httpStatus: 410 })).toBe('permanent');
    });

    it('classifies 429 as temporary (rate limit)', () => {
      expect(classifyError('Too many requests', { httpStatus: 429 })).toBe('temporary');
    });

    it('ignores message patterns when HTTP status is provided', () => {
      // Even though message says "timeout" (temporary), HTTP 404 means permanent
      expect(classifyError('Connection timeout', { httpStatus: 404 })).toBe('permanent');
    });
  });

  describe('classifyError - Network Error Messages', () => {
    it('classifies timeout errors as temporary', () => {
      expect(classifyError(new Error('Request timeout'))).toBe('temporary');
      expect(classifyError('ETIMEDOUT')).toBe('temporary');
      expect(classifyError('socket timeout')).toBe('temporary');
    });

    it('classifies connection errors as temporary', () => {
      expect(classifyError('ECONNRESET')).toBe('temporary');
      expect(classifyError('ECONNREFUSED')).toBe('temporary');
      expect(classifyError('socket hang up')).toBe('temporary');
    });

    it('classifies rate limit errors as temporary', () => {
      expect(classifyError('Too many requests')).toBe('temporary');
      expect(classifyError('429')).toBe('temporary');
    });

    it('classifies SSL certificate errors as temporary', () => {
      expect(classifyError('unable to verify the first certificate')).toBe('temporary');
    });
  });

  describe('classifyError - Authentication/Authorization Errors', () => {
    it('classifies auth errors as permanent', () => {
      expect(classifyError('unauthorized')).toBe('permanent');
      expect(classifyError('Unauthorized')).toBe('permanent');
      expect(classifyError('authentication failed')).toBe('permanent');
      expect(classifyError('Invalid API key')).toBe('permanent');
    });

    it('classifies permission errors as permanent', () => {
      expect(classifyError('forbidden')).toBe('permanent');
      expect(classifyError('Forbidden')).toBe('permanent');
    });
  });

  describe('classifyError - Not Found / Gone', () => {
    it('classifies 404/410 errors as permanent', () => {
      expect(classifyError('not found')).toBe('permanent');
      expect(classifyError('page gone')).toBe('permanent');
    });
  });

  describe('classifyError - Malformed / Invalid', () => {
    it('classifies request format errors as permanent', () => {
      expect(classifyError('Bad Request')).toBe('permanent');
      expect(classifyError('Malformed JSON')).toBe('permanent');
      expect(classifyError('Invalid parameter')).toBe('permanent');
      expect(classifyError('Unsupported format')).toBe('permanent');
    });
  });

  describe('classifyError - Unknown', () => {
    it('classifies unrecognized errors as unknown', () => {
      expect(classifyError('Some random error')).toBe('unknown');
      expect(classifyError('Internal application error')).toBe('unknown');
      expect(classifyError('')).toBe('unknown');
    });

    it('unknown classification is safe default for unmatched patterns', () => {
      const unknownError = new Error('Novel error type not in patterns');
      expect(classifyError(unknownError)).toBe('unknown');
    });
  });

  describe('classifyError - Case Insensitivity', () => {
    it('matches error patterns case-insensitively', () => {
      expect(classifyError('TIMEOUT')).toBe('temporary');
      expect(classifyError('Unauthorized')).toBe('permanent');
      expect(classifyError('UnknOwN ErRoR')).toBe('unknown');
    });
  });
});

describe('Retry Policy', () => {
  it('temporary errors get exponential backoff with up to 3 attempts', () => {
    const policy = getRetryPolicy('temporary');
    expect(policy.maxAttempts).toBe(3);
    expect(policy.initialDelayMs).toBe(1000);
    expect(policy.backoffMultiplier).toBe(2);
  });

  it('permanent errors get fail-fast (1 attempt)', () => {
    const policy = getRetryPolicy('permanent');
    expect(policy.maxAttempts).toBe(1);
    expect(policy.initialDelayMs).toBe(0);
  });

  it('unknown errors get conservative retry (2 attempts)', () => {
    const policy = getRetryPolicy('unknown');
    expect(policy.maxAttempts).toBe(2);
    expect(policy.initialDelayMs).toBe(500);
  });
});

describe('Backoff Calculation', () => {
  const tempPolicy = getRetryPolicy('temporary');

  it('first attempt has no delay', () => {
    expect(calculateBackoffMs(0, tempPolicy)).toBe(0);
  });

  it('subsequent attempts use exponential backoff', () => {
    expect(calculateBackoffMs(1, tempPolicy)).toBe(1000); // 1000 * 2^0
    expect(calculateBackoffMs(2, tempPolicy)).toBe(2000); // 1000 * 2^1
    expect(calculateBackoffMs(3, tempPolicy)).toBe(4000); // 1000 * 2^2
  });

  it('backoff respects max delay cap', () => {
    // Exponential would be 1000 * 2^5 = 32000, but capped at 10000
    expect(calculateBackoffMs(6, tempPolicy)).toBe(10000);
  });

  it('permanent errors have zero delay (no retries anyway)', () => {
    const permPolicy = getRetryPolicy('permanent');
    expect(calculateBackoffMs(0, permPolicy)).toBe(0);
  });
});

describe('Integration: Error Classification → Retry Policy → Backoff', () => {
  it('timeout error: temporary classification → 3 retries with backoff', () => {
    const classification = classifyError('Connection timeout');
    expect(classification).toBe('temporary');

    const policy = getRetryPolicy(classification);
    expect(policy.maxAttempts).toBe(3);

    // Verify backoff progression
    const delays = [0, 1, 2, 3].map(i => calculateBackoffMs(i, policy));
    expect(delays).toEqual([0, 1000, 2000, 4000]);
  });

  it('404 error: permanent classification → fail immediately', () => {
    const classification = classifyError('', { httpStatus: 404 });
    expect(classification).toBe('permanent');

    const policy = getRetryPolicy(classification);
    expect(policy.maxAttempts).toBe(1);
  });

  it('rate limit (429): temporary classification → 3 retries', () => {
    const classification = classifyError('', { httpStatus: 429 });
    expect(classification).toBe('temporary');

    const policy = getRetryPolicy(classification);
    expect(policy.maxAttempts).toBe(3);
  });
});
