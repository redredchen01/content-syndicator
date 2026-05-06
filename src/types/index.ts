// 共享类型定义 - 减少 any 使用

// ==================== 基础类型 ====================

export type Nullable<T> = T | null;
export type Optional<T> = T | undefined;
export type Maybe<T> = T | null | undefined;

// ==================== 环境配置 ====================

export interface EnvConfig {
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
  SELECTED_MODEL?: string;
  DEVTO_API_KEY?: string;
  MEDIUM_INTEGRATION_TOKEN?: string;
  GITHUB_TOKEN?: string;
  HASHNODE_TOKEN?: string;
  HASHNODE_PUBLICATION_ID?: string;
  BLOGGER_BLOG_ID?: string;
  WORDPRESS_SITE_URL?: string;
  WORDPRESS_USERNAME?: string;
  WORDPRESS_APP_PASSWORD?: string;
  GOOGLE_APPLICATION_CREDENTIALS_JSON?: string;
  GOOGLE_SHEET_ID?: string;
  ENABLE_BROWSER_AUTOMATION?: string;
  BROWSER_AUTH_MODE?: string;
  BROWSER_CHROME_USER_DATA_DIR?: string;
  BROWSER_CHROME_PROFILE?: string;
  BROWSER_HEADLESS?: string;
  BROWSER_PROXY?: string;
  LOG_LEVEL?: string;
  LOG_CONSOLE?: string;
  LOG_FILE?: string;
  AUTO_CLEANUP?: string;
  CLEANUP_INTERVAL_MS?: string;
  SKIP_CONFIG_VALIDATION?: string;
}

// ==================== 抓取相关 ====================

export interface ScrapedData {
  title: string;
  content: string;
  originalUrl: string;
}

export interface CacheEntry {
  data: ScrapedData;
  timestamp: number;
  accessCount: number;
  lastAccess: number;
}

// ==================== LLM 相关 ====================

export interface GeneratedContent {
  title: string;
  content: string;
  tags?: string[];
  excerpt?: string;
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LLMResponse {
  content: string;
  tool_calls?: ToolCall[];
  raw?: unknown;
}

export interface LLMWithToolsOptions {
  model?: string;
  messages: LLMMessage[];
  tools?: unknown[]; // adapter-specific tool definitions (e.g. ChatCompletionTool from openai SDK)
  temperature?: number;
  maxTokens?: number;
}

// ==================== 发布相关 ====================

export interface PublishOptions {
  title: string;
  markdownContent: string;
  originalUrl?: string;
  publishStatus?: 'draft' | 'public';
  tags?: string[];
  excerpt?: string;
}

export interface PublishResult {
  platform: string;
  success: boolean;
  publishedUrl?: string;
  error?: string;
}

export interface PublishResults {
  targetPlatforms: string[];
  results: PublishResult[];
}

// ==================== 适配器 ====================

export interface TestConnectionResult {
  ok: boolean;
  error?: string;
}

export interface PlatformAdapter {
  name: string;
  isBrowserAutomation?: boolean;
  canPublishAutomatically?: boolean;
  /** Hybrid adapters (e.g. Medium) that prefer an API token but can fall back
   *  to browser session-based publishing when no token is configured. UI uses
   *  this to render a secondary "use browser login" link. */
  supportsBrowserFallback?: boolean;
  publish(options: PublishOptions): Promise<PublishResult>;
  testConnection?(): Promise<TestConnectionResult>;
}

// ==================== 数据库 ====================

export interface SavedPost {
  id: number;
  timestamp: string;
  original_url: string;
  title: string;
  content: string;
  results_json: string;
}

export interface TaskProgress {
  id?: number;
  task_id: string;
  platform: string;
  status: string;
  last_error: string | null;
  updated_at?: string;
}

export interface DatabaseStats {
  postsCount: number;
  taskProgressCount: number;
  dbSizeBytes: number;
  dbSizeHuman: string;
  oldestPost: string;
  newestPost: string;
  successRate: string;
}

// ==================== Agent ====================

export type AgentState = 'idle' | 'observing' | 'thinking' | 'acting' | 'reflecting' | 'completed' | 'error';

export interface AgentContext {
  taskId: string;
  originalUrl?: string;
  rawContent?: string;
  scrapedData?: ScrapedData;
  generatedContent?: GeneratedContent;
  generatedPromo?: GeneratedContent;
  publishResults?: PublishResult[];
  errors: string[];
  metadata: Record<string, unknown>;
}

export interface AgentConfig {
  maxIterations?: number;
  enableReflection?: boolean;
  enableLearning?: boolean;
  verbose?: boolean;
}

export interface Plan {
  action: string;
  params: Record<string, unknown>;
  reasoning?: string;
  confidence?: number;
}

// ==================== 工具 ====================

export interface ToolContext {
  agentContext: AgentContext;
  [key: string]: unknown;
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  shouldStop?: boolean;
}

// ==================== 监控 ====================

export interface PerformanceMetric {
  operation: string;
  duration: number;
  timestamp: number;
  success: boolean;
  metadata?: Record<string, unknown>;
}

export interface ResourceUsage {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  cpuUsage: NodeJS.CpuUsage;
}

export interface SystemStats {
  totalOperations: number;
  successRate: string;
  averageDuration: string;
  slowestOperation: PerformanceMetric | null;
  fastestOperation: PerformanceMetric | null;
  resourceUsage: ResourceUsage;
  uptime: number;
}

// ==================== 日志 ====================

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  SUCCESS = 4,
}

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  details?: unknown;
  module?: string;
}

// ==================== 配置验证 ====================

export interface ConfigCheck {
  name: string;
  key: string;
  present: boolean;
  valid: boolean;
  value: string;
  defaultValue?: string;
  message?: string;
}

export interface ConfigReport {
  valid: boolean;
  checks: ConfigCheck[];
  errors: string[];
  warnings: string[];
  suggestions: string[];
  text?: string;
}

// ==================== 错误 ====================

export enum ErrorType {
  NETWORK = 'NETWORK',
  RATE_LIMIT = 'RATE_LIMIT',
  AUTH = 'AUTH',
  NOT_FOUND = 'NOT_FOUND',
  SERVER_ERROR = 'SERVER_ERROR',
  TIMEOUT = 'TIMEOUT',
  UNKNOWN = 'UNKNOWN',
}

export interface ErrorAdvice {
  type: ErrorType;
  message: string;
  userMessage: string;
  suggestions: string[];
  docLink?: string;
}

export interface ErrorReport {
  timestamp: string;
  type: ErrorType;
  message: string;
  stack?: string;
  context?: string;
  suggestions: string[];
}

// ==================== 缓存 ====================

export interface CacheStats {
  size: number;
  maxSize: number;
  hitCount: number;
  missCount: number;
  hitRate: string;
  oldestEntry: string;
  newestEntry: string;
}

// ==================== 清理 ====================

export interface CleanupOptions {
  tempFiles?: boolean;
  oldLogs?: boolean;
  cache?: boolean;
  dryRun?: boolean;
}

export interface CleanupStats {
  tempFilesRemoved: number;
  tempFilesSize: string;
  oldLogsRemoved: number;
  cacheEntriesRemoved: number;
  totalSpaceFreed: string;
  diskSpaceBefore: string;
  diskSpaceAfter: string;
}

// ==================== API 响应 ====================

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  count: number;
  total?: number;
  page?: number;
  pageSize?: number;
}

// ==================== 速率限制 ====================

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  resetTime: Date;
  totalHits: number;
}

export interface RateLimiterStats {
  totalKeys: number;
  totalHits: number;
  topConsumers: Array<{ key: string; hits: number }>;
}

// ==================== 导出通用工具类型 ====================

export type AsyncFunction<T = void> = () => Promise<T>;
export type AsyncFunctionWithArgs<T, Args extends unknown[] = unknown[]> = (...args: Args) => Promise<T>;

export type NullableFields<T> = {
  [K in keyof T]?: T[K] | null;
};

export type PartialBy<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

// ==================== 常用类型守卫 ====================

export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

export function isNumber(value: unknown): value is number {
  return typeof value === 'number' && !isNaN(value);
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

// ==================== 错误类型守卫 ====================

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return isObject(error) && 'code' in error;
}

export function hasMessage(error: unknown): error is { message: string } {
  return isObject(error) && 'message' in error && isString(error.message);
}

// ==================== v0.2 third-party-voice types (Plan Unit 4 / Unit 5) ====================

/**
 * 三个人设组（Plan R6）。代码内统一英文 enum；UI 标签用中文。
 */
export type PersonaGroup = 'tech_blogger' | 'personal_essay' | 'reviewer';

/**
 * 人设标签（中文）— 仅用于 UI 渲染。
 */
export const PERSONA_LABEL_ZH: Record<PersonaGroup, string> = {
  tech_blogger: '技术博主',
  personal_essay: '个人随笔',
  reviewer: '评论客',
};

/**
 * MVP_PLATFORMS → PersonaGroup 映射（Plan R6 锚定）。
 * 单一数据源；运行时和 UI 都通过此表反查。
 */
export const PERSONA_TO_PLATFORMS: Record<PersonaGroup, readonly string[]> = {
  tech_blogger: ['Dev.to', 'Hashnode', 'GitHub'],
  personal_essay: ['Medium'],
  reviewer: ['Telegra.ph', 'Blogger', 'WordPress'],
} as const;

/**
 * 给定平台名返回所属 persona 组。未知平台返 null。
 */
export function platformToPersona(platform: string): PersonaGroup | null {
  for (const [group, platforms] of Object.entries(PERSONA_TO_PLATFORMS)) {
    if (platforms.includes(platform)) return group as PersonaGroup;
  }
  return null;
}

/**
 * Persona prompt frontmatter — Unit 4 loader 解析后的 metadata。
 */
export interface PersonaPromptMeta {
  persona: PersonaGroup;
  label_zh: string;
  tone_keywords: string[];
  example_phrases?: string[];
}

/**
 * Loader 加载后的完整 prompt（frontmatter + body 模板正文）。
 */
export interface PersonaPrompt {
  meta: PersonaPromptMeta;
  body: string;
}

/**
 * 锚词生成 mini-prompt 的输入上下文。
 */
export interface AnchorGenerationContext {
  brand_name: string;
  brand_variants: string[];
  article_summary: string;
  target_url: string;
  target_url_context_tag: string;
  anchor_blocklist: string[];
  recent_top_anchors: string[];
}

/**
 * 单个变体（Unit 5 输出 → Unit 7 lint → Unit 8 预览 → Unit 10 发布）。
 */
export interface Variant {
  variant_id: string;
  platform: string;
  persona_group: PersonaGroup;
  title: string;
  body_markdown: string;
  anchor_words: string[];
  target_url: string;
  generation_status: 'ok' | 'failed';
  error?: string;
}
