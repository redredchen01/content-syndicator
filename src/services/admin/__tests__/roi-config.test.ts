import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { applyV2Schema } from '../../../db/schema';

vi.mock('../../../utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  },
}));

import { getPlatformHealth, updateRoiConfig } from '../roi-config';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  applyV2Schema(db);
  return db;
}

function seedMainProfile(db: Database.Database): void {
  db.prepare(
    'INSERT INTO brand_profiles (brand_id, name, name_variants_json, target_urls_json, exposure_blocklist_json, anchor_blocklist_json) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('main', 'Test Brand', '[]', '[]', '[]', '[]');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getPlatformHealth', () => {
  it('returns array (never throws); falls back to insufficient when underlying fails', () => {
    const db = freshDb();
    // No seed data — computePlatformHealth may return real or fallback array; either is OK
    const result = getPlatformHealth(db);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    for (const item of result) {
      expect(item).toHaveProperty('platform');
      expect(item).toHaveProperty('roiScore');
    }
  });
});

describe('updateRoiConfig', () => {
  it('rejects non-numeric threshold with 400', () => {
    const db = freshDb();
    seedMainProfile(db);
    const r = updateRoiConfig(db, { threshold: 'high' });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(r.error).toMatch(/threshold/);
  });

  it('rejects threshold > 1 with 400', () => {
    const db = freshDb();
    seedMainProfile(db);
    const r = updateRoiConfig(db, { threshold: 1.5 });
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it('rejects threshold < 0 with 400', () => {
    const db = freshDb();
    seedMainProfile(db);
    const r = updateRoiConfig(db, { threshold: -0.1 });
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it('rejects unknown platform key in daTierConfig', () => {
    const db = freshDb();
    seedMainProfile(db);
    const r = updateRoiConfig(db, { threshold: 0.5, daTierConfig: { 'NonExistent': 0.6 } });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(r.error).toMatch(/Unknown platform/);
  });

  it('rejects invalid tier score (not in 0.3/0.6/1.0)', () => {
    const db = freshDb();
    seedMainProfile(db);
    const r = updateRoiConfig(db, { threshold: 0.5, daTierConfig: { 'Dev.to': 0.5 } });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(r.error).toMatch(/Invalid tier score/);
  });

  it('rejects when brand profile is not configured (no main row)', () => {
    const db = freshDb();
    // No seedMainProfile — main row missing
    const r = updateRoiConfig(db, { threshold: 0.5 });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(r.error).toMatch(/Brand profile not configured/);
  });

  it('persists valid threshold + merges daTierConfig', () => {
    const db = freshDb();
    seedMainProfile(db);
    // First update
    const r1 = updateRoiConfig(db, { threshold: 0.4, daTierConfig: { 'Dev.to': 1.0 } });
    expect(r1.ok).toBe(true);
    expect(r1.daTierConfig).toEqual({ 'Dev.to': 1.0 });
    expect(r1.threshold).toBe(0.4);

    // Second update with different platform — should merge, not replace
    const r2 = updateRoiConfig(db, { threshold: 0.6, daTierConfig: { 'Medium': 0.6 } });
    expect(r2.ok).toBe(true);
    expect(r2.daTierConfig).toEqual({ 'Dev.to': 1.0, 'Medium': 0.6 });
    expect(r2.threshold).toBe(0.6);

    // Verify persistence
    const row = db.prepare('SELECT da_tier_config_json, roi_threshold FROM brand_profiles WHERE brand_id = ?').get('main') as
      { da_tier_config_json: string; roi_threshold: number };
    expect(JSON.parse(row.da_tier_config_json)).toEqual({ 'Dev.to': 1.0, 'Medium': 0.6 });
    expect(row.roi_threshold).toBe(0.6);
  });

  it('accepts threshold without daTierConfig', () => {
    const db = freshDb();
    seedMainProfile(db);
    const r = updateRoiConfig(db, { threshold: 0.5 });
    expect(r.ok).toBe(true);
    expect(r.threshold).toBe(0.5);
  });
});
