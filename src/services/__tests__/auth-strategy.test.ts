import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  AuthStrategy,
  registerStrategy,
  getStrategyByProvider,
  getStrategyByAdapter,
  isOAuthSupported,
  getOAuthProviderLabel,
  getOAuthProviderId,
  listProviders,
  __clearStrategies,
} from '../auth-strategy';
// Importing google-oauth registers googleAuthStrategy on module load —
// importing it here so subsequent tests can re-register it after clearing.
import { googleAuthStrategy } from '../google-oauth';

function makeFakeStrategy(overrides: Partial<AuthStrategy> = {}): AuthStrategy {
  return {
    providerId: 'fake',
    providerLabel: 'Fake',
    supportedAdapters: ['FakeAdapter'],
    defaultScopes: [],
    isConfigured: () => true,
    generateAuthUrl: () => 'https://fake/auth',
    exchangeCodeForTokens: async () => ({ refresh_token: 'r' }),
    ...overrides,
  };
}

describe('auth-strategy registry', () => {
  beforeEach(() => {
    __clearStrategies();
  });

  // Make sure googleAuthStrategy is re-registered for downstream test files
  // that rely on the production import-side-effect registration.
  afterAll(() => {
    __clearStrategies();
    registerStrategy(googleAuthStrategy);
  });

  it('registers and looks up a strategy by providerId', () => {
    const s = makeFakeStrategy();
    registerStrategy(s);
    expect(getStrategyByProvider('fake')).toBe(s);
  });

  it('looks up by adapter name (case-insensitive)', () => {
    const s = makeFakeStrategy({ supportedAdapters: ['Blogger', 'YouTube'] });
    registerStrategy(s);
    expect(getStrategyByAdapter('Blogger')).toBe(s);
    expect(getStrategyByAdapter('blogger')).toBe(s);
    expect(getStrategyByAdapter('YOUTUBE')).toBe(s);
  });

  it('returns null for unknown lookups', () => {
    expect(getStrategyByProvider('nope')).toBeNull();
    expect(getStrategyByAdapter('nope')).toBeNull();
  });

  it('isOAuthSupported reflects registry state', () => {
    expect(isOAuthSupported('Blogger')).toBe(false);
    registerStrategy(makeFakeStrategy({ supportedAdapters: ['Blogger'] }));
    expect(isOAuthSupported('Blogger')).toBe(true);
  });

  it('getOAuthProviderLabel returns the providerLabel', () => {
    registerStrategy(makeFakeStrategy({
      supportedAdapters: ['Twitter'],
      providerLabel: 'X',
    }));
    expect(getOAuthProviderLabel('Twitter')).toBe('X');
  });

  it('getOAuthProviderId returns the providerId', () => {
    registerStrategy(makeFakeStrategy({
      supportedAdapters: ['Twitter'],
      providerId: 'twitter',
    }));
    expect(getOAuthProviderId('Twitter')).toBe('twitter');
  });

  it('rejects duplicate providerId registration', () => {
    registerStrategy(makeFakeStrategy({ providerId: 'dup' }));
    expect(() =>
      registerStrategy(makeFakeStrategy({ providerId: 'dup', supportedAdapters: ['Other'] })),
    ).toThrow(/already registered/);
  });

  it('listProviders returns all registered providerIds', () => {
    registerStrategy(makeFakeStrategy({ providerId: 'a' }));
    registerStrategy(makeFakeStrategy({ providerId: 'b', supportedAdapters: ['B'] }));
    expect(listProviders().sort()).toEqual(['a', 'b']);
  });

  describe('googleAuthStrategy (production registration)', () => {
    beforeEach(() => {
      __clearStrategies();
      registerStrategy(googleAuthStrategy);
    });

    it('registers with providerId="google" and providerLabel="Google"', () => {
      expect(googleAuthStrategy.providerId).toBe('google');
      expect(googleAuthStrategy.providerLabel).toBe('Google');
    });

    it('claims Blogger as a supported adapter', () => {
      expect(googleAuthStrategy.supportedAdapters).toContain('Blogger');
      expect(getStrategyByAdapter('Blogger')).toBe(googleAuthStrategy);
    });
  });
});
