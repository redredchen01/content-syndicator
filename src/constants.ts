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
  TASK_BATCH_SIZE: 5, // 批量处理时的每批并行度
  LLM_FAN_OUT: 3, // v0.2: 7 平台 LLM 改写并发上限（runParallel concurrency），避免撞 OpenAI tier-1/2 RPM
};

// =============================================================================
// v0.2 third-party-voice syndicator constants (Plan Unit 1)
// =============================================================================

/**
 * MVP 启用的 7 个 API 平台白名单。
 * publish_jobs.platform 需在此列表内才会进入发布队列。
 * 12 个 BrowserAutomationAdapter 仍注册但不进入 MVP 自动化路径。
 */
export const MVP_PLATFORMS = [
  'Telegra.ph',
  'Dev.to',
  'Medium',
  'Hashnode',
  'GitHub',
  'Blogger',
  'WordPress',
] as const;

export type MvpPlatform = typeof MVP_PLATFORMS[number];

/**
 * 各平台 HEAD 请求支持矩阵（来自 Unit 1 preflight 实测）。
 * Liveness worker (Unit 13) 据此在 HEAD 与 GET range 之间二选一，
 * 避免 HEAD-then-GET 双倍流量。
 *
 * 默认 false（保守：先 GET），preflight 跑过后由脚本提示是否改成 true。
 * 真实数据落 .data/preflight-matrix.json，启动时优先读取该文件。
 */
export const PLATFORM_HEAD_SUPPORTED: Record<MvpPlatform, boolean> = {
  'Telegra.ph': false,
  'Dev.to': false,
  'Medium': false,
  'Hashnode': false,
  'GitHub': true, // raw.githubusercontent.com 历来支持 HEAD
  'Blogger': false,
  'WordPress': false,
};

/**
 * LLM 模型 token 单价表（USD per 1M tokens）。Unit 5/6 调用结束记录
 * llm_calls 表时按 model 名 lookup 计算 cost_usd。
 *
 * 价格基于 2026-04 公开报价；新模型上线时更新本表。
 */
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // OpenAI
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4o': { input: 2.50, output: 10.0 },
  'gpt-5': { input: 5.00, output: 15.0 },
  'o1-mini': { input: 1.10, output: 4.40 },
  'o3-mini': { input: 1.10, output: 4.40 },
  // Google Gemini
  'gemini-1.5-flash': { input: 0.075, output: 0.30 },
  'gemini-1.5-pro': { input: 1.25, output: 5.0 },
  'gemini-2.0-flash': { input: 0.10, output: 0.40 },
  'gemini-2.5-pro': { input: 1.25, output: 10.0 },
};

/**
 * 日 / 月 LLM 预算告警阈值（USD），超限时 logger.warn + Sheets 红行。
 * 来自 success criteria 修订后的"日 ≤ $20，月 ≤ $400"。
 */
export const LLM_BUDGET = {
  DAILY_USD: parseFloat(process.env.LLM_DAILY_BUDGET_USD || '20'),
  MONTHLY_USD: parseFloat(process.env.LLM_MONTHLY_BUDGET_USD || '400'),
};

/**
 * 给定模型名和 token 用量，返回 USD 成本。Unknown 模型返 0 + warn。
 */
export function computeLlmCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0;
  return (
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output
  );
}