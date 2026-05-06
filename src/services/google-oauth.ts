/**
 * Google OAuth 2.0 user-flow helper.
 *
 * Centralizes OAuth2Client construction so routes and adapters all use the
 * same client config. googleapis' OAuth2Client refreshes access_tokens
 * automatically when a refresh_token is set on it — no manual refresh code.
 *
 * Required env: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET,
 * OAUTH_REDIRECT_URI (must exactly match the value registered in
 * Google Cloud Console).
 */

import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { db } from '../db';
import { oauthTokens } from '../db/oauth-tokens';

export const BLOGGER_OAUTH_SCOPES = ['https://www.googleapis.com/auth/blogger'];

/** Returns true only when all three required env vars are set. */
export function isOAuthConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_OAUTH_CLIENT_ID &&
    process.env.GOOGLE_OAUTH_CLIENT_SECRET &&
    process.env.OAUTH_REDIRECT_URI,
  );
}

/**
 * Constructs a fresh OAuth2Client. Throws if env not configured — callers
 * should gate on isOAuthConfigured() first.
 */
export function createOAuthClient(): OAuth2Client {
  if (!isOAuthConfigured()) {
    throw new Error(
      'Google OAuth not configured. Set GOOGLE_OAUTH_CLIENT_ID, ' +
      'GOOGLE_OAUTH_CLIENT_SECRET, and OAUTH_REDIRECT_URI in .env.',
    );
  }
  return new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID!,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET!,
    process.env.OAUTH_REDIRECT_URI!,
  );
}

/**
 * Builds a Google consent URL with offline access + forced consent prompt.
 *
 * `prompt: 'consent'` is critical — without it, Google skips re-issuing
 * refresh_token on subsequent grants if an active grant already exists,
 * causing token-refresh failures down the line.
 */
export function generateAuthUrl(state: string, scopes: string[]): string {
  const client = createOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes,
    state,
  });
}

export interface ExchangedTokens {
  refresh_token: string;
  access_token?: string;
  expires_at?: number;
}

/**
 * Exchanges an authorization code for tokens. Throws if Google does not
 * return a refresh_token (caller should redirect user to revoke prior
 * grant at https://myaccount.google.com/permissions and retry).
 */
export async function exchangeCodeForTokens(code: string): Promise<ExchangedTokens> {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      'Google did not return a refresh_token. This usually means the user ' +
      'previously authorized this app and the existing grant is still active. ' +
      'Ask the user to revoke the prior grant at ' +
      'https://myaccount.google.com/permissions and try again.',
    );
  }
  return {
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token ?? undefined,
    expires_at: tokens.expiry_date ?? undefined,
  };
}

/**
 * Returns an OAuth2Client primed with the stored refresh_token for the given
 * platform. googleapis will auto-refresh access_tokens transparently on
 * each API call. Throws when no tokens exist for the platform.
 */
export function getAuthorizedClient(platform: string): OAuth2Client {
  const stored = oauthTokens.get(db, platform);
  if (!stored) {
    throw new Error(`No OAuth tokens for ${platform} — please reconnect.`);
  }
  const client = createOAuthClient();
  client.setCredentials({
    refresh_token: stored.refresh_token,
    access_token: stored.access_token ?? undefined,
    expiry_date: stored.expires_at ?? undefined,
  });
  return client;
}
