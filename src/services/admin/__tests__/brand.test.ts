import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { applyV2Schema } from '../../../db/schema';
import {
  getBrandProfileWithDispatch,
  saveBrandProfileFromInput,
  runPrecheckForDispatch,
  updatePreferredPlatformsForBrand,
  getPreferredPlatformsForBrand,
} from '../brand';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  applyV2Schema(db);
  return db;
}

describe('saveBrandProfileFromInput', () => {
  it('rejects body that is not an object with status 400', () => {
    const db = freshDb();
    const r = saveBrandProfileFromInput(db, 'not-an-object');
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(r.errors?.[0].field).toBe('body');
  });

  it('rejects empty name with status 422', () => {
    const db = freshDb();
    const r = saveBrandProfileFromInput(db, { name: '   ' });
    expect(r).toMatchObject({ ok: false, status: 422 });
    expect(r.errors?.[0].field).toBe('name');
  });

  it('persists valid profile and returns dispatch readiness', () => {
    const db = freshDb();
    const r = saveBrandProfileFromInput(db, { name: '小赵的工作室' });
    expect(r.ok).toBe(true);
    expect(r.profile?.name).toBe('小赵的工作室');
    expect(typeof r.dispatchReady).toBe('boolean');
    expect(r.dispatchReport).toBeDefined();
  });

  it('forwards saveProfile validation errors with status 422', () => {
    const db = freshDb();
    const r = saveBrandProfileFromInput(db, {
      name: 'X',
      target_urls: ['not-an-object'], // each entry must be { url, context_tag }
    });
    expect(r).toMatchObject({ ok: false, status: 422 });
    expect(r.errors?.length).toBeGreaterThan(0);
  });
});

describe('getBrandProfileWithDispatch', () => {
  it('returns null profile when none persisted', () => {
    const db = freshDb();
    const r = getBrandProfileWithDispatch(db);
    expect(r.profile).toBeNull();
    expect(r.dispatchReady).toBe(false);
  });

  it('returns persisted profile + dispatch flag after save', () => {
    const db = freshDb();
    saveBrandProfileFromInput(db, { name: 'Brand X' });
    const r = getBrandProfileWithDispatch(db);
    expect(r.profile?.name).toBe('Brand X');
  });
});

describe('runPrecheckForDispatch', () => {
  it('returns 412 when no profile is configured', () => {
    const db = freshDb();
    const r = runPrecheckForDispatch(db, { target_urls: ['https://x.com'] });
    expect(r).toMatchObject({ ok: false, status: 412 });
    expect(r.error).toContain('品牌资料库');
  });

  it('returns precheck result when profile exists', () => {
    const db = freshDb();
    saveBrandProfileFromInput(db, { name: 'Brand X' });
    const r = runPrecheckForDispatch(db, { target_urls: ['https://example.com/a'] });
    expect(r.ok).toBe(true);
    expect(r.result).toBeDefined();
  });

  it('filters non-string entries from target_urls without throwing', () => {
    const db = freshDb();
    saveBrandProfileFromInput(db, { name: 'Brand X' });
    const r = runPrecheckForDispatch(db, { target_urls: ['https://x', 42, null, 'https://y'] });
    expect(r.ok).toBe(true);
  });
});

describe('updatePreferredPlatformsForBrand', () => {
  it('returns 400 when platforms is not array', () => {
    const db = freshDb();
    const r = updatePreferredPlatformsForBrand(db, { platforms: 'devto' });
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it('persists preferred platforms when valid', () => {
    const db = freshDb();
    saveBrandProfileFromInput(db, { name: 'Brand X' });
    const r = updatePreferredPlatformsForBrand(db, { platforms: ['Dev.to', 'GitHub'] });
    expect(r.ok).toBe(true);
    expect(r.preferredPlatforms).toEqual(expect.arrayContaining(['Dev.to', 'GitHub']));
  });
});

describe('getPreferredPlatformsForBrand', () => {
  it('returns empty array when no profile / no preferred set', () => {
    const db = freshDb();
    expect(getPreferredPlatformsForBrand(db)).toEqual([]);
  });
});
