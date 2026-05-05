# 性能监控埋点指南

本指南说明如何在新模块中集成日志、追踪、性能监控等功能。

---

## 快速开始

### 1. 使用日志（Logger）

**最常用的操作**：记录关键操作和错误。

```typescript
import { logger } from '../utils/logger';

// 信息日志
logger.info('module.operation.start', {
  userId: 123,
  articleId: 'art-001'
});

// 成功日志
logger.info('module.operation.success', {
  duration: 1500,
  itemsProcessed: 42
});

// 错误日志
logger.error('module.operation.failed', {
  error: err.message,
  code: err.code,
  userId: 123
});

// 警告日志
logger.warn('module.operation.slow', {
  duration: 5000,
  threshold: 2000
});
```

**日志命名规范**：`<module>.<operation>.<phase>`
- `module`: 模块名（如 `services`, `adapters`, `routes`）
- `operation`: 操作名（如 `publish`, `scrape`, `sync`）
- `phase`: 阶段（`start`, `progress`, `success`, `failed`, `slow` 等）

**示例**：
- `services.publish.start` - 发布服务启动
- `adapters.medium.publish.success` - Medium 适配器发布成功
- `routes.publish.failed` - 发布路由处理失败

### 2. 使用追踪（Tracer）

**追踪异步操作的耗时和错误**。

```typescript
import { span } from '../utils/tracer';

// 包装异步函数
const result = await span('services.publish.execute', async () => {
  // 具体业务逻辑
  return await publishToAllPlatforms();
});

// 带自定义元数据
const result = await span('adapter.medium.publish', async () => {
  return await adapter.publish(article);
}, {
  platform: 'Medium',
  articleId: article.id,
  retry: false
});

// 嵌套 span 会自动追踪关系
async function publishToAllPlatforms() {
  for (const platform of platforms) {
    await span(`publish.platform.${platform}`, async () => {
      // 每个平台的发布操作
    });
  }
}

// 错误会被自动记录
const result = await span('risky.operation', async () => {
  throw new Error('Oops!'); // 会被记录为失败的 span
});
```

**Span 命名规范**：与日志类似，但更侧重操作名
- `services.<operation>`
- `adapters.<platform>.<operation>`
- `routes.<route>.<operation>`

### 3. 使用性能监控（SystemMonitor）

**记录任意操作的耗时**。

```typescript
import { systemMonitor } from '../utils/systemMonitor';

// 记录操作耗时
const startTime = Date.now();
// ... 执行操作
const duration = Date.now() - startTime;
systemMonitor.recordOperation('publish.batch', duration, true);

// 或者使用 span（自动记录）
const result = await span('publish.batch', async () => {
  // 操作代码
});

// 记录缓存命中率等统计
systemMonitor.recordCacheHit('scrape.cache', true);
systemMonitor.recordCacheHit('scrape.cache', false);
```

---

## 常见场景

### 场景 1：服务函数埋点

```typescript
// src/services/my-service.ts
import { logger } from '../utils/logger';
import { span } from '../utils/tracer';
import { systemMonitor } from '../utils/systemMonitor';

export async function processArticles(urls: string[]) {
  logger.info('services.process.start', { urlCount: urls.length });

  const results = await span('services.process.execute', async () => {
    const processed = [];

    for (const url of urls) {
      try {
        logger.info('services.process.item.start', { url });

        const article = await span('services.process.item.fetch', async () => {
          return await fetchArticle(url);
        });

        processed.push(article);

        logger.info('services.process.item.success', {
          url,
          contentLength: article.content.length
        });
      } catch (err: any) {
        logger.error('services.process.item.failed', {
          url,
          error: err.message
        });
        // 继续处理其他 URL
      }
    }

    return processed;
  });

  logger.info('services.process.success', {
    processed: results.length,
    total: urls.length,
    rate: ((results.length / urls.length) * 100).toFixed(1) + '%'
  });

  return results;
}
```

### 场景 2：适配器埋点

```typescript
// src/adapters/my-adapter.ts
import { logger } from '../utils/logger';
import { span } from '../utils/tracer';

export class MyAdapter {
  async publish(article: Article) {
    return await span('adapter.my.publish', async () => {
      logger.info('adapter.my.publish.start', {
        title: article.title.substring(0, 50)
      });

      try {
        const response = await this.apiCall({
          title: article.title,
          content: article.content
        });

        logger.info('adapter.my.publish.success', {
          url: response.url,
          duration: response.duration
        });

        return {
          success: true,
          publishedUrl: response.url
        };
      } catch (err: any) {
        logger.error('adapter.my.publish.failed', {
          error: err.message,
          code: err.code
        });

        return {
          success: false,
          error: err.message
        };
      }
    }, {
      platform: 'MyPlatform',
      titleLength: article.title.length
    });
  }
}
```

### 场景 3：路由处理埋点

```typescript
// src/routes/my-route.ts
import { asyncRoute } from './_helpers';
import { logger } from '../utils/logger';
import { span } from '../utils/tracer';

router.post('/api/process', asyncRoute(async (req, res) => {
  const { url } = req.body;

  logger.info('routes.process.request', { url });

  try {
    const result = await span('routes.process.handle', async () => {
      // 业务逻辑
      const processed = await processUrl(url);
      return processed;
    });

    logger.info('routes.process.success', {
      url,
      resultSize: JSON.stringify(result).length
    });

    res.json({ ok: true, data: result });
  } catch (err: any) {
    logger.error('routes.process.error', {
      url,
      error: err.message
    });

    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
}));
```

### 场景 4：批量操作埋点

```typescript
// 记录批处理的总体和单项指标
import { logger } from '../utils/logger';
import { span } from '../utils/tracer';

export async function batchProcess(items: any[]) {
  logger.info('batch.process.start', {
    itemCount: items.length
  });

  const startTime = Date.now();

  const results = await span('batch.process.execute', async () => {
    const results = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      try {
        // 每项操作都追踪
        const result = await span(`batch.item.${i}`, async () => {
          return await processItem(item);
        }, {
          itemIndex: i,
          itemId: item.id
        });

        results.push({ success: true, result });
      } catch (err: any) {
        logger.error('batch.item.failed', {
          itemIndex: i,
          itemId: item.id,
          error: err.message
        });

        results.push({ success: false, error: err.message });
      }
    }

    return results;
  });

  const duration = Date.now() - startTime;
  const successRate = (results.filter(r => r.success).length / items.length) * 100;

  logger.info('batch.process.complete', {
    itemCount: items.length,
    successCount: results.filter(r => r.success).length,
    duration,
    successRate: successRate.toFixed(1) + '%',
    avgTimePerItem: (duration / items.length).toFixed(0) + 'ms'
  });

  return results;
}
```

---

## 最佳实践

### 1. 日志级别

使用正确的日志级别很重要：

| 级别 | 何时使用 | 示例 |
|------|--------|------|
| `info` | 关键操作开始、成功、重要里程碑 | 发布开始、发布成功 |
| `warn` | 非关键错误、降级、阈值超过 | 单个平台失败、延迟过高 |
| `error` | 操作失败、异常情况 | API 错误、网络超时 |
| `debug` | 调试信息（仅开发环境） | 详细的参数值 |

```typescript
// 好：清晰的日志层级
logger.info('publish.start'); // 开始
logger.warn('publish.retry'); // 降级
logger.error('publish.failed'); // 失败

// 差：信息繁琐
logger.info('About to start publishing');
logger.info('Starting publish process now');
logger.info('Publish process is happening');
```

### 2. 元数据设计

日志元数据应该包含：
- **操作相关**：操作 ID、操作参数
- **上下文相关**：用户 ID、请求 ID（自动）
- **结果相关**：成功/失败、耗时、结果数量

```typescript
// 好：包含诊断所需的信息
logger.info('publish.platform.success', {
  platform: 'Medium',
  articleId: article.id,
  publishedUrl: result.url,
  duration: timeMs
});

// 差：信息太少，无法诊断
logger.info('publish success');

// 差：信息太多，难以解析
logger.info('publish', {
  a: 1, b: 2, c: 3, d: 4, e: 5,
  f: article, g: result, h: platform
});
```

### 3. 错误处理

确保错误被正确记录和追踪：

```typescript
// 好：同时记录到日志和 span
try {
  const result = await span('risky.operation', async () => {
    return await riskyCall();
  });
} catch (err) {
  // Span 会记录错误（status: 'error'）
  // 补充日志信息
  logger.error('operation.failed', {
    error: err.message,
    code: err.code,
    context: additionalContext
  });
  // 决策：重试、降级、还是上报
  throw err;
}

// 差：错误被吞掉
try {
  await operation();
} catch (err) {
  // 没有记录
}
```

### 4. 性能敏感的代码

对于高频调用的函数，避免过度日志：

```typescript
// 好：只在关键点记录
async function mapItem(item) {
  return await span('map.item', async () => {
    // 业务逻辑，Span 自动记录耗时
    return transform(item);
  }); // 仅在 span 完成时记录
}

// 差：每项都日志
async function mapItem(item) {
  logger.info('map.item.start', item); // 太频繁
  const result = transform(item);
  logger.info('map.item.done', result); // 太频繁
  return result;
}
```

### 5. 敏感信息处理

不要在日志中记录密钥、密码等敏感信息：

```typescript
// 好：隐藏敏感信息
logger.info('auth.api.call', {
  platform: 'Medium',
  tokenLength: token.length, // 只记录长度
  endpoint: endpoint
});

// 差：泄露敏感信息
logger.info('auth.api.call', {
  token: 'Bearer xyz...', // 不要这样做！
  password: 'mySecretPassword' // 危险！
});
```

---

## 性能指标的解读

### 理解聚合指标

```json
{
  "avgDuration": 1500,    // 平均耗时（推荐值）
  "p95Duration": 2300,    // 95% 请求在 2.3s 以内
  "p99Duration": 3100,    // 99% 请求在 3.1s 以内
  "baseline": 1000,       // 历史基线
  "isAnomaly": true       // 当前耗时 > 1.5 × 基线
}
```

**解读**：
- `avgDuration` 过高 → 平均性能下降
- `p99Duration` 过高 → 偶发长尾延迟
- `isAnomaly: true` → 需要关注（可能需要优化）

### 理解错误率

```json
{
  "errorRate": 0.15,     // 15% 的请求失败
  "count": 100           // 共 100 个请求
}
```

**解读**：
- `> 10%` → 严重问题，需要立即查看日志
- `1-10%` → 值得关注，需要诊断
- `< 1%` → 正常范围

### 理解置信度（Confidence）

```json
{
  "confidence": 0.85  // 诊断的可靠性
}
```

**含义**：
- `< 0.5` → 样本太少，诊断不可靠（需要更多数据）
- `0.5-0.8` → 中等可信，可参考但需验证
- `> 0.8` → 高度可信，可以据此采取行动

---

## 常见问题

### Q1: 应该在哪些函数上添加 span？

**原则**：关键操作、可能失败的操作、需要监控的操作。

```typescript
// ✅ 应该添加 span：
- 服务方法（service/*.ts）
- 适配器方法（adapters/*.ts）
- 外部 API 调用
- 数据库操作
- 文件 I/O 操作

// ❌ 不需要 span：
- 简单的数据转换（2-3 行代码）
- 纯同步函数（如格式化字符串）
- 已经被上层 span 包含的函数
```

### Q2: Span 嵌套太多，会影响性能吗？

**影响微乎其微**（< 1%）。但过多的 span 会让数据噪音增加。

**建议**：
- 每个操作 3-5 层 span 最佳
- 不要在循环内创建新的 span，而是在循环外统计

### Q3: 如何在现有代码中补充埋点？

**增量方式**：

```typescript
// 第一步：添加 span 框架
const result = await span('operation.name', async () => {
  // 现有代码
  return originalFunction();
});

// 第二步：补充关键日志
logger.info('operation.start', { param1, param2 });
// ... 业务逻辑
logger.info('operation.success', { result });

// 第三步：完善错误处理
try {
  // ...
} catch (err) {
  logger.error('operation.failed', { error: err.message });
  throw err;
}
```

### Q4: Trace 如何查看？

使用 API 端点：

```bash
# 查询最近 1 小时的失败 trace
curl 'http://localhost:3000/api/traces?status=error&since=1h' \
  | jq '.data.traces[] | {traceId, name, duration, errorMessage}'

# 查询特定 traceId 的完整链路
curl 'http://localhost:3000/api/traces?traceId=<id>' \
  | jq '.data.traces | sort_by(.startTime) | .[] | {spanId, parentSpanId, name, duration}'
```

---

## 相关资源

- **API 参考**: 见 `docs/API_METRICS_REFERENCE.md`
- **使用指南**: 见 `docs/DEBUG_OPTIMIZATION_GUIDE.md`
- **源代码**:
  - Logger: `src/utils/logger.ts`
  - Tracer: `src/utils/tracer.ts`
  - SystemMonitor: `src/utils/systemMonitor.ts`
