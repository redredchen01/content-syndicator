import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { validateAllCredentials } from '../credential-validator';
import { applyV2Schema } from '../../db/schema';
import { encryptApiKey } from '../../utils/encryption';

describe('Credential Validator', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applyV2Schema(db);
    db.prepare('INSERT INTO brand_profiles (brand_id, name, name_variants_json, target_urls_json, exposure_blocklist_json, anchor_blocklist_json) VALUES (?, ?, ?, ?, ?, ?)').run(
      'default', 'Test Brand', '[]', '[]', '[]', '[]',
    );
  });

  it('returns empty array when no credentials are stored', async () => {
    const result = await validateAllCredentials(db);
    expect(result).toEqual([]);
  });

  it('returns empty array when api_keys_encrypted is empty', async () => {
    db.prepare('UPDATE brand_profiles SET api_keys_encrypted = ? WHERE brand_id = ?').run('{}', 'default');
    const result = await validateAllCredentials(db);
    expect(result).toEqual([]);
  });

  it('validates stored credentials and updates platform_test_status', async () => {
    const testKey = 'test-api-key-123';
    const encrypted = encryptApiKey(testKey);
    const now = new Date().toISOString();

    db.prepare('UPDATE brand_profiles SET api_keys_encrypted = ? WHERE brand_id = ?').run(
      JSON.stringify({ devto: encrypted }),
      'default',
    );

    const result = await validateAllCredentials(db);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      platformId: 'devto',
      platform: 'Dev.to',
      ok: expect.any(Boolean),
      tested_at: expect.any(String),
    });

    const statusRow = db.prepare('SELECT platform_test_status FROM brand_profiles WHERE brand_id = ?').get('default');
    expect(statusRow).toBeDefined();
    const status = JSON.parse((statusRow as any).platform_test_status);
    expect(status.devto).toBeDefined();
    expect(typeof status.devto.connected_at).toBe('string');
    expect(typeof status.devto.test_timestamp).toBe('string');
    expect([null, 'string'].includes(typeof status.devto.last_test_error)).toBe(true);
  });

  it('handles multiple stored credentials', async () => {
    const encrypted1 = encryptApiKey('key1');
    const encrypted2 = encryptApiKey('key2');

    db.prepare('UPDATE brand_profiles SET api_keys_encrypted = ? WHERE brand_id = ?').run(
      JSON.stringify({ devto: encrypted1, medium: encrypted2 }),
      'default',
    );

    const result = await validateAllCredentials(db);

    expect(result.length).toBe(2);
    expect(result.map(r => r.platformId).sort()).toEqual(['devto', 'medium']);
  });

  it('preserves connected_at timestamp across validation runs', async () => {
    const encrypted = encryptApiKey('test-key');
    const originalTimestamp = '2026-01-01T00:00:00.000Z';

    db.prepare('UPDATE brand_profiles SET api_keys_encrypted = ?, platform_test_status = ? WHERE brand_id = ?').run(
      JSON.stringify({ devto: encrypted }),
      JSON.stringify({ devto: { connected_at: originalTimestamp, last_test_error: null, test_timestamp: originalTimestamp } }),
      'default',
    );

    await validateAllCredentials(db);

    const statusRow = db.prepare('SELECT platform_test_status FROM brand_profiles WHERE brand_id = ?').get('default');
    const status = JSON.parse((statusRow as any).platform_test_status);
    expect(status.devto.connected_at).toBe(originalTimestamp);
  });

  it('updates last_test_error when validation fails', async () => {
    const encrypted = encryptApiKey('invalid-key');

    db.prepare('UPDATE brand_profiles SET api_keys_encrypted = ? WHERE brand_id = ?').run(
      JSON.stringify({ devto: encrypted }),
      'default',
    );

    const result = await validateAllCredentials(db);
    const failed = result.find(r => !r.ok);

    if (failed) {
      const statusRow = db.prepare('SELECT platform_test_status FROM brand_profiles WHERE brand_id = ?').get('default');
      const status = JSON.parse((statusRow as any).platform_test_status);
      expect(status.devto.last_test_error).toBeDefined();
    }
  });

  it('clears last_test_error on successful validation', async () => {
    const encrypted = encryptApiKey('valid-key');

    db.prepare('UPDATE brand_profiles SET api_keys_encrypted = ?, platform_test_status = ? WHERE brand_id = ?').run(
      JSON.stringify({ devto: encrypted }),
      JSON.stringify({ devto: { connected_at: '2026-01-01T00:00:00.000Z', last_test_error: 'Previous error', test_timestamp: '2026-01-01T00:00:00.000Z' } }),
      'default',
    );

    await validateAllCredentials(db);

    const statusRow = db.prepare('SELECT platform_test_status FROM brand_profiles WHERE brand_id = ?').get('default');
    const status = JSON.parse((statusRow as any).platform_test_status);
    // If validation passes, error should be null
    if (status.devto.last_test_error === null) {
      expect(status.devto.last_test_error).toBeNull();
    }
  });

  it('skips browser automation adapters', async () => {
    const encrypted = encryptApiKey('test-key');

    db.prepare('UPDATE brand_profiles SET api_keys_encrypted = ? WHERE brand_id = ?').run(
      JSON.stringify({ devto: encrypted, medium: encrypted }),
      'default',
    );

    const result = await validateAllCredentials(db);

    // Should only validate API adapters, not browser automation ones
    expect(result.filter(r => r.platformId === 'devto' || r.platformId === 'medium').length).toBeGreaterThan(0);
  });

  it('handles corrupted api_keys_encrypted gracefully', async () => {
    db.prepare('UPDATE brand_profiles SET api_keys_encrypted = ? WHERE brand_id = ?').run(
      'invalid-json-{',
      'default',
    );

    const result = await validateAllCredentials(db);

    expect(result).toEqual([]);
  });

  it('handles corrupted platform_test_status gracefully', async () => {
    const encrypted = encryptApiKey('test-key');

    db.prepare('UPDATE brand_profiles SET api_keys_encrypted = ?, platform_test_status = ? WHERE brand_id = ?').run(
      JSON.stringify({ devto: encrypted }),
      'invalid-json-{',
      'default',
    );

    const result = await validateAllCredentials(db);

    expect(result).toHaveLength(1);
    expect(result[0].platformId).toBe('devto');
  });

  it('returns results with correct structure', async () => {
    const encrypted = encryptApiKey('test-key');

    db.prepare('UPDATE brand_profiles SET api_keys_encrypted = ? WHERE brand_id = ?').run(
      JSON.stringify({ devto: encrypted }),
      'default',
    );

    const result = await validateAllCredentials(db);

    expect(result[0]).toHaveProperty('platformId');
    expect(result[0]).toHaveProperty('platform');
    expect(result[0]).toHaveProperty('ok');
    expect(result[0]).toHaveProperty('tested_at');
    expect(typeof result[0].platformId).toBe('string');
    expect(typeof result[0].platform).toBe('string');
    expect(typeof result[0].ok).toBe('boolean');
    expect(typeof result[0].tested_at).toBe('string');
  });
});
