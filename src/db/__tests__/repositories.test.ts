import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyV2Schema } from '../schema';
import {
  brandProfile,
  publishJobs,
  linkChecks,
  anchorHistory,
  llmCalls,
  draftBatches,
} from '../repositories';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  applyV2Schema(db);
  return db;
}

describe('brandProfile', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });
  afterEach(() => db.close());

  it('returns null when no profile exists', () => {
    expect(brandProfile.get(db)).toBeNull();
  });

  it('first upsertMain inserts the row', () => {
    const profile = brandProfile.upsertMain(db, {
      name: '测试品牌',
      target_urls: [{ url: 'https://example.com', context_tag: 'home' }],
      exposure_blocklist: ['a', 'b', 'c', 'd', 'e'],
    });
    expect(profile.name).toBe('测试品牌');
    expect(profile.brand_id).toBe('main');
    expect(profile.target_urls).toHaveLength(1);
  });

  it('subsequent upsertMain updates same row (uses default values for unspecified fields)', () => {
    brandProfile.upsertMain(db, { name: 'A' });
    const updated = brandProfile.upsertMain(db, {
      name: 'B',
      anchor_concentration_threshold: 0.25,
    });
    expect(updated.name).toBe('B');
    expect(updated.anchor_concentration_threshold).toBe(0.25);
    // weekly_url_cap should retain its default (6) because not specified
    expect(updated.weekly_url_cap).toBe(6);
  });

  it('stores defaults: jaccard_threshold=0.5, weekly_url_cap=6, anchor_threshold=0.30', () => {
    const profile = brandProfile.upsertMain(db, { name: 'X' });
    expect(profile.jaccard_threshold).toBe(0.5);
    expect(profile.weekly_url_cap).toBe(6);
    expect(profile.anchor_concentration_threshold).toBe(0.30);
    expect(profile.digest_channel).toBe('none');
  });

  it('round-trips JSON columns through parse/stringify', () => {
    brandProfile.upsertMain(db, {
      name: 'X',
      name_variants: ['x', 'X-brand', 'xbrand'],
      target_urls: [
        { url: 'https://x.com', context_tag: 'home' },
        { url: 'https://x.com/p', context_tag: 'product' },
      ],
      exposure_blocklist: ['作为我们', 'as we', '本品牌'],
      anchor_blocklist: ['click here'],
    });
    const got = brandProfile.get(db)!;
    expect(got.name_variants).toEqual(['x', 'X-brand', 'xbrand']);
    expect(got.target_urls).toHaveLength(2);
    expect(got.exposure_blocklist).toContain('作为我们');
    expect(got.anchor_blocklist).toEqual(['click here']);
  });
});

describe('publishJobs', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });
  afterEach(() => db.close());

  it('insert + dequeue returns job and transitions to running', () => {
    publishJobs.insert(db, {
      batch_id: 'b1',
      variant_id: 'v1',
      platform: 'Dev.to',
      job_type: 'publish',
      scheduled_at: '2026-04-30T00:00:00Z',
    });
    const dequeued = publishJobs.dequeueDue(db, '2026-04-30T01:00:00Z', 5);
    expect(dequeued).toHaveLength(1);
    expect(dequeued[0].status).toBe('running');
    expect(dequeued[0].attempts).toBe(1);
  });

  it('does not return future jobs', () => {
    publishJobs.insert(db, {
      batch_id: 'b1',
      variant_id: 'v1',
      platform: 'Dev.to',
      job_type: 'publish',
      scheduled_at: '2026-05-01T00:00:00Z',
    });
    const dequeued = publishJobs.dequeueDue(db, '2026-04-30T01:00:00Z', 5);
    expect(dequeued).toHaveLength(0);
  });

  it('UNIQUE constraint via INSERT OR IGNORE — duplicate enqueue is no-op', () => {
    const id1 = publishJobs.insert(db, {
      batch_id: 'b1',
      variant_id: 'v1',
      platform: 'Dev.to',
      job_type: 'health_check_t24h',
      scheduled_at: '2026-04-30T00:00:00Z',
    });
    const id2 = publishJobs.insert(db, {
      batch_id: 'b1',
      variant_id: 'v1',
      platform: 'Dev.to',
      job_type: 'health_check_t24h',
      scheduled_at: '2026-04-30T00:00:00Z',
    });
    expect(id1).toBeGreaterThan(0);
    // Second insert is OR IGNORE so lastInsertRowid is the unchanged id of last successful insert.
    const all = publishJobs.byBatch(db, 'b1');
    expect(all).toHaveLength(1);
    void id2;
  });

  it('markFailed transitions to scheduled when attempts < maxAttempts', () => {
    publishJobs.insert(db, {
      batch_id: 'b',
      variant_id: 'v',
      platform: 'Dev.to',
      job_type: 'publish',
      scheduled_at: '2026-04-30T00:00:00Z',
    });
    const [job] = publishJobs.dequeueDue(db, '2026-04-30T01:00:00Z', 5);
    const status = publishJobs.markFailed(db, job.id, 'transient', '2026-04-30T01:30:00Z', 2);
    expect(status).toBe('scheduled');
  });

  it('markFailed transitions to failed_terminal at maxAttempts', () => {
    publishJobs.insert(db, {
      batch_id: 'b',
      variant_id: 'v',
      platform: 'Dev.to',
      job_type: 'publish',
      scheduled_at: '2026-04-30T00:00:00Z',
    });
    // First attempt — fail, retry scheduled
    const [j1] = publishJobs.dequeueDue(db, '2026-04-30T01:00:00Z', 5);
    publishJobs.markFailed(db, j1.id, 'e1', '2026-04-30T02:00:00Z', 2);
    // Second attempt — fail, hits max
    const [j2] = publishJobs.dequeueDue(db, '2026-04-30T03:00:00Z', 5);
    const status = publishJobs.markFailed(db, j2.id, 'e2', '2026-04-30T04:00:00Z', 2);
    expect(status).toBe('failed_terminal');
  });

  it('resetZombies turns stale running jobs into failed_retryable', () => {
    publishJobs.insert(db, {
      batch_id: 'b',
      variant_id: 'v',
      platform: 'Dev.to',
      job_type: 'publish',
      scheduled_at: '2026-04-30T00:00:00Z',
    });
    publishJobs.dequeueDue(db, '2026-04-30T01:00:00Z', 5);
    // Pretend updated_at is stale by directly editing
    db.prepare(`UPDATE publish_jobs SET updated_at = '2020-01-01T00:00:00Z'`).run();
    const reset = publishJobs.resetZombies(db, '2025-01-01T00:00:00Z');
    expect(reset).toBe(1);
    const counts = publishJobs.countByStatus(db);
    expect(counts.failed_retryable).toBe(1);
    expect(counts.running).toBe(0);
  });

  it('countByStatus sums correctly across statuses', () => {
    publishJobs.insert(db, {
      batch_id: 'b1',
      variant_id: 'v1',
      platform: 'Dev.to',
      job_type: 'publish',
      scheduled_at: '2026-04-30T00:00:00Z',
    });
    publishJobs.insert(db, {
      batch_id: 'b1',
      variant_id: 'v2',
      platform: 'Medium',
      job_type: 'publish',
      scheduled_at: '2026-04-30T00:00:00Z',
    });
    const counts = publishJobs.countByStatus(db);
    expect(counts.scheduled).toBe(2);
    expect(counts.running).toBe(0);
  });
});

describe('linkChecks', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });
  afterEach(() => db.close());

  it('insert + survivalRate computes ratio over checked_at window', () => {
    for (let i = 0; i < 8; i++) {
      linkChecks.insert(db, {
        batch_id: `b${i}`,
        variant_id: `v${i}`,
        platform: 'Dev.to',
        published_url: `https://dev.to/x${i}`,
        check_type: 't30d',
        http_status: 200,
        classification: 'alive',
      });
    }
    for (let i = 0; i < 2; i++) {
      linkChecks.insert(db, {
        batch_id: `bx${i}`,
        variant_id: `vx${i}`,
        platform: 'Dev.to',
        published_url: `https://dev.to/y${i}`,
        check_type: 't30d',
        http_status: 404,
        classification: '404',
      });
    }
    const { total, alive, rate } = linkChecks.survivalRate(db, 't30d', '2020-01-01T00:00:00Z');
    expect(total).toBe(10);
    expect(alive).toBe(8);
    expect(rate).toBeCloseTo(0.8, 5);
  });

  it('redirect_alive counts as alive in survivalRate', () => {
    linkChecks.insert(db, {
      batch_id: 'b',
      variant_id: 'v',
      platform: 'Dev.to',
      published_url: 'https://x',
      check_type: 't7d',
      http_status: 301,
      classification: 'redirect_alive',
    });
    const { rate } = linkChecks.survivalRate(db, 't7d', '2020-01-01T00:00:00Z');
    expect(rate).toBe(1);
  });

  it('returns rate=0 when no rows', () => {
    const { rate, total } = linkChecks.survivalRate(db, 't30d', '2020-01-01T00:00:00Z');
    expect(rate).toBe(0);
    expect(total).toBe(0);
  });

  it('survivalRate with platform filter isolates per-platform results', () => {
    // Medium: 3 alive t7d
    for (let i = 0; i < 3; i++) {
      linkChecks.insert(db, {
        batch_id: `m${i}`, variant_id: 'v', platform: 'Medium',
        published_url: `https://medium.com/${i}`, check_type: 't7d',
        http_status: 200, classification: 'alive',
      });
    }
    // Medium: 1 dead t7d
    linkChecks.insert(db, {
      batch_id: 'md', variant_id: 'v', platform: 'Medium',
      published_url: 'https://medium.com/dead', check_type: 't7d',
      http_status: 404, classification: '404',
    });
    // Dev.to: 2 alive t7d — should not affect Medium query
    for (let i = 0; i < 2; i++) {
      linkChecks.insert(db, {
        batch_id: `d${i}`, variant_id: 'v', platform: 'Dev.to',
        published_url: `https://dev.to/${i}`, check_type: 't7d',
        http_status: 200, classification: 'alive',
      });
    }

    const medium = linkChecks.survivalRate(db, 't7d', '2020-01-01T00:00:00Z', 'Medium');
    expect(medium.total).toBe(4);
    expect(medium.alive).toBe(3);
    expect(medium.rate).toBeCloseTo(0.75, 5);

    // aggregate (no platform) includes all 6
    const all = linkChecks.survivalRate(db, 't7d', '2020-01-01T00:00:00Z');
    expect(all.total).toBe(6);
  });

  it('survivalRecordCount returns exact count within window for platform', () => {
    for (let i = 0; i < 5; i++) {
      linkChecks.insert(db, {
        batch_id: `h${i}`, variant_id: 'v', platform: 'Hashnode',
        published_url: `https://hashnode.com/${i}`, check_type: 't7d',
        http_status: 200, classification: 'alive',
      });
    }
    // different platform — should not be counted
    linkChecks.insert(db, {
      batch_id: 'other', variant_id: 'v', platform: 'Blogger',
      published_url: 'https://blogger.com/1', check_type: 't7d',
      http_status: 200, classification: 'alive',
    });

    expect(linkChecks.survivalRecordCount(db, 't7d', 'Hashnode', '2020-01-01T00:00:00Z')).toBe(5);
    expect(linkChecks.survivalRecordCount(db, 't7d', 'Medium', '2020-01-01T00:00:00Z')).toBe(0);
    expect(linkChecks.survivalRecordCount(db, 't30d', 'Hashnode', '2020-01-01T00:00:00Z')).toBe(0);
  });

  it('aliveUrlsPool returns alive non-WordPress URLs', () => {
    linkChecks.insert(db, {
      batch_id: 'b1', variant_id: 'v1', platform: 'Dev.to',
      published_url: 'https://dev.to/article', check_type: 't7d',
      http_status: 200, classification: 'alive',
    });
    linkChecks.insert(db, {
      batch_id: 'b2', variant_id: 'v2', platform: 'Medium',
      published_url: 'https://medium.com/article', check_type: 't30d',
      http_status: 200, classification: 'redirect_alive',
    });
    // Dead URL — excluded
    linkChecks.insert(db, {
      batch_id: 'b3', variant_id: 'v3', platform: 'Hashnode',
      published_url: 'https://hashnode.com/dead', check_type: 't7d',
      http_status: 404, classification: '404',
    });
    // WordPress — excluded by anti-tier-3 guard
    linkChecks.insert(db, {
      batch_id: 'b4', variant_id: 'v4', platform: 'WordPress',
      published_url: 'https://mysite.wordpress.com/post', check_type: 't7d',
      http_status: 200, classification: 'alive',
    });

    const pool = linkChecks.aliveUrlsPool(db);
    expect(pool).toHaveLength(2);
    const platforms = pool.map(r => r.platform).sort();
    expect(platforms).toEqual(['Dev.to', 'Medium']);
    expect(pool.find(r => r.platform === 'WordPress')).toBeUndefined();
  });

  it('aliveUrlsPool deduplicates same URL across check_type rows', () => {
    // Same URL at t7d and t30d — should appear once
    for (const check_type of ['t7d', 't30d'] as const) {
      linkChecks.insert(db, {
        batch_id: `b-${check_type}`, variant_id: 'v1', platform: 'Dev.to',
        published_url: 'https://dev.to/article', check_type,
        http_status: 200, classification: 'alive',
      });
    }
    const pool = linkChecks.aliveUrlsPool(db);
    expect(pool).toHaveLength(1);
    expect(pool[0].platform).toBe('Dev.to');
  });

  it('aliveUrlsPool returns empty when only WordPress URLs exist', () => {
    linkChecks.insert(db, {
      batch_id: 'b1', variant_id: 'v1', platform: 'WordPress',
      published_url: 'https://mysite.wordpress.com/post', check_type: 't7d',
      http_status: 200, classification: 'alive',
    });
    expect(linkChecks.aliveUrlsPool(db)).toHaveLength(0);
  });

  it('aliveUrlsPool returns empty on empty link_checks', () => {
    expect(linkChecks.aliveUrlsPool(db)).toHaveLength(0);
  });
});

describe('anchorHistory', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });
  afterEach(() => db.close());

  it('weeklyCountForUrl counts only rows since the cutoff', () => {
    const url = 'https://example.com/product';
    for (let i = 0; i < 6; i++) {
      anchorHistory.insert(db, {
        batch_id: `b${i}`,
        variant_id: `v${i}`,
        platform: 'Dev.to',
        anchor_text: 'click here',
        target_url: url,
      });
    }
    expect(anchorHistory.weeklyCountForUrl(db, url, '2020-01-01T00:00:00Z')).toBe(6);
  });

  it('topInRecentBatches returns frequency + ratio', () => {
    // 3 batches, 'click here' used twice, 'see this' used once
    for (const [i, anchor] of [
      ['b1', 'click here'],
      ['b1', 'click here'],
      ['b2', 'click here'],
      ['b2', 'see this'],
      ['b3', 'see this'],
    ] as const) {
      anchorHistory.insert(db, {
        batch_id: i,
        variant_id: `v_${anchor}`,
        platform: 'Dev.to',
        anchor_text: anchor,
        target_url: 'https://x',
      });
    }
    const top = anchorHistory.topInRecentBatches(db, 30, 10);
    expect(top[0].anchor).toBe('click here');
    expect(top[0].count).toBe(3);
    expect(top[0].ratio).toBeCloseTo(3 / 5, 5);
  });

  it('insert with is_tier2=true round-trips to 1 in SELECT', () => {
    anchorHistory.insert(db, {
      batch_id: 'b1',
      variant_id: 'v1',
      platform: 'WordPress',
      anchor_text: 'dev guide',
      target_url: 'https://dev.to/user/some-post',
      is_tier2: true,
    });
    const row = db.prepare(
      `SELECT is_tier2 FROM anchor_history WHERE batch_id = 'b1'`,
    ).get() as { is_tier2: number };
    expect(row.is_tier2).toBe(1);
  });

  it('insert without is_tier2 defaults to 0', () => {
    anchorHistory.insert(db, {
      batch_id: 'b2',
      variant_id: 'v2',
      platform: 'Dev.to',
      anchor_text: 'some anchor',
      target_url: 'https://example.com',
    });
    const row = db.prepare(
      `SELECT is_tier2 FROM anchor_history WHERE batch_id = 'b2'`,
    ).get() as { is_tier2: number };
    expect(row.is_tier2).toBe(0);
  });

  it('usedAsTier2InWindow returns true when URL used within window', () => {
    const url = 'https://dev.to/user/article';
    anchorHistory.insert(db, {
      batch_id: 'b1', variant_id: 'v1', platform: 'WordPress',
      anchor_text: 'article', target_url: url, is_tier2: true,
    });
    expect(anchorHistory.usedAsTier2InWindow(db, url, '2020-01-01T00:00:00Z')).toBe(true);
  });

  it('usedAsTier2InWindow returns false when URL is outside window', () => {
    const url = 'https://dev.to/user/article';
    anchorHistory.insert(db, {
      batch_id: 'b1', variant_id: 'v1', platform: 'WordPress',
      anchor_text: 'article', target_url: url, is_tier2: true,
    });
    // Use far-future cutoff so the row falls outside the window
    expect(anchorHistory.usedAsTier2InWindow(db, url, '2099-01-01T00:00:00Z')).toBe(false);
  });

  it('usedAsTier2InWindow returns false when is_tier2=0', () => {
    const url = 'https://example.com';
    anchorHistory.insert(db, {
      batch_id: 'b1', variant_id: 'v1', platform: 'Dev.to',
      anchor_text: 'link', target_url: url,
    });
    expect(anchorHistory.usedAsTier2InWindow(db, url, '2020-01-01T00:00:00Z')).toBe(false);
  });
});

describe('llmCalls', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });
  afterEach(() => db.close());

  it('record + spendBetween sums cost over time window', () => {
    llmCalls.record(db, {
      kind: 'variant_body',
      model: 'gpt-4o-mini',
      input_tokens: 1000,
      output_tokens: 500,
      cost_usd: 0.45,
    });
    llmCalls.record(db, {
      kind: 'variant_anchor',
      model: 'gpt-4o-mini',
      input_tokens: 200,
      output_tokens: 30,
      cost_usd: 0.05,
    });
    const total = llmCalls.spendBetween(db, '2020-01-01T00:00:00Z', '2099-01-01T00:00:00Z');
    expect(total).toBeCloseTo(0.5, 5);
  });

  it('returns 0 when no rows', () => {
    expect(
      llmCalls.spendBetween(db, '2020-01-01T00:00:00Z', '2099-01-01T00:00:00Z'),
    ).toBe(0);
  });
});

describe('draftBatches', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });
  afterEach(() => db.close());

  it('save + load round-trips a draft', () => {
    draftBatches.save(db, {
      batch_id: 'b1',
      draft_text: 'hello world',
    });
    const loaded = draftBatches.load(db, 'b1');
    expect(loaded?.draft_text).toBe('hello world');
    expect(loaded?.status).toBe('drafting');
    expect(loaded?.brand_id).toBe('main');
  });

  it('save is upsert — second call replaces fields', () => {
    draftBatches.save(db, { batch_id: 'b1', draft_text: 'a' });
    draftBatches.save(db, { batch_id: 'b1', draft_text: 'b', status: 'dispatched' });
    const loaded = draftBatches.load(db, 'b1');
    expect(loaded?.draft_text).toBe('b');
    expect(loaded?.status).toBe('dispatched');
  });

  it('archive transitions status', () => {
    draftBatches.save(db, { batch_id: 'b1', draft_text: 'x' });
    draftBatches.archive(db, 'b1');
    const loaded = draftBatches.load(db, 'b1');
    expect(loaded?.status).toBe('archived');
  });
});
