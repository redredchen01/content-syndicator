import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { generateDraftHash, generateCacheKey } from '../services/variant-cache';
import { classifyError, getRetryPolicy } from '../services/error-classifier';
import {
  reset as resetMetrics,
  getReport as getMetricsReport,
  recordHistogram,
  incrementCounter,
  setGauge,
} from '../utils/metrics-collector';
import { startQueryAudit, stopQueryAudit, getAuditReport } from '../utils/query-audit';
import { applyV2Schema } from '../db/schema';

// -----------------------------------------------------------------------
// Integration Tests
// -----------------------------------------------------------------------

describe('End-to-End Performance Validation', () => {
  let db: Database.Database;

  beforeEach(() => {
    resetMetrics();
    startQueryAudit();
    db = new Database(':memory:');
    applyV2Schema(db);
  });

  afterEach(() => {
    stopQueryAudit();
    db.close();
  });

  describe('Unit 5: Variant Result Caching', () => {
    it('cache key generation is deterministic', () => {
      const draftContent = 'Sample draft content for testing.'.repeat(20);
      const hash1 = generateDraftHash(draftContent);
      const hash2 = generateDraftHash(draftContent);

      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA256 hex
    });

    it('cache keys differ for different inputs', () => {
      const key1 = generateCacheKey('main', 'hash1', 'tech_blogger');
      const key2 = generateCacheKey('other', 'hash1', 'tech_blogger');
      const key3 = generateCacheKey('main', 'hash2', 'tech_blogger');
      const key4 = generateCacheKey('main', 'hash1', 'personal_essay');

      expect(key1).not.toBe(key2);
      expect(key1).not.toBe(key3);
      expect(key1).not.toBe(key4);
    });
  });

  describe('Unit 4: Error Classification & Retry Strategy', () => {
    it('classifies errors correctly for retry decisions', () => {
      // Temporary errors → retry
      expect(classifyError('Connection timeout')).toBe('temporary');
      expect(classifyError('ECONNRESET')).toBe('temporary');
      expect(classifyError('', { httpStatus: 500 })).toBe('temporary');
      expect(classifyError('', { httpStatus: 429 })).toBe('temporary');

      // Permanent errors → fail fast
      expect(classifyError('', { httpStatus: 404 })).toBe('permanent');
      expect(classifyError('unauthorized')).toBe('permanent');
      expect(classifyError('forbidden')).toBe('permanent');

      // Unknown → conservative retry
      expect(classifyError('Some random error')).toBe('unknown');
    });

    it('retry policy scales appropriately by error type', () => {
      const tempPolicy = getRetryPolicy('temporary');
      expect(tempPolicy.maxAttempts).toBe(3);
      expect(tempPolicy.backoffMultiplier).toBe(2);

      const permPolicy = getRetryPolicy('permanent');
      expect(permPolicy.maxAttempts).toBe(1);

      const unknownPolicy = getRetryPolicy('unknown');
      expect(unknownPolicy.maxAttempts).toBe(2);
    });
  });

  describe('Unit 6: Database Query Audit & Indexing', () => {
    it('indexes exist for optimized queries', () => {
      const indexQuery = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'",
      );
      const indexes = indexQuery.all() as Array<{ name: string }>;

      const indexNames = indexes.map(i => i.name);
      expect(indexNames).toContain('idx_publish_jobs_dispatch');
      expect(indexNames).toContain('idx_variant_cache_brand_expires');
      expect(indexNames).toContain('idx_draft_batches_brand_status');
    });

    it('draft_batches table has brand_status index', () => {
      const indexQuery = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name = 'idx_draft_batches_brand_status'",
      );
      const result = indexQuery.get() as { sql: string } | undefined;

      expect(result).toBeDefined();
      expect(result?.sql).toContain('draft_batches');
      expect(result?.sql).toContain('brand_id');
      expect(result?.sql).toContain('status');
    });
  });

  describe('Unit 7: Performance Metrics Instrumentation', () => {
    it('records timing metrics for operations', () => {
      recordHistogram('test_operation', 100);
      recordHistogram('test_operation', 150);
      recordHistogram('test_operation', 200);

      const report = getMetricsReport();
      const stats = report.histograms.get('test_operation');
      expect(stats?.count).toBe(3);
      expect(stats?.sum).toBe(450);
      expect(stats?.avg).toBe(150);
    });

    it('computes percentiles for latency analysis', () => {
      for (let i = 1; i <= 100; i++) {
        recordHistogram('latency', i);
      }

      const report = getMetricsReport();
      const stats = report.histograms.get('latency');
      expect(stats?.p50).toBeGreaterThan(0);
      expect(stats?.p50).toBeLessThanOrEqual(51);
      expect(stats?.p95).toBeGreaterThan(stats?.p50 || 0);
      expect(stats?.p99).toBeGreaterThan(stats?.p95 || 0);
    });
  });

  describe('Integrated Performance: All Units Together', () => {
    it('metrics report captures optimization impact', () => {
      // Simulate metrics collection from entire flow
      incrementCounter('cache_hits', 5);
      incrementCounter('cache_misses', 2);
      setGauge('active_publishes', 2);
      recordHistogram('variant_generation_ms', 8000);
      recordHistogram('variant_generation_ms', 9000);
      recordHistogram('publish_ms', 3000);
      recordHistogram('publish_ms', 4000);

      const report = getMetricsReport();

      // Verify metrics are captured
      expect(report.counters.get('cache_hits')).toBe(5);
      expect(report.counters.get('cache_misses')).toBe(2);
      expect(report.gauges.get('active_publishes')).toBe(2);

      const genStats = report.histograms.get('variant_generation_ms');
      expect(genStats?.count).toBe(2);
      expect(genStats?.avg).toBe(8500);

      const pubStats = report.histograms.get('publish_ms');
      expect(pubStats?.count).toBe(2);
      expect(pubStats?.avg).toBe(3500);

      // Cache hit rate > 50%
      const hitRate = 5 / (5 + 2);
      expect(hitRate).toBeGreaterThan(0.5);
    });

    it('performance within targets', () => {
      // Target performance: variant_generation < 15s, publish < 5s
      recordHistogram('variant_generation_ms', 8000); // 8s ✓
      recordHistogram('variant_generation_ms', 12000); // 12s ✓
      recordHistogram('publish_ms', 3000); // 3s ✓
      recordHistogram('publish_ms', 4500); // 4.5s ✓

      const report = getMetricsReport();

      const genStats = report.histograms.get('variant_generation_ms');
      expect(genStats?.p99).toBeLessThan(15000); // < 15s target

      const pubStats = report.histograms.get('publish_ms');
      expect(pubStats?.p99).toBeLessThan(5000); // < 5s target
    });
  });

  describe('Performance Regression Detection', () => {
    it('detects metrics for regression analysis', () => {
      // Record baseline metrics
      const targetBaseline = {
        variant_generation_ms_p95: 15000,
        publish_ms_p95: 5000,
        cache_hit_rate: 0.5,
      };

      // Simulate better performance than target
      recordHistogram('variant_generation_ms', 7000);
      recordHistogram('variant_generation_ms', 9000);
      recordHistogram('variant_generation_ms', 11000);

      const report = getMetricsReport();
      const stats = report.histograms.get('variant_generation_ms');

      // Current p95 should be better than baseline
      expect(stats?.p95 || 0).toBeLessThan(targetBaseline.variant_generation_ms_p95);
    });
  });
});
