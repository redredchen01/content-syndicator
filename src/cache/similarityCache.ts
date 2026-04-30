import { ScrapedData } from '../scraper';
import crypto from 'crypto';

/**
 * @deprecated v0.1 only — replaced by `src/services/lint/jaccard.ts` in v0.2.
 *
 * This module hashes the first 2000 characters with sha256 to detect
 * "similar" generations, but it cannot tell whether two articles are
 * semantically near-duplicates. v0.2 uses 5-gram character-shingle
 * Jaccard similarity for batch-level dedup (Plan Unit 7, R23).
 *
 * Kept in tree only for back-compat with v0.1 paths still referencing
 * ContentCache. Remove this file once those paths migrate (Phase 2).
 */
export class ContentCache {
  private cache: Map<string, string> = new Map();

  // 为文章内容生成简单的语义哈希
  private generateHash(content: string): string {
    const simplified = content.substring(0, 2000).replace(/\s+/g, '');
    return crypto.createHash('sha256').update(simplified).digest('hex');
  }

  // 检查是否有相似内容
  getCachedGeneration(content: string): string | null {
    const hash = this.generateHash(content);
    return this.cache.get(hash) || null;
  }

  // 存储生成结果
  storeGeneration(content: string, result: any): void {
    const hash = this.generateHash(content);
    this.cache.set(hash, JSON.stringify(result));
  }
}

export const contentSimilarityCache = new ContentCache();
