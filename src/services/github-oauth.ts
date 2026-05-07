/**
 * GitHub OAuth 2.0 (OAuth App) strategy.
 *
 * GitHub's classic OAuth App flow does **not** issue refresh_tokens —
 * access_tokens are long-lived until the user revokes the app at
 * https://github.com/settings/applications. We use the same sentinel
 * layout as WordPress (refresh_token column duplicates access_token),
 * so the oauth_tokens schema (refresh_token NOT NULL) doesn't need a
 * migration.
 *
 * GitHub returns the token-exchange response as urlencoded form data
 * by default; the `Accept: application/json` header is required to
 * get a JSON body.
 *
 * Required env: GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET,
 * GITHUB_OAUTH_REDIRECT_URI (must exactly match the value registered
 * in the OAuth App at https://github.com/settings/developers).
 */

import {
  AuthStrategy,
  ExchangedTokens,
  registerStrategy,
} from './auth-strategy';

export const GITHUB_AUTH_URL = 'https://github.com/login/oauth/authorize';
export const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
// Minimum scope to create gists. Add 'repo' later if/when we publish to
// repos or PRs instead of gists.
export const GITHUB_OAUTH_SCOPES = ['gist'];

export function isGitHubOAuthConfigured(): boolean {
  return Boolean(
    process.env.GITHUB_OAUTH_CLIENT_ID &&
    process.env.GITHUB_OAUTH_CLIENT_SECRET &&
    process.env.GITHUB_OAUTH_REDIRECT_URI,
  );
}

export interface GenerateAuthUrlInput {
  state: string;
  scopes?: string[];
}

export function generateGitHubAuthUrl({
  state,
  scopes = GITHUB_OAUTH_SCOPES,
}: GenerateAuthUrlInput): string {
  if (!isGitHubOAuthConfigured()) {
    throw new Error(
      'GitHub OAuth not configured. Set GITHUB_OAUTH_CLIENT_ID, ' +
      'GITHUB_OAUTH_CLIENT_SECRET, and GITHUB_OAUTH_REDIRECT_URI in .env.',
    );
  }
  const params = new URLSearchParams({
    client_id: process.env.GITHUB_OAUTH_CLIENT_ID!,
    redirect_uri: process.env.GITHUB_OAUTH_REDIRECT_URI!,
    scope: scopes.join(' '),
    state,
    response_type: 'code',
  });
  return `${GITHUB_AUTH_URL}?${params.toString()}`;
}

interface GitHubTokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

export async function exchangeGitHubCode(code: string): Promise<ExchangedTokens> {
  const body = new URLSearchParams({
    client_id: process.env.GITHUB_OAUTH_CLIENT_ID!,
    client_secret: process.env.GITHUB_OAUTH_CLIENT_SECRET!,
    code,
    redirect_uri: process.env.GITHUB_OAUTH_REDIRECT_URI!,
  });

  const res = await fetch(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: {
      // Without this header GitHub returns urlencoded form data.
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });

  const data = (await res.json().catch(() => ({}))) as GitHubTokenResponse;

  if (!res.ok) {
    throw new Error(
      `GitHub token exchange failed (${res.status}): ` +
      (data.error_description || data.error || JSON.stringify(data)),
    );
  }

  // GitHub returns 200 with `error` field on bad_verification_code etc.
  if (data.error) {
    throw new Error(
      `GitHub token exchange failed: ${data.error_description || data.error}`,
    );
  }

  if (!data.access_token) {
    throw new Error('GitHub response missing access_token');
  }

  // Verify the requested scope was actually granted. GitHub can omit
  // requested scopes if the user trims them on the consent screen, and
  // a token without 'gist' fails publish later — better to fail fast.
  const grantedScopes = (data.scope || '').split(/[ ,]+/).filter(Boolean);
  if (!grantedScopes.includes('gist')) {
    throw new Error(
      'Insufficient scope: GitHub did not grant gist permission. ' +
      'Re-authorize and ensure the gist scope is checked.',
    );
  }

  return {
    refresh_token: data.access_token, // sentinel — no real refresh
    access_token: data.access_token,
    expires_at: null,
  };
}

// ── AuthStrategy registration ─────────────────────────────────────────────

export const githubAuthStrategy: AuthStrategy = {
  providerId: 'github',
  providerLabel: 'GitHub',
  supportedAdapters: ['GitHub'],
  defaultScopes: GITHUB_OAUTH_SCOPES,

  isConfigured: () => isGitHubOAuthConfigured(),

  generateAuthUrl({ state, scopes }) {
    return generateGitHubAuthUrl({ state, scopes });
  },

  exchangeCodeForTokens(code) {
    return exchangeGitHubCode(code);
  },
};

registerStrategy(githubAuthStrategy);
