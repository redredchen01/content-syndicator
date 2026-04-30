import { ScrapedData } from '../scraper';
import path from 'path';
import fs from 'fs';
import zlib from 'zlib';
import { logger } from '../utils/logger';

interface CacheEntry {
  data: ScrapedData;
  timestamp: number;
  accessCount: number;
  lastAccess: number;
}

interface CacheStats {
  size: number;
  maxSize: number;
  hitCount: number;
  missCount: number;
  hitRate: string;
  oldestEntry: string;
  newestEntry: string;
}

export class PersistentScrapeCache {
  private cache: Map<string, CacheEntry> = new Map();
  private readonly ttl: number;
  private readonly maxSize: number;
  private readonly cacheDir: string;
  private hitCount = 0;
  private missCount = 0;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(ttlMs: number = 3600000, maxSize: number = 200, cacheDir?: string) {
    this.ttl = ttlMs;
    this.maxSize = maxSize;
    this.cacheDir = cacheDir || path.join(process.cwd(), '.data', 'cache');
    if (!fs.existsSync(this.cacheDir)) fs.mkdirSync(this.cacheDir, { recursive: true });
    this.loadFromDisk();
    this.startAutoSave();
  }

  get(url: string): ScrapedData | null {
    const entry = this.cache.get(url);
    if (!entry) {
      this.missCount++;
      return null;
    }
    const now = Date.now();
    if (now - entry.timestamp > this.ttl) {
      this.cache.delete(url);
      this.missCount++;
      this.scheduleSave();
      return null;
    }
    entry.accessCount++;
    entry.lastAccess = now;
    this.hitCount++;
    return entry.data;
  }

  set(url: string, data: ScrapedData): void {
    if (this.cache.size >= this.maxSize && !this.cache.has(url)) this.evictLRU();
    this.cache.set(url, { data, timestamp: Date.now(), accessCount: 1, lastAccess: Date.now() });
    this.scheduleSave();
  }

  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, entry] of this.cache.entries()) {
      if (entry.lastAccess < oldestTime) { oldestTime = entry.lastAccess; oldestKey = key; }
    }
    if (oldestKey) this.cache.delete(oldestKey);
  }

  clear(): void {
    this.cache.clear();
    this.hitCount = 0;
    this.missCount = 0;
    this.deleteCacheFile();
    logger.info('[Cache] Cache cleared');
  }

  getStats(): CacheStats {
    const entries = Array.from(this.cache.entries());
    const sortedByTime = entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hitCount: this.hitCount,
      missCount: this.missCount,
      hitRate: this.hitCount + this.missCount > 0 ? ((this.hitCount / (this.hitCount + this.missCount)) * 100).toFixed(2) + '%' : '0%',
      oldestEntry: sortedByTime.length > 0 ? new Date(sortedByTime[0][1].timestamp).toISOString() : 'N/A',
      newestEntry: sortedByTime.length > 0 ? new Date(sortedByTime[sortedByTime.length - 1][1].timestamp).toISOString() : 'N/A',
    };
  }

  cleanup(): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [url, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.ttl) { this.cache.delete(url); cleaned++; }
    }
    if (cleaned > 0) { logger.info(`[Cache] Cleaned up ${cleaned} expired entries`); this.scheduleSave(); }
    return cleaned;
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveToDisk(); this.saveTimer = null; }, 5000);
  }

  private saveToDisk(): void {
    try {
      const data = { entries: Array.from(this.cache.entries()), stats: { hitCount: this.hitCount, missCount: this.missCount } };
      const cacheFile = path.join(this.cacheDir, 'scrape-cache.json.gz');
      fs.writeFileSync(cacheFile, zlib.gzipSync(JSON.stringify(data)));
    } catch (e: any) { logger.warn(`[Cache] Failed to save: ${e.message}`); }
  }

  private loadFromDisk(): void {
    try {
      const cacheFile = path.join(this.cacheDir, 'scrape-cache.json.gz');
      if (!fs.existsSync(cacheFile)) return;
      const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(cacheFile)).toString());
      const now = Date.now();
      for (const [url, entry] of data.entries || []) {
        if (now - entry.timestamp <= this.ttl) this.cache.set(url, entry);
      }
      this.hitCount = data.stats?.hitCount || 0;
      this.missCount = data.stats?.missCount || 0;
    } catch (e: any) { logger.warn(`[Cache] Failed to load: ${e.message}`); }
  }

  private deleteCacheFile(): void {
    try { const f = path.join(this.cacheDir, 'scrape-cache.json.gz'); if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e: any) { logger.warn(`[Cache] Failed delete: ${e.message}`); }
  }

  private startAutoSave(): void {
    setInterval(() => { this.saveToDisk(); this.cleanup(); }, 60000);
  }
}

export const scrapeCache = new PersistentScrapeCache();
