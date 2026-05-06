/**
 * Twitter / X OAuth 2.0 PKCE strategy.
 *
 * Twitter's OAuth 2.0 flow differs from Google's in two structural ways:
 *   1. PKCE (Proof Key for Code Exchange, RFC 7636) — the consent URL embeds
 *      a hashed code_challenge; the token exchange must replay the original
 *      code_verifier. We use S256 (SHA-256), which is the secure default
 *      (do NOT use 'plain' — it defeats the purpose of PKCE).
 *   2. No client library wraps this for us — google-auth-library is Google-
 *      specific, and node-twitter-api-v2 is 1.2 MB for endpoints we don't
 *      need. ~30 lines of fetch + crypto handles the entire flow.
 *
 * Refresh tokens require the `offline.access` scope. Without it, X returns
 * tokens with `expires_in: 7200` and no refresh_token, making the integration
 * effectively single-session.
 *
 * Required env: TWITTER_OAUTH_CLIENT_ID, TWITTER_OAUTH_CLIENT_SECRET,
 * TWITTER_OAUTH_REDIRECT_URI (must exactly match the value registered in
 * the X Developer Portal Callback URI field).
 */

import crypto from 'crypto';
import { db } from '../db';
import { oauthTokens } from '../db/oauth-tokens';
import {
  AuthStrategy,
  ExchangedTokens,
  registerStrategy,
} from './auth-strategy';

export const TWITTER_AUTH_URL = 'https://twitter.com/i/oauth2/authorize';
export const TWITTER_TOKEN_URL = 'https://api.twitter.com/2/oauth2/token';
export const TWITTER_OAUTH2_SCOPES = [
  'tweet.read',
  'tweet.write',
  'users.read',
  'offline.access', // required for refresh_token
];

// Refresh `expires_at` lead-time: refresh proactively when the access token
// has < 60s left. X access_tokens live 2h, so this is a tiny fraction.
const REFRESH_LEAD_MS = 60_000;

// ── PKCE helpers ────────────────────────────────────────────────────────────

/** Generates a 32-byte URL-safe code_verifier (44 chars after base64url). */
export function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** S256 code_challenge = base64url(SHA-256(verifier)). */
export function codeChallengeFromVerifier(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// ── Configuration ──────────────────────────────────────────────────────────

export function isTwitterOAuthConfigured(): boolean {
  return Boolean(
    process.env.TWITTER_OAUTH_CLIENT_ID &&
    process.env.TWITTER_OAUTH_CLIENT_SECRET &&
    process.env.TWITTER_OAUTH_REDIRECT_URI,
  );
}

function basicAuthHeader(): string {
  const id = process.env.TWITTER_OAUTH_CLIENT_ID!;
  const secret = process.env.TWITTER_OAUTH_CLIENT_SECRET!;
  return 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');
}

// ── Auth URL & token exchange ──────────────────────────────────────────────

export interface GenerateAuthUrlInput {
  state: string;
  codeChallenge: string;
  scopes?: string[];
}

export function generateTwitterAuthUrl({
  state,
  codeChallenge,
  scopes = TWITTER_OAUTH2_SCOPES,
}: GenerateAuthUrlInput): string {
  if (!isTwitterOAuthConfigured()) {
    throw new Error(
      'Twitter OAuth not configured. Set TWITTER_OAUTH_CLIENT_ID, ' +
      'TWITTER_OAUTH_CLIENT_SECRET, and TWITTER_OAUTH_REDIRECT_URI in .env.',
    );
  }
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.TWITTER_OAUTH_CLIENT_ID!,
    redirect_uri: process.env.TWITTER_OAUTH_REDIRECT_URI!,
    scope: scopes.join(' '),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${TWITTER_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchanges authorization code for tokens. The code_verifier must match the
 * one used to derive the code_challenge in generateTwitterAuthUrl().
 */
export async function exchangeTwitterCode(
  code: string,
  codeVerifier: string,
): Promise<ExchangedTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: process.env.TWITTER_OAUTH_REDIRECT_URI!,
    code_verifier: codeVerifier,
    client_id: process.env.TWITTER_OAUTH_CLIENT_ID!,
  });

  const res = await fetch(TWITTER_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });

  const data = await res.json().catch(() => ({})) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!res.ok) {
    throw new Error(
      `Twitter token exchange failed (${res.status}): ` +
      (data.error_description || data.error || JSON.stringify(data)),
    );
  }

  if (!data.refresh_token) {
    throw new Error(
      'Twitter did not return a refresh_token. The `offline.access` scope is ' +
      'required and must be approved by the user. Re-authenticate after ' +
      'verifying the scope is requested.',
    );
  }

  const expiresAt = data.expires_in
    ? Date.now() + data.expires_in * 1000
    : undefined;

  return {
    refresh_token: data.refresh_token,
    access_token: data.access_token,
    expires_at: expiresAt,
  };
}

/**
 * Calls the token endpoint with grant_type=refresh_token. X may rotate the
 * refresh_token (return a new one) — caller must persist whichever it gets.
 */
export async function refreshTwitterToken(refreshToken: string): Promise<ExchangedTokens> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: process.env.TWITTER_OAUTH_CLIENT_ID!,
  });

  const res = await fetch(TWITTER_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });

  const data = await res.json().catch(() => ({})) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!res.ok) {
    throw new Error(
      `Twitter token refresh failed (${res.status}): ` +
      (data.error_description || data.error || JSON.stringify(data)),
    );
  }

  if (!data.access_token) {
    throw new Error('Twitter refresh response missing access_token');
  }

  return {
    refresh_token: data.refresh_token ?? refreshToken, // X may or may not rotate
    access_token: data.access_token,
    expires_at: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
  };
}

// ── Authorized client ───────────────────────────────────────────────────────

export interface TwitterAccessToken {
  accessToken: string;
  expiresAt: number | null;
}

/**
 * Returns a valid access_token for the platform, refreshing transparently
 * when the stored one is expired or near expiry. Persists the refreshed
 * token (and any rotated refresh_token) back to oauth_tokens.
 *
 * Throws when no tokens stored or the refresh attempt fails.
 */
export async function getValidTwitterAccessToken(platform: string): Promise<TwitterAccessToken> {
  const stored = oauthTokens.get(db, platform);
  if (!stored) {
    throw new Error(`No OAuth tokens for ${platform} — please reconnect.`);
  }

  const now = Date.now();
  const isFresh =
    stored.access_token &&
    stored.expires_at &&
    stored.expires_at > now + REFRESH_LEAD_MS;

  if (isFresh) {
    return {
      accessToken: stored.access_token!,
      expiresAt: stored.expires_at!,
    };
  }

  // Refresh
  const refreshed = await refreshTwitterToken(stored.refresh_token);
  oauthTokens.save(db, platform, {
    refresh_token: refreshed.refresh_token,
    access_token: refreshed.access_token ?? null,
    expires_at: refreshed.expires_at ?? null,
  });

  return {
    accessToken: refreshed.access_token!,
    expiresAt: refreshed.expires_at ?? null,
  };
}

// ── AuthStrategy export & registration ─────────────────────────────────────

export const twitterAuthStrategy: AuthStrategy = {
  providerId: 'twitter',
  providerLabel: 'X',
  supportedAdapters: ['Twitter'],
  defaultScopes: TWITTER_OAUTH2_SCOPES,

  isConfigured: () => isTwitterOAuthConfigured(),

  generateAuthUrl({ state, scopes, attach }) {
    // PKCE: generate verifier here, hash it for the URL, hand the verifier
    // back to the caller via `attach` so it can be stored alongside the state.
    const verifier = generateCodeVerifier();
    const challenge = codeChallengeFromVerifier(verifier);
    if (attach) attach({ codeVerifier: verifier });
    return generateTwitterAuthUrl({
      state,
      codeChallenge: challenge,
      scopes: scopes ?? TWITTER_OAUTH2_SCOPES,
    });
  },

  async exchangeCodeForTokens(code, extras) {
    const codeVerifier = extras?.codeVerifier as string | undefined;
    if (!codeVerifier) {
      throw new Error('Twitter OAuth exchange requires codeVerifier from state');
    }
    return exchangeTwitterCode(code, codeVerifier);
  },
};

registerStrategy(twitterAuthStrategy);
