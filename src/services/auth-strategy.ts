/**
 * Auth strategy interface — abstraction over per-provider OAuth flows.
 *
 * Each OAuth provider (Google, Twitter, future ...) registers an AuthStrategy
 * instance at module load time. Routes and admin lookups consult the registry
 * via getStrategyByAdapter() / getStrategyByProvider() instead of hard-coding
 * provider-specific code paths.
 *
 * Adding a new provider:
 *   1. Implement AuthStrategy
 *   2. Call registerStrategy(yourStrategy) at module load
 *   3. Add a route handler that resolves strategy by providerId
 *
 * Strategies share the same oauth_tokens table (per-platform row) and the
 * same in-memory pendingStates Map (defined in routes/auth.ts), so CSRF and
 * token storage are uniform across providers.
 */

export interface ExchangedTokens {
  refresh_token: string;
  access_token?: string | null;
  expires_at?: number | null;
}

/**
 * Per-provider auth strategy. Methods that talk to the provider (auth URL,
 * token exchange) are stateless; persistence (oauthTokens DAO) is centralized.
 */
export interface AuthStrategy {
  /** Stable identifier — used in URL paths (/api/auth/<providerId>/...) */
  providerId: string;
  /** Human-readable label for the "Connect with X" button */
  providerLabel: string;
  /** Adapter display names this provider can authenticate (e.g. ['Blogger']) */
  supportedAdapters: string[];
  /** Default scopes when none are explicitly requested */
  defaultScopes: string[];

  /** True only when all required env vars are set. */
  isConfigured(): boolean;

  /**
   * Returns the consent URL the user should be redirected to.
   * Implementations may attach extra state-bound data (e.g. PKCE verifiers)
   * via the optional `attach` callback before returning the URL.
   */
  generateAuthUrl(opts: {
    state: string;
    scopes?: string[];
    /** Hook for strategies that need to bind extra data to the state (e.g. PKCE verifier). */
    attach?: (extras: Record<string, unknown>) => void;
  }): string;

  /**
   * Exchanges an authorization code for tokens. The optional `extras` arg
   * carries state-bound data that callers retrieved alongside the state
   * (e.g. the PKCE code_verifier).
   */
  exchangeCodeForTokens(code: string, extras?: Record<string, unknown>): Promise<ExchangedTokens>;
}

// ── Registry ────────────────────────────────────────────────────────────────

const strategiesByProvider = new Map<string, AuthStrategy>();
const strategiesByAdapter = new Map<string, AuthStrategy>(); // key: lowercased adapter name

export function registerStrategy(strategy: AuthStrategy): void {
  if (strategiesByProvider.has(strategy.providerId)) {
    throw new Error(`AuthStrategy already registered for provider: ${strategy.providerId}`);
  }
  strategiesByProvider.set(strategy.providerId, strategy);
  for (const adapterName of strategy.supportedAdapters) {
    strategiesByAdapter.set(adapterName.toLowerCase(), strategy);
  }
}

/** Test-only — clears the registry so test files can register fresh strategies. */
export function __clearStrategies(): void {
  strategiesByProvider.clear();
  strategiesByAdapter.clear();
}

export function getStrategyByProvider(providerId: string): AuthStrategy | null {
  return strategiesByProvider.get(providerId) ?? null;
}

export function getStrategyByAdapter(adapterName: string): AuthStrategy | null {
  return strategiesByAdapter.get(adapterName.toLowerCase()) ?? null;
}

/** Returns true when an AuthStrategy is registered for this adapter. */
export function isOAuthSupported(adapterName: string): boolean {
  return strategiesByAdapter.has(adapterName.toLowerCase());
}

/** Returns the provider label ('Google', 'X', ...) for an adapter, or null. */
export function getOAuthProviderLabel(adapterName: string): string | null {
  return strategiesByAdapter.get(adapterName.toLowerCase())?.providerLabel ?? null;
}

/** Returns the providerId ('google', 'twitter', ...) for an adapter, or null. */
export function getOAuthProviderId(adapterName: string): string | null {
  return strategiesByAdapter.get(adapterName.toLowerCase())?.providerId ?? null;
}

/** Lists all registered providers (for diagnostics / route registration). */
export function listProviders(): string[] {
  return [...strategiesByProvider.keys()];
}
