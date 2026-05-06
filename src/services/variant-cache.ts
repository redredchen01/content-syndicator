/**
 * Unit 5: Variant Result Caching Service
 *
 * Caches LLM generation results in SQLite with 24-hour TTL.
 * Cache key: SHA256(brand_id + draft_hash + persona_group)
 * Reduces LLM cost by ~80% on repeated content variations.
 *
 * Public API: getOrNull, set, cleanup
 */

import crypto from 'crypto';
import type Database from 'better-sqlite3';
import type { Variant, PersonaGroup } from '../types';
import { logger } from '../utils/logger';

// -----------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------

export interface VariantCacheEntry {
  cache_key: string;
  brand_id: string;
  draft_hash: string;
  persona_group: PersonaGroup;
  title: string;
  body_markdown: string;
  anchor_words: string; // stored as JSON string in DB
  generated_at: string;
  expires_at: string;
  hit_count: number;
}

// -----------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------

/**
 * Generate cache key from brand_id, draft_hash, persona_group.
 * Used for both cache lookups and storage.
 */
export function generateCacheKey(
  brandId: string,
  draftHash: string,
  personaGroup: PersonaGroup,
): string {
  const combined = `${brandId}:${draftHash}:${personaGroup}`;
  return crypto.createHash('sha256').update(combined).digest('hex');
}

/**
 * Generate SHA256 hash of draft content.
 * Called by variant-generator before cache lookup.
 */
export function generateDraftHash(draftContent: string): string {
  return crypto.createHash('sha256').update(draftContent).digest('hex');
}

export interface CachedVariantContent {
  title: string;
  body_markdown: string;
  anchor_words: string[];
}

/**
 * Check cache for an existing variant result.
 * Returns null if not found or expired.
 * Increments hit_count on successful hit.
 */
export function getOrNull(
  db: Database.Database,
  brandId: string,
  draftHash: string,
  personaGroup: PersonaGroup,
): CachedVariantContent | null {
  const cacheKey = generateCacheKey(brandId, draftHash, personaGroup);

  const row = db
    .prepare(
      `SELECT * FROM variant_cache
       WHERE cache_key = ? AND expires_at > CURRENT_TIMESTAMP`,
    )
    .get(cacheKey) as VariantCacheEntry | undefined;

  if (!row) return null;

  // Increment hit count
  db.prepare(`UPDATE variant_cache SET hit_count = hit_count + 1 WHERE cache_key = ?`).run(
    cacheKey,
  );

  return {
    title: row.title,
    body_markdown: row.body_markdown,
    anchor_words: JSON.parse(row.anchor_words) as string[],
  };
}

/**
 * Store a generated variant in cache with 24-hour TTL.
 * Called after successful LLM generation in variant-generator.
 */
export function set(
  db: Database.Database,
  brandId: string,
  draftHash: string,
  personaGroup: PersonaGroup,
  variant: Variant,
  ttlHours: number = 24,
): void {
  const cacheKey = generateCacheKey(brandId, draftHash, personaGroup);
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();

  db.prepare(`
    INSERT INTO variant_cache
      (cache_key, brand_id, draft_hash, persona_group, title, body_markdown, anchor_words, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET
      title = excluded.title,
      body_markdown = excluded.body_markdown,
      anchor_words = excluded.anchor_words,
      expires_at = excluded.expires_at,
      generated_at = CURRENT_TIMESTAMP,
      hit_count = 0
  `).run(
    cacheKey,
    brandId,
    draftHash,
    personaGroup,
    variant.title,
    variant.body_markdown,
    JSON.stringify(variant.anchor_words ?? []),
    expiresAt,
  );
}

/**
 * Clean up expired cache entries.
 * Run periodically (e.g., hourly background job) to avoid unbounded growth.
 * Returns the count of deleted rows.
 */
export function cleanup(db: Database.Database): number {
  const result = db
    .prepare('DELETE FROM variant_cache WHERE expires_at <= CURRENT_TIMESTAMP')
    .run();
  const deletedCount = result.changes || 0;
  if (deletedCount > 0) {
    logger.info(`[VariantCache] Cleaned up ${deletedCount} expired entries`);
  }
  return deletedCount;
}

/**
 * Get cache statistics for monitoring.
 */
export function getStats(db: Database.Database): { totalEntries: number; validEntries: number; totalHits: number } {
  const total = (db
    .prepare('SELECT COUNT(*) as count FROM variant_cache')
    .get() as { count: number }).count;

  const valid = (db
    .prepare('SELECT COUNT(*) as count FROM variant_cache WHERE expires_at > CURRENT_TIMESTAMP')
    .get() as { count: number }).count;

  const hits = (db
    .prepare('SELECT SUM(hit_count) as total FROM variant_cache')
    .get() as { total: number | null }).total ?? 0;

  return { totalEntries: total, validEntries: valid, totalHits: hits };
}
