import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyV2Schema } from '../../db/schema';
import {
  getPreferredPlatforms,
  getProfile,
  isReadyForDispatch,
  saveProfile,
  updatePreferredPlatforms,
  validateForDispatch,
  validateForSave,
} from '../brand-profile';

function freshDb() {
  const db = new Database(':memory:');
  applyV2Schema(db);
  return db;
}

describe('validateForSave', () => {
  it('passes when input is empty (only types matter)', () => {
    const r = validateForSave({});
    expect(r.valid).toBe(true);
  });

  it('rejects non-string name', () => {
    const r = validateForSave({ name: 123 as unknown as string });
    expect(r.valid).toBe(false);
    expect(r.errors[0].field).toBe('name');
  });

  it('rejects target_urls without context_tag', () => {
    const r = validateForSave({
      target_urls: [{ url: 'https://x' } as any],
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.field.includes('context_tag'))).toBe(true);
  });

  it('rejects digest_channel outside enum', () => {
    const r = validateForSave({ digest_channel: 'sms' as any });
    expect(r.valid).toBe(false);
  });

  it('rejects jaccard_threshold > 1', () => {
    const r = validateForSave({ jaccard_threshold: 1.5 });
    expect(r.valid).toBe(false);
  });

  it('rejects weekly_url_cap < 1', () => {
    const r = validateForSave({ weekly_url_cap: 0 });
    expect(r.valid).toBe(false);
  });

  it('accepts a valid full payload', () => {
    const r = validateForSave({
      name: 'Acme',
      target_urls: [{ url: 'https://x', context_tag: 'home' }],
      exposure_blocklist: ['a', 'b', 'c', 'd', 'e'],
      digest_channel: 'email',
      weekly_url_cap: 6,
      jaccard_threshold: 0.5,
    });
    expect(r.valid).toBe(true);
  });
});

describe('validateForDispatch (R3 gate)', () => {
  it('rejects null profile (form never filled)', () => {
    const r = validateForDispatch(null);
    expect(r.valid).toBe(false);
    expect(r.errors[0].field).toBe('name');
  });

  it('rejects empty name', () => {
    const r = validateForDispatch({
      brand_id: 'main',
      name: '',
      name_variants: [],
      target_urls: [{ url: 'https://x', context_tag: 'home' }],
      exposure_blocklist: ['a', 'b', 'c', 'd', 'e'],
      anchor_blocklist: [],
      signature: null,
      anchor_concentration_threshold: 0.3,
      weekly_url_cap: 6,
      jaccard_threshold: 0.5,
      digest_channel: 'none',
      digest_destination: null,
      updated_at: '2026-04-30T00:00:00Z',
    });
    expect(r.valid).toBe(false);
    expect(r.errors[0].field).toBe('name');
  });

  it('rejects 0 target_urls', () => {
    const r = validateForDispatch({
      brand_id: 'main',
      name: 'Acme',
      name_variants: [],
      target_urls: [],
      exposure_blocklist: ['a', 'b', 'c', 'd', 'e'],
      anchor_blocklist: [],
      signature: null,
      anchor_concentration_threshold: 0.3,
      weekly_url_cap: 6,
      jaccard_threshold: 0.5,
      digest_channel: 'none',
      digest_destination: null,
      updated_at: '2026-04-30T00:00:00Z',
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.field === 'target_urls')).toBe(true);
  });

  it('rejects fewer than 5 exposure_blocklist entries', () => {
    const r = validateForDispatch({
      brand_id: 'main',
      name: 'Acme',
      name_variants: [],
      target_urls: [{ url: 'https://x', context_tag: 'home' }],
      exposure_blocklist: ['a', 'b'],
      anchor_blocklist: [],
      signature: null,
      anchor_concentration_threshold: 0.3,
      weekly_url_cap: 6,
      jaccard_threshold: 0.5,
      digest_channel: 'none',
      digest_destination: null,
      updated_at: '2026-04-30T00:00:00Z',
    });
    expect(r.valid).toBe(false);
    expect(r.errors[0].message).toMatch(/至少 5 条/);
  });

  it('rejects malformed target_url (no http(s)://)', () => {
    const r = validateForDispatch({
      brand_id: 'main',
      name: 'Acme',
      name_variants: [],
      target_urls: [{ url: 'example.com', context_tag: 'home' }],
      exposure_blocklist: ['a', 'b', 'c', 'd', 'e'],
      anchor_blocklist: [],
      signature: null,
      anchor_concentration_threshold: 0.3,
      weekly_url_cap: 6,
      jaccard_threshold: 0.5,
      digest_channel: 'none',
      digest_destination: null,
      updated_at: '2026-04-30T00:00:00Z',
    });
    expect(r.valid).toBe(false);
  });

  it('passes a fully valid profile', () => {
    const r = validateForDispatch({
      brand_id: 'main',
      name: 'Acme',
      name_variants: [],
      target_urls: [{ url: 'https://acme.com', context_tag: 'home' }],
      exposure_blocklist: ['作为我们', 'as we', '本品牌', 'our team', 'official'],
      anchor_blocklist: [],
      signature: null,
      anchor_concentration_threshold: 0.3,
      weekly_url_cap: 6,
      jaccard_threshold: 0.5,
      digest_channel: 'none',
      digest_destination: null,
      updated_at: '2026-04-30T00:00:00Z',
    });
    expect(r.valid).toBe(true);
  });
});

describe('saveProfile (adversarial F7 protection)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });
  afterEach(() => db.close());

  it('first save persists the profile', () => {
    const r = saveProfile(db, {
      name: 'Acme',
      target_urls: [{ url: 'https://acme.com', context_tag: 'home' }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.profile.brand_id).toBe('main');
  });

  it('IGNORES client-supplied brand_id — always writes to "main"', () => {
    const r = saveProfile(db, {
      brand_id: 'main2',
      name: 'Acme',
    });
    expect(r.ok).toBe(true);
    // Verify only one row exists, with brand_id='main'
    const rows = db.prepare('SELECT brand_id FROM brand_profiles').all() as Array<{
      brand_id: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].brand_id).toBe('main');
  });

  it('rejects programmer errors (validation fails)', () => {
    const r = saveProfile(db, {
      name: 'Acme',
      digest_channel: 'sms' as 'email',
    });
    expect(r.ok).toBe(false);
  });

  it('subsequent save is upsert (no row count change)', () => {
    saveProfile(db, { name: 'A' });
    saveProfile(db, { name: 'B' });
    const rows = db.prepare('SELECT * FROM brand_profiles').all();
    expect(rows).toHaveLength(1);
  });
});

describe('updatePreferredPlatforms + getPreferredPlatforms round-trip', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    // Create the 'main' row that updatePreferredPlatforms targets
    saveProfile(db, { name: 'Test' });
  });
  afterEach(() => db.close());

  it('writes platforms and reads them back', () => {
    const r = updatePreferredPlatforms(db, ['github', 'medium']);
    expect(r.ok).toBe(true);
    expect(getPreferredPlatforms(db)).toEqual(['github', 'medium']);
  });

  it('overwrites on repeated calls — only latest value persists', () => {
    updatePreferredPlatforms(db, ['github', 'medium']);
    updatePreferredPlatforms(db, ['twitter']);
    expect(getPreferredPlatforms(db)).toEqual(['twitter']);
  });

  it('rejects empty array — returns error, DB unchanged', () => {
    updatePreferredPlatforms(db, ['github']);
    const r = updatePreferredPlatforms(db, []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/至少选择一个/);
    // DB value unchanged
    expect(getPreferredPlatforms(db)).toEqual(['github']);
  });

  it('rejects non-array input', () => {
    const r = updatePreferredPlatforms(db, null as unknown as string[]);
    expect(r.ok).toBe(false);
  });
});

describe('getProfile + isReadyForDispatch end-to-end', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });
  afterEach(() => db.close());

  it('returns null + not ready when nothing saved', () => {
    expect(getProfile(db)).toBeNull();
    expect(isReadyForDispatch(db).ready).toBe(false);
  });

  it('saves partial → still not ready', () => {
    saveProfile(db, { name: 'Acme' });
    expect(isReadyForDispatch(db).ready).toBe(false);
  });

  it('saves full → ready', () => {
    saveProfile(db, {
      name: 'Acme',
      target_urls: [{ url: 'https://acme.com', context_tag: 'home' }],
      exposure_blocklist: ['作为我们', 'as we', '本品牌', 'our team', 'official'],
    });
    expect(isReadyForDispatch(db).ready).toBe(true);
  });
});
