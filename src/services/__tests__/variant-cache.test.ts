import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  generateCacheKey,
  generateDraftHash,
  getOrNull,
  set,
  cleanup,
  getStats,
} from '../variant-cache';
import type { Variant } from '../../types';
import { applyV2Schema } from '../../db/schema';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDb() {
  const db = new Database(':memory:');
  applyV2Schema(db);
  return db;
}

const TEST_VARIANT: Variant = {
  variant_id: 'batch_001_dev',
  platform: 'Dev.to',
  persona_group: 'tech_blogger',
  title: 'Test Article Title',
  body_markdown: '## Section\n\nThis is test content.',
  anchor_words: ['keyword1', 'keyword2'],
  target_url: 'https://example.com',
  generation_status: 'ok',
};

const DRAFT_CONTENT = 'This is a test draft for caching purposes.'.repeat(20); // long enough to be realistic

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Variant Cache', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  describe('generateDraftHash', () => {
    it('generates consistent SHA256 hash', () => {
      const hash1 = generateDraftHash(DRAFT_CONTENT);
      const hash2 = generateDraftHash(DRAFT_CONTENT);
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA256 hex = 64 chars
    });

    it('produces different hashes for different content', () => {
      const hash1 = generateDraftHash(DRAFT_CONTENT);
      const hash2 = generateDraftHash(DRAFT_CONTENT + ' extra');
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('generateCacheKey', () => {
    it('generates consistent key from (brand_id, draft_hash, persona_group)', () => {
      const draftHash = generateDraftHash(DRAFT_CONTENT);
      const key1 = generateCacheKey('main', draftHash, 'tech_blogger');
      const key2 = generateCacheKey('main', draftHash, 'tech_blogger');
      expect(key1).toBe(key2);
    });

    it('produces different keys for different inputs', () => {
      const draftHash = generateDraftHash(DRAFT_CONTENT);
      const key1 = generateCacheKey('main', draftHash, 'tech_blogger');
      const key2 = generateCacheKey('other', draftHash, 'tech_blogger');
      expect(key1).not.toBe(key2);
    });

    it('produces different keys for different persona groups', () => {
      const draftHash = generateDraftHash(DRAFT_CONTENT);
      const key1 = generateCacheKey('main', draftHash, 'tech_blogger');
      const key2 = generateCacheKey('main', draftHash, 'personal_essay');
      expect(key1).not.toBe(key2);
    });
  });

  describe('set and getOrNull', () => {
    it('stores and retrieves variant from cache', () => {
      const draftHash = generateDraftHash(DRAFT_CONTENT);
      set(db, 'main', draftHash, 'tech_blogger', TEST_VARIANT);

      const cached = getOrNull(db, 'main', draftHash, 'tech_blogger');
      expect(cached).not.toBeNull();
      expect(cached?.title).toBe(TEST_VARIANT.title);
      expect(cached?.body_markdown).toBe(TEST_VARIANT.body_markdown);
      expect(cached?.anchor_words).toEqual(TEST_VARIANT.anchor_words);
    });

    it('returns null for cache miss', () => {
      const draftHash = generateDraftHash(DRAFT_CONTENT);
      const cached = getOrNull(db, 'main', draftHash, 'tech_blogger');
      expect(cached).toBeNull();
    });

    it('returns null for expired cache entries', () => {
      const draftHash = generateDraftHash(DRAFT_CONTENT);

      // Store with expiration 1 hour in the past
      const expiresAt = new Date(Date.now() - 3600 * 1000).toISOString();
      const cacheKey = generateCacheKey('main', draftHash, 'tech_blogger');
      db.prepare(`
        INSERT INTO variant_cache
          (cache_key, brand_id, draft_hash, persona_group, title, body_markdown, anchor_words, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime(?))
      `).run(
        cacheKey, 'main', draftHash, 'tech_blogger',
        TEST_VARIANT.title, TEST_VARIANT.body_markdown,
        JSON.stringify(TEST_VARIANT.anchor_words),
        expiresAt,
      );

      const cached = getOrNull(db, 'main', draftHash, 'tech_blogger');
      expect(cached).toBeNull();
    });

    it('increments hit_count on successful retrieval', () => {
      const draftHash = generateDraftHash(DRAFT_CONTENT);
      set(db, 'main', draftHash, 'tech_blogger', TEST_VARIANT);

      getOrNull(db, 'main', draftHash, 'tech_blogger');
      getOrNull(db, 'main', draftHash, 'tech_blogger');

      const cacheKey = generateCacheKey('main', draftHash, 'tech_blogger');
      const row = db
        .prepare('SELECT hit_count FROM variant_cache WHERE cache_key = ?')
        .get(cacheKey) as { hit_count: number };
      expect(row.hit_count).toBe(2);
    });

    it('overwrites existing cache entry', () => {
      const draftHash = generateDraftHash(DRAFT_CONTENT);

      // First insertion
      set(db, 'main', draftHash, 'tech_blogger', TEST_VARIANT);

      // Second insertion with same key but different content
      const updated = {
        ...TEST_VARIANT,
        title: 'Updated Title',
        body_markdown: 'Updated body',
      };
      set(db, 'main', draftHash, 'tech_blogger', updated);

      const cached = getOrNull(db, 'main', draftHash, 'tech_blogger');
      expect(cached?.title).toBe('Updated Title');
      expect(cached?.body_markdown).toBe('Updated body');
    });
  });

  describe('cleanup', () => {
    it('removes expired cache entries', () => {
      const draftHash = generateDraftHash(DRAFT_CONTENT);

      // Insert an expired entry (1 hour in the past)
      const expiredKey = generateCacheKey('main', draftHash, 'tech_blogger');
      const expiresAt = new Date(Date.now() - 3600 * 1000).toISOString();
      db.prepare(`
        INSERT INTO variant_cache
          (cache_key, brand_id, draft_hash, persona_group, title, body_markdown, anchor_words, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime(?))
      `).run(
        expiredKey, 'main', draftHash, 'tech_blogger',
        'Expired', 'Body', '[]', expiresAt,
      );

      // Insert a valid entry
      set(db, 'other', draftHash, 'personal_essay', TEST_VARIANT);

      const deletedCount = cleanup(db);
      expect(deletedCount).toBe(1);

      // Verify the valid entry still exists
      const cached = getOrNull(db, 'other', draftHash, 'personal_essay');
      expect(cached).not.toBeNull();
    });

    it('returns 0 when no entries to delete', () => {
      const deletedCount = cleanup(db);
      expect(deletedCount).toBe(0);
    });
  });

  describe('getStats', () => {
    it('returns correct cache statistics', () => {
      const draftHash = generateDraftHash(DRAFT_CONTENT);

      // Insert 2 variants
      set(db, 'main', draftHash, 'tech_blogger', TEST_VARIANT);
      set(db, 'main', draftHash, 'personal_essay', TEST_VARIANT);

      // Access one variant twice to increment hits
      getOrNull(db, 'main', draftHash, 'tech_blogger');
      getOrNull(db, 'main', draftHash, 'tech_blogger');

      const stats = getStats(db);
      expect(stats.totalEntries).toBe(2);
      expect(stats.validEntries).toBe(2);
      expect(stats.totalHits).toBe(2); // only tech_blogger hits
    });

    it('excludes expired entries from valid count', () => {
      const draftHash = generateDraftHash(DRAFT_CONTENT);

      // Insert expired and valid entries
      const expiredKey = generateCacheKey('main', draftHash, 'tech_blogger');
      const expiresAt = new Date(Date.now() - 3600 * 1000).toISOString();
      db.prepare(`
        INSERT INTO variant_cache
          (cache_key, brand_id, draft_hash, persona_group, title, body_markdown, anchor_words, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime(?))
      `).run(
        expiredKey, 'main', draftHash, 'tech_blogger',
        'Expired', 'Body', '[]', expiresAt,
      );
      set(db, 'main', draftHash, 'personal_essay', TEST_VARIANT);

      const stats = getStats(db);
      expect(stats.totalEntries).toBe(2);
      expect(stats.validEntries).toBe(1);
    });
  });
});
