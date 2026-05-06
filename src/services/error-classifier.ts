/**
 * Unit 4: Error Classification Service
 *
 * Distinguishes transient (retryable) from permanent (fail-fast) errors.
 * Enables intelligent retry logic: temp errors get exponential backoff,
 * permanent errors skip retry overhead.
 */

// -----------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------

export type ErrorClassification = 'temporary' | 'permanent' | 'unknown';

export interface ErrorClassifierContext {
  httpStatus?: number;
  platform?: string;
}

// -----------------------------------------------------------------------
// Classification Patterns
// -----------------------------------------------------------------------

/** Network/timeout patterns — retry recommended */
const TEMPORARY_ERROR_PATTERNS = [
  /timeout/i,
  /ECONNRESET/,
  /ECONNREFUSED/,
  /ETIMEDOUT/,
  /EHOSTUNREACH/,
  /ENETUNREACH/,
  /unable to verify the first certificate/i,
  /socket hang up/i,
  /broken pipe/i,
  /Too many requests/, // Rate limit (429)
  /429/,
];

/** Permanent error patterns — fail immediately */
const PERMANENT_ERROR_PATTERNS = [
  /unauthorized/i, // 401
  /forbidden/i, // 403
  /not found/i, // 404
  /gone/i, // 410
  /invalid.*credential/i,
  /authentication.*fail/i,
  /API key/i,
  /Bad Request/i, // 400
  /Malformed/i,
  /Invalid/i,
  /Unsupported/i,
  /Not Implemented/i, // 501
];

// -----------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------

/**
 * Classify an error as temporary (retryable), permanent (fail-fast), or unknown.
 * HTTP status codes take precedence over error message patterns.
 */
export function classifyError(
  error: Error | string,
  context?: ErrorClassifierContext,
): ErrorClassification {
  const message = typeof error === 'string' ? error : error.message || '';
  const status = context?.httpStatus;

  // HTTP status classification (most reliable)
  if (typeof status === 'number') {
    // 5xx server errors — retry
    if (status >= 500 && status < 600) return 'temporary';

    // 429 rate limit — retry
    if (status === 429) return 'temporary';

    // 4xx client errors (except 429) — don't retry
    if (status >= 400 && status < 500) return 'permanent';

    // 1xx, 2xx, 3xx — shouldn't reach here (not errors)
    return 'permanent';
  }

  // Message-based classification (fallback)
  if (matchesAny(message, TEMPORARY_ERROR_PATTERNS)) return 'temporary';
  if (matchesAny(message, PERMANENT_ERROR_PATTERNS)) return 'permanent';

  // Unknown — default to conservative retry strategy (one attempt)
  return 'unknown';
}

/**
 * Get retry policy for an error classification.
 * Temp: exponential backoff, up to 3 retries
 * Permanent: no retries
 * Unknown: single retry, then give up
 */
export function getRetryPolicy(classification: ErrorClassification) {
  return {
    temporary: {
      maxAttempts: 3,
      initialDelayMs: 1000,
      maxDelayMs: 10000,
      backoffMultiplier: 2,
    },
    permanent: {
      maxAttempts: 1, // fail immediately
      initialDelayMs: 0,
      maxDelayMs: 0,
      backoffMultiplier: 1,
    },
    unknown: {
      maxAttempts: 2, // single retry, conservative default
      initialDelayMs: 500,
      maxDelayMs: 5000,
      backoffMultiplier: 2,
    },
  }[classification];
}

/**
 * Calculate backoff delay for retry attempt.
 * Returns milliseconds to wait before next retry.
 */
export function calculateBackoffMs(
  attempt: number, // 0-indexed: attempt 0 failed, attempt 1 is first retry
  policy: ReturnType<typeof getRetryPolicy>,
): number {
  if (attempt === 0) return 0; // First attempt, no delay
  const exponentialDelay = policy.initialDelayMs * Math.pow(policy.backoffMultiplier, attempt - 1);
  return Math.min(exponentialDelay, policy.maxDelayMs);
}

// -----------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------

function matchesAny(text: string, patterns: (string | RegExp)[]): boolean {
  return patterns.some(p => {
    if (typeof p === 'string') return text.includes(p);
    return p.test(text);
  });
}
