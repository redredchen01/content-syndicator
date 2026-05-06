import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyV2Schema } from '../../db/schema';
import { anchorHistory } from '../../db/repositories';
import { runPrecheck, isUrlOverCap } from '../anchor-monitor';
import type { BrandProfile } from '../../db/repositories';

function freshDb() {
  const db = new Database(':memory:');
  applyV2Schema(db);
  return db;
}

function defaultBrand(): Pick<BrandProfile, 'anchor_concentration_threshold' | 'weekly_url_cap'> {
  return { anchor_concentration_threshold: 0.30, weekly_url_cap: 6 };
}

function insertAnchor(
  db: Database.Database,
  batchId: string,
  anchor: string,
  targetUrl = 'https://example.com',
) {
  anchorHistory.insert(db, {
    batch_id: batchId,
    variant_id: `v_${batchId}`,
    platform: 'Dev.to',
    anchor_text: anchor,
    target_url: targetUrl,
  });
}

describe('runPrecheck — no warnings (happy path)', () => {
  it('returns 0 warnings on empty history', () => {
    const db = freshDb();
    const result = runPrecheck(db, ['https://example.com'], defaultBrand());
    expect(result.warningCount).toBe(0);
    expect(result.warnings).toHaveLength(0);
    db.close();
  });

  it('returns 0 warnings when anchor distribution is even', () => {
    const db = freshDb();
    // 10 distinct anchors, each used once — ratio 10%, below 30% threshold.
    // Use unique target URLs per batch so the URL cap (6) is never exceeded.
    for (let i = 0; i < 10; i++) {
      insertAnchor(db, `b${i}`, `anchor-variant-${i}`, `https://example.com/page-${i}`);
    }
    const result = runPrecheck(db, ['https://example.com/page-new'], defaultBrand());
    expect(result.warningCount).toBe(0);
    db.close();
  });
});

describe('runPrecheck — anchor concentration (R10b)', () => {
  it('warns when one anchor exceeds threshold', () => {
    const db = freshDb();
    // 7 out of 10 = 70% for "click here"
    for (let i = 0; i < 7; i++) insertAnchor(db, `b${i}`, 'click here');
    for (let i = 7; i < 10; i++) insertAnchor(db, `b${i}`, `other-${i}`);
    const result = runPrecheck(db, ['https://example.com'], {
      anchor_concentration_threshold: 0.5,
      weekly_url_cap: 6,
    });
    expect(result.warningCount).toBeGreaterThanOrEqual(1);
    expect(result.warnings[0].type).toBe('anchor_concentration');
    expect(result.warnings[0].message).toContain('click here');
    db.close();
  });

  it('does not warn when highest ratio is below threshold', () => {
    const db = freshDb();
    for (let i = 0; i < 3; i++) insertAnchor(db, `b${i}`, 'moderately used');
    for (let i = 3; i < 10; i++) insertAnchor(db, `b${i}`, `other-${i}`);
    const result = runPrecheck(db, ['https://example.com'], {
      anchor_concentration_threshold: 0.5,
      weekly_url_cap: 6,
    });
    expect(result.warnings.filter(w => w.type === 'anchor_concentration')).toHaveLength(0);
    db.close();
  });

  it('topAnchors is always populated for LLM prompt context', () => {
    const db = freshDb();
    for (let i = 0; i < 3; i++) insertAnchor(db, `b${i}`, 'anchor-a');
    const result = runPrecheck(db, ['https://example.com'], defaultBrand());
    expect(result.topAnchors.length).toBeGreaterThan(0);
    expect(result.topAnchors[0]).toHaveProperty('anchor');
    expect(result.topAnchors[0]).toHaveProperty('ratio');
    db.close();
  });
});

describe('runPrecheck — weekly URL cap (R10c)', () => {
  it('warns when target URL reaches weekly cap', () => {
    const db = freshDb();
    const url = 'https://target.com/product';
    for (let i = 0; i < 6; i++) {
      // Insert directly into anchor_history with a very recent used_at
      db.prepare(`
        INSERT INTO anchor_history (batch_id, variant_id, platform, anchor_text, target_url, used_at)
        VALUES (?, ?, ?, ?, ?, datetime('now', '-${i} hours'))
      `).run(`b${i}`, `v${i}`, 'Dev.to', 'some anchor', url);
    }
    const result = runPrecheck(db, [url], defaultBrand());
    const urlWarnings = result.warnings.filter(w => w.type === 'weekly_url_cap');
    expect(urlWarnings).toHaveLength(1);
    expect(urlWarnings[0].message).toContain(url);
    db.close();
  });

  it('uses sliding 7-day window, not calendar week', () => {
    const db = freshDb();
    const url = 'https://old.com';
    // Insert 6 entries that are 8 days old (outside 7-day window)
    for (let i = 0; i < 6; i++) {
      db.prepare(`
        INSERT INTO anchor_history (batch_id, variant_id, platform, anchor_text, target_url, used_at)
        VALUES (?, ?, ?, ?, ?, datetime('now', '-8 days'))
      `).run(`b${i}`, `v${i}`, 'Dev.to', 'a', url);
    }
    const result = runPrecheck(db, [url], defaultBrand());
    const urlWarnings = result.warnings.filter(w => w.type === 'weekly_url_cap');
    expect(urlWarnings).toHaveLength(0); // outside window
    db.close();
  });

  it('does not warn for different target URL', () => {
    const db = freshDb();
    const overCapUrl = 'https://target.com/a';
    const checkedUrl = 'https://target.com/b'; // fresh
    for (let i = 0; i < 6; i++) {
      db.prepare(`
        INSERT INTO anchor_history (batch_id, variant_id, platform, anchor_text, target_url, used_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
      `).run(`b${i}`, `v${i}`, 'Dev.to', 'a', overCapUrl);
    }
    const result = runPrecheck(db, [checkedUrl], defaultBrand());
    expect(result.warnings.filter(w => w.type === 'weekly_url_cap')).toHaveLength(0);
    db.close();
  });
});

describe('runPrecheck — bypass count', () => {
  it('counts publish_jobs with bypass_reasons in metadata this week', () => {
    const db = freshDb();
    // Insert a job with bypass metadata
    db.prepare(`
      INSERT INTO publish_jobs (batch_id, variant_id, platform, job_type, scheduled_at, metadata_json)
      VALUES (?, ?, ?, ?, datetime('now'), ?)
    `).run('b1', 'v1', 'Dev.to', 'publish', JSON.stringify({ bypass_reasons: ['test'] }));
    const result = runPrecheck(db, ['https://x.com'], defaultBrand());
    expect(result.bypassCountThisWeek).toBe(1);
    db.close();
  });

  it('does not count old bypasses', () => {
    const db = freshDb();
    db.prepare(`
      INSERT INTO publish_jobs (batch_id, variant_id, platform, job_type, scheduled_at, created_at, metadata_json)
      VALUES (?, ?, ?, ?, datetime('now', '-10 days'), datetime('now', '-10 days'), ?)
    `).run('b1', 'v1', 'Dev.to', 'publish', JSON.stringify({ bypass_reasons: ['old'] }));
    const result = runPrecheck(db, ['https://x.com'], defaultBrand());
    expect(result.bypassCountThisWeek).toBe(0);
    db.close();
  });
});

describe('isUrlOverCap', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });
  afterEach(() => db.close());

  it('returns false when under cap', () => {
    expect(isUrlOverCap(db, 'https://x.com', 6)).toBe(false);
  });

  it('returns true when count equals cap', () => {
    for (let i = 0; i < 6; i++) {
      db.prepare(`
        INSERT INTO anchor_history (batch_id, variant_id, platform, anchor_text, target_url, used_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
      `).run(`b${i}`, `v${i}`, 'Dev.to', 'a', 'https://x.com');
    }
    expect(isUrlOverCap(db, 'https://x.com', 6)).toBe(true);
  });
});
