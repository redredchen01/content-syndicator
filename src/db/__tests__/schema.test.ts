import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyV2Schema, addColumnIfMissing } from '../schema';

describe('applyV2Schema', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('creates all 8 tables (1 v0.1 + 1 task_progress + 6 v0.2)', () => {
    applyV2Schema(db);
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('posts');
    expect(names).toContain('task_progress');
    expect(names).toContain('brand_profiles');
    expect(names).toContain('publish_jobs');
    expect(names).toContain('link_checks');
    expect(names).toContain('anchor_history');
    expect(names).toContain('llm_calls');
    expect(names).toContain('draft_batches');
  });

  it('adds new posts columns idempotently (legacy rows keep NULL)', () => {
    // Simulate v0.1 disk: posts exists with only legacy columns
    db.exec(`
      CREATE TABLE posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        original_url TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        results_json TEXT NOT NULL
      )
    `);
    db.prepare(
      'INSERT INTO posts (original_url, title, content, results_json) VALUES (?, ?, ?, ?)',
    ).run('https://x', 't', 'c', '[]');

    applyV2Schema(db);

    const row = db.prepare('SELECT * FROM posts').get() as Record<string, unknown>;
    expect(row.batch_id).toBeNull();
    expect(row.brand_id).toBe('main');
    expect(row.published_url).toBeNull();
  });

  it('is fully idempotent — running twice does not error', () => {
    applyV2Schema(db);
    expect(() => applyV2Schema(db)).not.toThrow();
  });

  it('brand_profiles single-row trigger blocks a second INSERT', () => {
    applyV2Schema(db);
    db.prepare(
      `INSERT INTO brand_profiles (brand_id, name) VALUES ('main', 'BrandA')`,
    ).run();
    expect(() =>
      db
        .prepare(`INSERT INTO brand_profiles (brand_id, name) VALUES ('main2', 'BrandB')`)
        .run(),
    ).toThrowError(/single-row only/);
  });

  it('publish_jobs UNIQUE on (batch_id, variant_id, platform, job_type)', () => {
    applyV2Schema(db);
    const ins = db.prepare(`
      INSERT INTO publish_jobs (batch_id, variant_id, platform, job_type, scheduled_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    ins.run('b1', 'v1', 'Dev.to', 'publish', '2026-04-30T00:00:00Z');
    // Second insert with same key should error (or we use INSERT OR IGNORE elsewhere)
    expect(() =>
      ins.run('b1', 'v1', 'Dev.to', 'publish', '2026-04-30T00:00:00Z'),
    ).toThrowError(/UNIQUE/);
  });

  it('publish_jobs status CHECK rejects unknown values', () => {
    applyV2Schema(db);
    expect(() =>
      db
        .prepare(`
        INSERT INTO publish_jobs (batch_id, variant_id, platform, job_type, scheduled_at, status)
        VALUES ('b','v','p','publish','2026-04-30T00:00:00Z','wat')
      `)
        .run(),
    ).toThrowError(/CHECK/);
  });

  it('link_checks classification CHECK rejects unknown values', () => {
    applyV2Schema(db);
    expect(() =>
      db
        .prepare(`
        INSERT INTO link_checks (batch_id, variant_id, platform, published_url, check_type, classification)
        VALUES ('b','v','p','u','t24h','what')
      `)
        .run(),
    ).toThrowError(/CHECK/);
  });
});

describe('addColumnIfMissing', () => {
  it('skips when column already exists', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (a INTEGER, b INTEGER)');
    expect(() => addColumnIfMissing(db, 't', 'b', 'INTEGER')).not.toThrow();
    db.close();
  });

  it('adds column when missing', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (a INTEGER)');
    addColumnIfMissing(db, 't', 'b', "TEXT DEFAULT 'x'");
    const cols = db.prepare('PRAGMA table_info(t)').all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain('b');
    db.close();
  });
});
