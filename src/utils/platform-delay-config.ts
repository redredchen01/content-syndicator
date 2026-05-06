// Platform-specific delay configurations (in milliseconds)
// These delays are based on platform API rate limits and typical response times

export const PLATFORM_DELAYS: Record<string, { min: number; max: number }> = {
  'Blogger': { min: 1000, max: 3000 },
  'Medium': { min: 3000, max: 8000 },
  'Dev.to': { min: 2000, max: 5000 },
  'GitHub': { min: 1000, max: 2000 },
  'Telegra.ph': { min: 2000, max: 4000 },
  'Hashnode': { min: 3000, max: 6000 },
  'WordPress': { min: 4000, max: 10000 }
};

/**
 * Get platform-specific delay in milliseconds
 * Considers environment variable overrides (DELAY_<PLATFORM>_MS)
 */
export function getPlatformDelay(platform: string): number {
  // Check for environment variable override
  const envKey = `DELAY_${platform.toUpperCase().replace(/[.\s]/g, '_')}_MS`;
  const envValue = process.env[envKey];

  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (!isNaN(parsed)) {
      return parsed;
    }
  }

  // Use configured delay or default
  const config = PLATFORM_DELAYS[platform] || { min: 2000, max: 5000 };
  return Math.floor(Math.random() * (config.max - config.min + 1)) + config.min;
}

/**
 * Calculate exponential backoff delay for batch processing
 * Starts at initialDelay and multiplies by multiplier up to maxDelay
 */
export function getExponentialBackoffDelay(
  iteration: number,
  initialDelay: number = 30000,
  multiplier: number = 1.2,
  maxDelay: number = 60000
): number {
  // Calculate base delay with exponential backoff
  const baseDelay = initialDelay * Math.pow(multiplier, Math.max(0, iteration));
  // Cap at maxDelay
  const cappedDelay = Math.min(baseDelay, maxDelay);
  // Add jitter (up to 10% variation) but ensure final result doesn't exceed maxDelay
  const jitter = Math.random() * 0.1 * cappedDelay;
  return Math.floor(Math.min(cappedDelay + jitter, maxDelay));
}

/**
 * Sleep utility function
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
