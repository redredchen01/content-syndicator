/**
 * WordPress.com OAuth 2.0 strategy.
 *
 * WordPress.com runs a standard authorization_code flow but does **not**
 * return a refresh_token. The access_token is long-lived (only revoked
 * when the user disconnects the app from
 * https://wordpress.com/me/security/connected-applications). This means:
 *   - we never call a refresh endpoint
 *   - the oauth_tokens schema requires refresh_token NOT NULL, so we
 *     "duplicate" the access_token into the refresh_token column as a
 *     sentinel. The DAO/encryption layers stay untouched.
 *
 * The token-exchange response also includes the `blog_id` of the site the
 * user authorized. We must persist that alongside the token because the
 * publish endpoint is per-site (`/wp/v2/sites/{site_id}/posts`). To avoid
 * a schema migration we serialize `{ token, site_id }` into the
 * access_token column as JSON. WordPressAdapter's parser is the only
 * caller that needs to know.
 *
 * Required env: WORDPRESS_OAUTH_CLIENT_ID, WORDPRESS_OAUTH_CLIENT_SECRET,
 * WORDPRESS_OAUTH_REDIRECT_URI (must exactly match the value registered
 * at https://developer.wordpress.com/apps/).
 */

import {
  AuthStrategy,
  ExchangedTokens,
  registerStrategy,
} from './auth-strategy';
import type { OAuthTokens } from '../db/oauth-tokens';

export const WORDPRESS_AUTH_URL = 'https://public-api.wordpress.com/oauth2/authorize';
export const WORDPRESS_TOKEN_URL = 'https://public-api.wordpress.com/oauth2/token';
// WordPress.com defaults to "global" (posts + media) when scope is omitted.
// Posting requires this default scope; we send an empty value rather than
// "posts" because the token endpoint rejects unknown scope strings.
export const WORDPRESS_OAUTH_SCOPES: string[] = [];

export function isWordPressOAuthConfigured(): boolean {
  return Boolean(
    process.env.WORDPRESS_OAUTH_CLIENT_ID &&
    process.env.WORDPRESS_OAUTH_CLIENT_SECRET &&
    process.env.WORDPRESS_OAUTH_REDIRECT_URI,
  );
}

export interface GenerateAuthUrlInput {
  state: string;
  scopes?: string[];
}

export function generateWordPressAuthUrl({ state }: GenerateAuthUrlInput): string {
  if (!isWordPressOAuthConfigured()) {
    throw new Error(
      'WordPress.com OAuth not configured. Set WORDPRESS_OAUTH_CLIENT_ID, ' +
      'WORDPRESS_OAUTH_CLIENT_SECRET, and WORDPRESS_OAUTH_REDIRECT_URI in .env.',
    );
  }
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.WORDPRESS_OAUTH_CLIENT_ID!,
    redirect_uri: process.env.WORDPRESS_OAUTH_REDIRECT_URI!,
    state,
  });
  return `${WORDPRESS_AUTH_URL}?${params.toString()}`;
}

interface WordPressTokenResponse {
  access_token?: string;
  blog_id?: string;
  blog_url?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

export async function exchangeWordPressCode(code: string): Promise<ExchangedTokens> {
  const body = new URLSearchParams({
    client_id: process.env.WORDPRESS_OAUTH_CLIENT_ID!,
    client_secret: process.env.WORDPRESS_OAUTH_CLIENT_SECRET!,
    code,
    grant_type: 'authorization_code',
    redirect_uri: process.env.WORDPRESS_OAUTH_REDIRECT_URI!,
  });

  const res = await fetch(WORDPRESS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });

  const data = (await res.json().catch(() => ({}))) as WordPressTokenResponse;

  if (!res.ok) {
    throw new Error(
      `WordPress.com token exchange failed (${res.status}): ` +
      (data.error_description || data.error || JSON.stringify(data)),
    );
  }

  if (!data.access_token) {
    throw new Error('WordPress.com response missing access_token');
  }
  if (!data.blog_id) {
    throw new Error(
      'WordPress.com response missing blog_id — cannot publish without a target site.',
    );
  }

  // Sentinel: refresh_token := access_token (no real refresh available).
  // access_token holds JSON so the adapter can recover both token + site_id
  // without a schema migration.
  return {
    refresh_token: data.access_token,
    access_token: JSON.stringify({ token: data.access_token, site_id: data.blog_id }),
    expires_at: null,
  };
}

export interface ParsedWordPressToken {
  token: string;
  site_id: string;
}

/**
 * Recovers `{ token, site_id }` from a stored WordPress oauth_tokens row.
 * Adapter callers should treat any thrown error here as a "row is corrupt
 * or pre-OAuth — please reconnect" signal, not a network/transient failure.
 */
export function parseWordPressToken(stored: OAuthTokens): ParsedWordPressToken {
  if (!stored.access_token) {
    throw new Error('WordPress oauth_tokens row missing access_token — please reconnect.');
  }
  let parsed: { token?: unknown; site_id?: unknown };
  try {
    parsed = JSON.parse(stored.access_token);
  } catch {
    throw new Error(
      'WordPress oauth_tokens row has malformed access_token JSON — please reconnect.',
    );
  }
  if (typeof parsed.token !== 'string' || typeof parsed.site_id !== 'string') {
    throw new Error(
      'WordPress oauth_tokens row missing token or site_id — please reconnect.',
    );
  }
  return { token: parsed.token, site_id: parsed.site_id };
}

// ── AuthStrategy registration ─────────────────────────────────────────────

export const wordpressAuthStrategy: AuthStrategy = {
  providerId: 'wordpress',
  providerLabel: 'WordPress.com',
  supportedAdapters: ['WordPress'],
  defaultScopes: WORDPRESS_OAUTH_SCOPES,

  isConfigured: () => isWordPressOAuthConfigured(),

  generateAuthUrl({ state }) {
    return generateWordPressAuthUrl({ state });
  },

  exchangeCodeForTokens(code) {
    return exchangeWordPressCode(code);
  },
};

registerStrategy(wordpressAuthStrategy);
