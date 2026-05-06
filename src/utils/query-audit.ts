/**
 * Unit 6: Query Audit Utility
 *
 * Lightweight tracking of database query execution for N+1 detection.
 * Detects same query executed multiple times in quick succession (loop patterns).
 *
 * Usage (development):
 *   import { startQueryAudit, getAuditReport } from './query-audit'
 *   startQueryAudit()
 *   // ... code that executes queries
 *   const report = getAuditReport()
 *   console.log(report)  // Shows N+1 warnings
 */

// -----------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------

export interface QueryExecutionInfo {
  sql: string;
  count: number;
  stackTrace?: string;
  timestamps: number[];
}

export interface QueryAuditReport {
  queries: Map<string, QueryExecutionInfo>;
  warnings: Array<{
    sql: string;
    count: number;
    message: string;
  }>;
}

// -----------------------------------------------------------------------
// State
// -----------------------------------------------------------------------

let auditEnabled = false;
let queryMap: Map<string, QueryExecutionInfo> = new Map();
const N1_THRESHOLD = 3; // Warn if same query runs 3+ times

// -----------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------

/**
 * Enable query auditing for development/testing.
 * Disabled in production to avoid overhead.
 * Does not clear previously tracked queries — use clearAuditData() for that.
 */
export function startQueryAudit(): void {
  if (process.env.NODE_ENV === 'production') {
    return; // Don't audit in production
  }
  auditEnabled = true;
}

/**
 * Disable query auditing (retains tracked data for inspection).
 * Use clearAuditData() to also remove tracked queries.
 */
export function stopQueryAudit(): void {
  auditEnabled = false;
}

/**
 * Record a database query execution.
 * Call this from database adapters or prepared statement executors.
 */
export function recordQuery(sql: string): void {
  if (!auditEnabled) return;

  const normalized = normalizeSql(sql);
  const existing = queryMap.get(normalized);

  if (existing) {
    existing.count++;
    existing.timestamps.push(Date.now());
  } else {
    queryMap.set(normalized, {
      sql,
      count: 1,
      timestamps: [Date.now()],
      stackTrace: captureStackTrace(),
    });
  }
}

/**
 * Get audit report with warnings for potential N+1 patterns.
 */
export function getAuditReport(): QueryAuditReport {
  const warnings: QueryAuditReport['warnings'] = [];

  queryMap.forEach((info, sql) => {
    if (info.count >= N1_THRESHOLD) {
      warnings.push({
        sql,
        count: info.count,
        message: `⚠️ Query executed ${info.count} times (potential N+1)`,
      });
    }
  });

  return {
    queries: new Map(queryMap),
    warnings: warnings.sort((a, b) => b.count - a.count),
  };
}

/**
 * Check if current code is in an N+1 pattern.
 * Returns true if same query executed 3+ times within last 1 second.
 */
export function detectN1Loop(sql: string): boolean {
  if (!auditEnabled) return false;

  const normalized = normalizeSql(sql);
  const info = queryMap.get(normalized);
  if (!info || info.count < N1_THRESHOLD) return false;

  // Check if executions are clustered (within 1 second)
  const now = Date.now();
  const recentExecutions = info.timestamps.filter(ts => now - ts < 1000);
  return recentExecutions.length >= N1_THRESHOLD;
}

/**
 * Clear audit data (useful between test cases).
 */
export function clearAuditData(): void {
  queryMap.clear();
}

// -----------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------

/**
 * Normalize SQL for comparison (removes parameters, whitespace differences).
 */
function normalizeSql(sql: string): string {
  return sql
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\?/g, '?') // Parameters are wildcards
    .toLowerCase();
}

/**
 * Capture stack trace for debugging query origins.
 */
function captureStackTrace(): string {
  const stack = new Error().stack || '';
  const lines = stack.split('\n').slice(2, 6); // Skip Error and recordQuery
  return lines.join('\n');
}

/**
 * Helper: Get summary of queries by frequency.
 */
export function getQuerySummary(): Array<{ sql: string; count: number }> {
  const summary: Array<{ sql: string; count: number }> = [];

  queryMap.forEach((info, sql) => {
    summary.push({ sql, count: info.count });
  });

  return summary.sort((a, b) => b.count - a.count);
}
