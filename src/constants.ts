// Configuration constants for the content syndicator agent

export const SCRAPING_TIMEOUTS = {
  PAGE_GOTO: 45000,
  WAIT_FOR_LOAD_STATE: 15000,
  EXTRA_WAIT: 2000,
  PAGE_CONTENT: 8000,
  NAVIGATION: 45000,
  DOM_CONTENT_LOADED: 15000
};

export const RATE_LIMITING = {
  MIN_SLEEP_MS: 5000,
  MAX_SLEEP_MS: 15000,
  ATTEMPTS: 5
};

export const RETRY_CONFIG = {
  MAX_ATTEMPTS: 3,
  BASE_DELAY_MS: 1000,
  MAX_DELAY_MS: 10000,
  BACKOFF_FACTOR: 2 // 指数退避倍数
};

export const CACHE_CONFIG = {
  TTL_MS: 3600000, // 1 hour
  MAX_SIZE: 100
};

// New: Concurrency Control
export const CONCURRENCY_CONFIG = {
  BROWSER_MAX_TABS: parseInt(process.env.BROWSER_MAX_TABS || '3', 10), // 最大并发 Tab 数，防止内存溢出
  TASK_BATCH_SIZE: 5 // 批量处理时的每批并行度
};