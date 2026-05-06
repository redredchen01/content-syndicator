import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyV2Schema } from '../schema';
import { oauthTokens } from '../oauth-tokens';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  applyV2Schema(db);
  return db;
}

describe('oauthTokens', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });
  afterEach(() => db.close());

  describe('get / save', () => {
    it('returns null when no record exists', () => {
      expect(oauthTokens.get(db, 'blogger')).toBeNull();
    });

    it('round-trips refresh_token through encrypt/decrypt', () => {
      oauthTokens.save(db, 'blogger', { refresh_token: 'r1-secret-token' });
      const got = oauthTokens.get(db, 'blogger');
      expect(got?.refresh_token).toBe('r1-secret-token');
    });

    it('upserts on second save (replaces existing row)', () => {
      oauthTokens.save(db, 'blogger', { refresh_token: 'first' });
      oauthTokens.save(db, 'blogger', { refresh_token: 'second' });
      const got = oauthTokens.get(db, 'blogger');
      expect(got?.refresh_token).toBe('second');

      // Confirm only one row for this platform
      const count = db
        .prepare('SELECT COUNT(*) as n FROM oauth_tokens WHERE platform = ?')
        .get('blogger') as { n: number };
      expect(count.n).toBe(1);
    });

    it('persists access_token and expires_at as plaintext', () => {
      const expiresAt = Date.now() + 3600_000;
      oauthTokens.save(db, 'blogger', {
        refresh_token: 'r1',
        access_token: 'a1',
        expires_at: expiresAt,
      });
      const got = oauthTokens.get(db, 'blogger');
      expect(got?.access_token).toBe('a1');
      expect(got?.expires_at).toBe(expiresAt);
    });

    it('encrypts refresh_token at rest (raw column != plaintext)', () => {
      const plaintext = 'super-secret-refresh-token-value';
      oauthTokens.save(db, 'blogger', { refresh_token: plaintext });
      const raw = db
        .prepare('SELECT refresh_token FROM oauth_tokens WHERE platform = ?')
        .get('blogger') as { refresh_token: string };
      expect(raw.refresh_token).not.toBe(plaintext);
      expect(raw.refresh_token).not.toContain(plaintext);
      // AES-GCM hex format: 32 IV + 32 authTag + payload
      expect(raw.refresh_token.length).toBeGreaterThan(64);
    });

    it('rejects empty refresh_token', () => {
      expect(() => oauthTokens.save(db, 'blogger', { refresh_token: '' })).toThrow(
        /refresh_token is required/,
      );
    });

    it('rejects whitespace-only refresh_token', () => {
      expect(() => oauthTokens.save(db, 'blogger', { refresh_token: '   ' })).toThrow(
        /refresh_token is required/,
      );
    });

    it('isolates rows per platform', () => {
      oauthTokens.save(db, 'blogger', { refresh_token: 'b-token' });
      oauthTokens.save(db, 'medium', { refresh_token: 'm-token' });
      expect(oauthTokens.get(db, 'blogger')?.refresh_token).toBe('b-token');
      expect(oauthTokens.get(db, 'medium')?.refresh_token).toBe('m-token');
    });
  });

  describe('delete', () => {
    it('removes the row', () => {
      oauthTokens.save(db, 'blogger', { refresh_token: 'r1' });
      oauthTokens.delete(db, 'blogger');
      expect(oauthTokens.get(db, 'blogger')).toBeNull();
    });

    it('is a no-op when row does not exist', () => {
      expect(() => oauthTokens.delete(db, 'nope')).not.toThrow();
    });

    it('only deletes the targeted platform', () => {
      oauthTokens.save(db, 'blogger', { refresh_token: 'b' });
      oauthTokens.save(db, 'medium', { refresh_token: 'm' });
      oauthTokens.delete(db, 'blogger');
      expect(oauthTokens.get(db, 'blogger')).toBeNull();
      expect(oauthTokens.get(db, 'medium')?.refresh_token).toBe('m');
    });
  });

  describe('exists', () => {
    it('returns true when row present', () => {
      oauthTokens.save(db, 'blogger', { refresh_token: 'r' });
      expect(oauthTokens.exists(db, 'blogger')).toBe(true);
    });

    it('returns false when absent', () => {
      expect(oauthTokens.exists(db, 'nope')).toBe(false);
    });
  });

  describe('error propagation', () => {
    it('propagates encryption failures without writing', async () => {
      // Mock encryption module to throw
      const enc = await import('../../utils/encryption');
      const spy = vi.spyOn(enc, 'encryptApiKey').mockImplementation(() => {
        throw new Error('encryption mock failure');
      });
      try {
        expect(() => oauthTokens.save(db, 'blogger', { refresh_token: 'r' })).toThrow(
          /encryption mock failure/,
        );
        expect(oauthTokens.exists(db, 'blogger')).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
