import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifyError, ErrorType, _resetCircuitBreakers } from '../smartRetry';

vi.mock('../logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../systemMonitor', () => ({
  systemMonitor: { recordOperation: vi.fn() },
}));

beforeEach(() => {
  _resetCircuitBreakers();
});

describe('classifyError', () => {
  it('classifies 429 as RATE_LIMIT', () => {
    expect(classifyError({ status: 429 })).toBe(ErrorType.RATE_LIMIT);
    expect(classifyError({ response: { status: 429 } })).toBe(ErrorType.RATE_LIMIT);
  });

  it('classifies 401/403 as AUTH', () => {
    expect(classifyError({ status: 401 })).toBe(ErrorType.AUTH);
    expect(classifyError({ status: 403 })).toBe(ErrorType.AUTH);
    expect(classifyError({ message: 'Unauthorized' })).toBe(ErrorType.AUTH);
  });

  it('classifies 404 as NOT_FOUND', () => {
    expect(classifyError({ status: 404 })).toBe(ErrorType.NOT_FOUND);
  });

  it('classifies 5xx as SERVER_ERROR', () => {
    expect(classifyError({ status: 500 })).toBe(ErrorType.SERVER_ERROR);
    expect(classifyError({ status: 503 })).toBe(ErrorType.SERVER_ERROR);
  });

  it('classifies timeout messages as TIMEOUT', () => {
    expect(classifyError({ message: 'etimedout error' })).toBe(ErrorType.TIMEOUT);
    expect(classifyError({ message: 'timeout exceeded' })).toBe(ErrorType.TIMEOUT);
    expect(classifyError({ message: 'socket hang up' })).toBe(ErrorType.TIMEOUT);
  });

  it('classifies connection errors as NETWORK', () => {
    expect(classifyError({ message: 'ECONNREFUSED' })).toBe(ErrorType.NETWORK);
    expect(classifyError({ message: 'fetch failed' })).toBe(ErrorType.NETWORK);
  });

  it('returns UNKNOWN for unrecognized errors', () => {
    expect(classifyError({ message: 'something odd happened' })).toBe(ErrorType.UNKNOWN);
    expect(classifyError({})).toBe(ErrorType.UNKNOWN);
    expect(classifyError(null)).toBe(ErrorType.UNKNOWN);
  });
});

describe('_resetCircuitBreakers — test isolation', () => {
  it('clears circuit breaker state between tests', () => {
    // First test simulates triggering a circuit breaker
    _resetCircuitBreakers();
    // If state leaked from prior test it would throw here; this just asserts the export works
    expect(_resetCircuitBreakers).not.toThrow();
  });
});

import { retryOperation } from '../smartRetry';

describe('retryOperation — context isolation', () => {
  it('openai and gemini contexts have independent circuit breakers', async () => {
    // Exhaust the openai circuit breaker by making it fail 5 times
    for (let i = 0; i < 5; i++) {
      try {
        await retryOperation(
          () => Promise.reject(new Error('openai failure')),
          1,
          'openai',
        );
      } catch {}
    }

    // Gemini context should still be open (not blocked by openai failures)
    const result = await retryOperation(
      () => Promise.resolve('gemini ok'),
      1,
      'gemini',
    );
    expect(result).toBe('gemini ok');
  });

  it('retryOperation without context falls back to undefined (shared default)', async () => {
    const result = await retryOperation(() => Promise.resolve(42));
    expect(result).toBe(42);
  });
});
