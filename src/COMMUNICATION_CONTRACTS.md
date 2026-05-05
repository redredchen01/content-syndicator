# 模块间通信约定

## 概述

本文档定义模块间的通信方式、数据结构、错误处理约定和日志规范，确保模块间通信的**一致性和可追踪性**。

---

## 1. 核心数据结构

### 1.1 标准返回值

所有 service 函数应返回统一的结果结构：

```typescript
// 成功情况
interface Result<T> {
  ok: true;
  data: T;
}

// 失败情况
interface Result<T> {
  ok: false;
  error: string;  // 错误信息（用户友好）
  details?: unknown;  // 详细错误信息（调试用）
}

// 典型调用
const result = await publishService.generate(url);
if (!result.ok) {
  logger.error('generate failed', { error: result.error, details: result.details });
}
```

### 1.2 发布流的数据结构

#### PublishPayload（发送给 adapters）

```typescript
interface PublishPayload {
  platform: string;  // 'blogger' | 'devto' | 'github' | ... 
  title: string;
  content: string;
  tags?: string[];
  heroImageUrl?: string;
  // 平台特定的配置（可选）
  platformConfig?: Record<string, any>;
}
```

#### PublishResult（adapters 返回）

```typescript
interface PublishResult {
  ok: boolean;
  publishedUrl?: string;  // 成功时的发布链接
  error?: string;  // 失败时的错误信息
  metadata?: {
    postId?: string;  // 平台 post ID（用于后续更新）
    publishedAt?: Date;
    platformResponse?: any;  // 平台特定响应（调试用）
  };
}
```

#### VariantGeneratorResult（variant 生成结果）

```typescript
interface VariantGeneratorResult {
  ok: boolean;
  variants?: Array<{
    platform: string;
    title: string;
    content: string;
    tags: string[];
  }>;
  error?: string;
  failedPlatforms?: Array<{ platform: string; error: string }>;
}
```

---

## 2. 关键调用链

### 2.1 发布流（Publish Flow）

```
POST /api/v2/generate
  ↓
routes/publish.ts
  ↓ logger.info('publish.generate.start', { url, contextId })
  ↓
services/publish-service.ts → publish()
  ├─ 1. 爬虫获取内容
  │    └─ scraper/index.ts → fetch()
  │       ├─ logger.debug('scraper.invoke', { url })
  │       └─ logger.debug('scraper.complete', { contentLength })
  │
  ├─ 2. LLM 生成 7 个 variants（并发）
  │    └─ services/variant-generator.ts → generate()
  │       └─ llm/agent-llm.ts → invokeLLMWithTools()
  │          └─ logger.debug('llm.invoke', { platform, model })
  │
  ├─ 3. 多平台发布（并发）
  │    └─ adapters/*.ts → publish()
  │       ├─ logger.info('adapter.publish', { platform, title })
  │       └─ logger.info('adapter.publish.success', { platform, url })
  │
  ├─ 4. 质量评分（lint）
  │    └─ services/lint/index.ts → check()
  │       └─ logger.debug('lint.check', { variance, similarity })
  │
  ├─ 5. Sheets 同步
  │    └─ sheets/index.ts → appendRow()
  │       └─ logger.info('sheets.sync', { rowCount })
  │
  └─ 6. DB 持久化
       └─ db/repositories.ts → insertPublishJob()
          └─ logger.debug('db.insert', { jobId, count: results.length })
  
  ↓ logger.info('publish.generate.success', { contextId, variantCount })
  ↓
routes/publish.ts → res.json(variants)
```

**数据流向：**
- 输入：`{ url: string, branding?: BrandProfile }`
- 中间：各个 service 函数间通过返回值传递数据
- 输出：`{ variants: VariantGeneratorResult, errors?: Record<string, string> }`

**错误处理：**
- 单个 adapter 失败不阻止其他 adapter（使用 `utils/parallel.ts`）
- 任何关键步骤失败时，返回 `{ ok: false, error: ... }`
- routes 捕获错误并返回 HTTP 500

### 2.2 调度流（Scheduler Flow）

```
index.ts startup
  ↓
services/queue/scheduler.ts → start()
  ├─ 初始化：读取待调度作业
  │    └─ db/repositories.publishJobs.list()
  │       └─ logger.debug('scheduler.init', { pendingJobsCount })
  │
  └─ 每 2 秒 tick：
       ├─ 1. 获取可执行作业
       │    └─ db/repositories.publishJobs.listPending()
       │
       ├─ 2. 批量执行（batchSize=5）
       │    └─ services/queue/publish-worker.ts → execute(job)
       │       ├─ logger.info('worker.start', { jobId, type: job.type })
       │       ├─ 调用对应 handler
       │       │    ├─ publishHandler(job)
       │       │    ├─ livenessHandler(job)
       │       │    └─ digestHandler(job)
       │       ├─ 更新作业状态
       │       │    └─ db/repositories.publishJobs.update({ status: 'succeeded' })
       │       └─ logger.info('worker.complete', { jobId, duration: ms })
       │
       ├─ 3. 僵尸作业清理（每分钟）
       │    └─ db/repositories.publishJobs.listStale(maxAge=1h)
       │       └─ logger.warn('scheduler.stale_cleanup', { staleCount })
       │
       └─ 4. 错误恢复
            └─ 作业失败 → 标记 status='failed'，计数器递增
               ├─ 可重试错误 → 等待下次 tick 重试
               └─ 不可重试错误 → 标记 status='failed_permanent'

  ↓ logger.info('scheduler.tick', { activeJobs, completedCount })
```

**作业状态机：**
```
scheduled → running → succeeded/failed → (清理) → 删除
  ↑                        ↑
  └────── 重试（若可重试）──┘
```

---

## 3. 错误处理约定

### 3.1 错误分类

使用 `utils/smartRetry.ts` 中定义的错误类型：

```typescript
enum ErrorType {
  RATE_LIMIT = 'RATE_LIMIT',    // 429，可重试
  TIMEOUT = 'TIMEOUT',          // 超时，可重试
  NETWORK = 'NETWORK',          // 网络错误，可重试
  AUTH = 'AUTH',                // 认证错误，不重试
  SERVER_ERROR = 'SERVER_ERROR',// 5xx，可重试（3 次）
  NOT_FOUND = 'NOT_FOUND',      // 404，不重试
  UNKNOWN = 'UNKNOWN'           // 未知，可重试（1 次）
}
```

### 3.2 错误传播链

```
adapters/*.ts
  └─ throw new PlatformError('...')

services/publish-service.ts
  └─ catch error
     ├─ classifyError(error) → ErrorType
     ├─ 若可重试 → logger.warn('retry', { attempt, delay })
     ├─ 若不可重试 → return { ok: false, error: error.message }

routes/publish.ts
  └─ catch error
     └─ logger.error('api_error', { error: error.message, contextId })
     └─ res.status(500).json({ error: error.message })
```

### 3.3 数据库错误处理

```typescript
try {
  db.prepare('INSERT INTO posts ...').run(...);
} catch (err: any) {
  if (err.code === 'SQLITE_CONSTRAINT') {
    // 约束违反（如唯一性）
    logger.warn('db.constraint_error', { table: 'posts', field: 'url' });
    throw new DuplicateError('URL already published');
  } else if (err.code === 'SQLITE_IOERR') {
    // I/O 错误，可重试
    logger.warn('db.io_error', { retry: true });
    throw err;  // 触发外层 smartRetry
  } else {
    // 其他错误
    logger.error('db.unknown_error', { error: err.message });
    throw err;
  }
}
```

---

## 4. 日志规范

### 4.1 日志格式

```typescript
logger.level('module.function.event', {
  contextId: string,      // 请求/作业追踪 ID
  [otherFields]: any      // 其他上下文字段
});
```

**示例：**
```typescript
logger.info('publish.generate.start', {
  contextId: req.headers['x-request-id'] || uuid(),
  url: req.body.url,
  userAgent: req.headers['user-agent']
});
```

### 4.2 关键路径埋点

| 路径 | 埋点位置 | 日志内容 |
|------|---------|---------|
| **发布流** | routes 入口 | `publish.generate.start` |
|  | scraper 完成 | `scraper.complete { length }` |
|  | LLM 调用 | `llm.invoke { platform, model }` |
|  | adapter 发布 | `adapter.publish { platform, url }` |
|  | 同步 Sheets | `sheets.sync { rowCount }` |
|  | routes 出口 | `publish.generate.success / failed` |
| **调度流** | scheduler 启动 | `scheduler.start { pendingCount }` |
|  | worker 执行 | `worker.start { jobId, type }` |
|  | worker 完成 | `worker.complete { jobId, duration }` |
|  | 作业失败 | `worker.error { jobId, error, retry }` |
| **认证流** | 认证开始 | `auth.init { provider }` |
|  | token 刷新 | `auth.token.refresh { provider }` |
|  | 认证失败 | `auth.failed { provider, reason }` |

### 4.3 日志级别

| 级别 | 何时使用 | 示例 |
|------|---------|------|
| **DEBUG** | 详细的执行流程 | `invokeLLM with params: ...` |
| **INFO** | 重要的业务事件 | `publish succeeded on platform X` |
| **WARN** | 可恢复的错误（重试、降级） | `rate limit hit, retrying in 5s` |
| **ERROR** | 不可恢复的错误或异常 | `publish failed: auth expired` |

---

## 5. 模块间通信的 Mock 约定（用于测试）

### 5.1 Adapters Mock

```typescript
// 在测试中 mock adapters
vi.mock('../adapters/blogger', () => ({
  BloggerAdapter: class {
    async publish(payload: PublishPayload) {
      if (payload.title.includes('test')) {
        return { ok: true, publishedUrl: 'https://blogger.com/post/123' };
      } else {
        return { ok: false, error: 'Title required' };
      }
    }
  }
}));
```

### 5.2 LLM Mock

```typescript
// Mock LLM 客户端
vi.mock('../llm/client', () => ({
  getOpenAIClient: vi.fn(() => ({
    chat: {
      completions: {
        create: vi.fn(async (params) => ({
          choices: [{ message: { content: 'Generated content' } }]
        }))
      }
    }
  }))
}));
```

### 5.3 数据库 Mock（推荐用 :memory:）

```typescript
// 在测试中使用内存数据库
function freshDb(): Database.Database {
  const db = new Database(':memory:');
  applyV2Schema(db);  // 应用 schema
  return db;
}

beforeEach(() => {
  db = freshDb();
});

afterEach(() => {
  db.close();
});
```

---

## 6. 特殊场景处理

### 6.1 并发发布（多平台同时发布）

**约定：** 使用 `utils/parallel.ts` 的 runParallel() 函数，**单个平台失败不阻止其他平台**。

```typescript
// services/publish-service.ts
const results = await runParallel(
  adapters.map(adapter => () => adapter.publish(payload)),
  concurrency: 3  // 最多 3 个并发
);

// results: Array<{ ok: boolean, value?: PublishResult, error?: string }>
const succeeded = results.filter(r => r.ok);
const failed = results.filter(r => !r.ok);

logger.info('publish.results', {
  contextId,
  succeeded: succeeded.length,
  failed: failed.length
});
```

### 6.2 长时间操作（如爬虫、LLM 调用）

**约定：** 使用 `utils/smartRetry.ts` 的 retry() 函数，自动分类错误并重试。

```typescript
const result = await smartRetry(
  async () => {
    return await llm.invokeLLM(prompt);
  },
  {
    maxAttempts: 3,
    backoffMs: 1000,
    shouldRetry: (error) => {
      const type = classifyError(error);
      return [ErrorType.RATE_LIMIT, ErrorType.TIMEOUT, ErrorType.NETWORK].includes(type);
    }
  }
);
```

### 6.3 事务性操作（DB 更新）

**约定：** 若多步操作需保证原子性，使用 SQLite 事务。

```typescript
const result = db.transaction(() => {
  const jobId = db.prepare('INSERT INTO publish_jobs ...').run(...).lastID;
  db.prepare('INSERT INTO posts ...').run({ jobId, ... });
  return jobId;
})();
```

---

## 7. 模块间调用示例

### 示例 1：发布一篇文章

```typescript
// routes/publish.ts
export async function handleGenerate(req: Request, res: Response) {
  const contextId = req.headers['x-request-id'] || uuid();
  
  logger.info('publish.generate.start', {
    contextId,
    url: req.body.url
  });
  
  try {
    const result = await publishService.generate({
      url: req.body.url,
      branding: req.body.branding
    });
    
    if (!result.ok) {
      logger.warn('publish.generate.failed', { contextId, error: result.error });
      return res.status(400).json({ error: result.error });
    }
    
    logger.info('publish.generate.success', {
      contextId,
      variantCount: result.data.variants.length
    });
    
    return res.json(result.data);
  } catch (err) {
    logger.error('publish.generate.error', {
      contextId,
      error: err instanceof Error ? err.message : 'unknown'
    });
    return res.status(500).json({ error: 'Internal server error' });
  }
}
```

### 示例 2：多平台发布

```typescript
// services/publish-service.ts
async publish(variants: VariantResult[], platforms: string[]): Promise<PublishResult> {
  const contextId = getContextId();  // 自动获取当前请求的 context_id
  
  logger.info('publish.multi_platform.start', {
    contextId,
    platforms: platforms.join(','),
    variantCount: variants.length
  });
  
  const results = await runParallel(
    platforms.map(platform => async () => {
      const adapter = getAdapter(platform);
      const variant = variants.find(v => v.platform === platform);
      
      logger.debug('adapter.publish.invoke', { contextId, platform });
      
      const result = await adapter.publish({
        title: variant.title,
        content: variant.content,
        tags: variant.tags
      });
      
      if (result.ok) {
        logger.info('adapter.publish.success', {
          contextId,
          platform,
          url: result.publishedUrl
        });
      } else {
        logger.warn('adapter.publish.failed', {
          contextId,
          platform,
          error: result.error
        });
      }
      
      return result;
    }),
    3  // 最多 3 个并发
  );
  
  logger.info('publish.multi_platform.complete', {
    contextId,
    succeeded: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length
  });
  
  return { ok: true, data: results };
}
```

---

## 8. 最后更新

**日期：** 2026-05-05  
**版本：** v0.2  
**维护者：** Debug Optimization Initiative  
**状态：** 有效（配合日志系统升级）

