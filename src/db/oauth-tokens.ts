/**
 * oauth_tokens DAO — user-level OAuth2 credentials per platform.
 *
 * Both refresh_token and access_token are encrypted at rest (AES-256-GCM via
 * utils/encryption). access_token was previously stored plaintext on the
 * assumption it's short-lived, but a 1-2h window with a 644-permission SQLite
 * file still exposes a credential that can post to Twitter/Blogger directly.
 *
 * Schema: see oauth_tokens table in src/db/schema.ts.
 */

import type Database from 'better-sqlite3';
import { encryptApiKey, decryptApiKey } from '../utils/encryption';

/**
 * One row's worth of OAuth credentials. Two storage shapes co-exist:
 *
 *   - **Refreshable providers** (Google, Twitter): `refresh_token` is a real
 *     long-lived refresh credential, `access_token` is short-lived and gets
 *     rotated by the strategy.
 *   - **Sentinel providers** (WordPress.com, GitHub OAuth Apps): the provider
 *     does not issue refresh_tokens at all. To keep the schema's
 *     `refresh_token NOT NULL` constraint satisfied without a migration, the
 *     adapter writes the long-lived access_token into BOTH columns. Adapters
 *     for these providers MUST NOT call a refresh endpoint with the stored
 *     `refresh_token` — it is in fact an access_token and the provider's
 *     token endpoint will reject it.
 *
 * WordPress additionally stores `JSON.stringify({token, site_id})` in the
 * `access_token` column so the publish endpoint can resolve the target site
 * without a schema change. See `parseWordPressToken` in
 * src/services/wordpress-oauth.ts.
 */
export interface OAuthTokens {
  refresh_token: string;
  access_token?: string | null;
  expires_at?: number | null;
}

interface OAuthTokensRow {
  platform: string;
  access_token: string | null;
  refresh_token: string;
  expires_at: number | null;
  updated_at: string;
}

export const oauthTokens = {
  /** Returns null if no row exists. Decrypts refresh_token and access_token. */
  get(db: Database.Database, platform: string): OAuthTokens | null {
    const row = db
      .prepare('SELECT * FROM oauth_tokens WHERE platform = ?')
      .get(platform) as OAuthTokensRow | undefined;
    if (!row) return null;
    return {
      refresh_token: decryptApiKey(row.refresh_token),
      // access_token may be null (platforms that don't return one on refresh)
      access_token: row.access_token ? decryptApiKey(row.access_token) : null,
      expires_at: row.expires_at,
    };
  },

  /** Upsert. Encrypts both refresh_token and access_token before write. */
  save(db: Database.Database, platform: string, tokens: OAuthTokens): void {
    if (!tokens.refresh_token || tokens.refresh_token.trim() === '') {
      throw new Error('refresh_token is required');
    }
    const encryptedRefresh = encryptApiKey(tokens.refresh_token);
    const encryptedAccess = tokens.access_token ? encryptApiKey(tokens.access_token) : null;
    db.prepare(`
      INSERT INTO oauth_tokens (platform, access_token, refresh_token, expires_at, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(platform) DO UPDATE SET
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        expires_at = excluded.expires_at,
        updated_at = CURRENT_TIMESTAMP
    `).run(platform, encryptedAccess, encryptedRefresh, tokens.expires_at ?? null);
  },

  /** Removes the row. No-op if not present. */
  delete(db: Database.Database, platform: string): void {
    db.prepare('DELETE FROM oauth_tokens WHERE platform = ?').run(platform);
  },

  /** Lightweight existence check — does not decrypt. */
  exists(db: Database.Database, platform: string): boolean {
    const row = db
      .prepare('SELECT 1 FROM oauth_tokens WHERE platform = ?')
      .get(platform);
    return Boolean(row);
  },
};
