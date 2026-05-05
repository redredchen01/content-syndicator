---
title: 调试优化系统 — 性能监控与根因分析
type: feat
status: active
date: 2026-05-05
---

# 调试优化系统 — 性能监控与根因分析

## 概述

建立全栈性能监控与根因分析系统，优化日志输出性能、构建实时监控仪表板、提供结构化根因分析工具。目标：将系统可观测性从「基础日志」升级到「完整可观测」，实现 50% 的性能瓶颈识别和快速诊断。

---

## 问题框架

**当前状态：**
- ✅ 已有基础日志框架（Winston + contextId 追踪）
- ✅ 已有初级性能指标记录（systemMonitor）
- ❌ **缺失性能指标 API 接口**（无法远程查询）
- ❌ **缺失跨模块调用链追踪**（span 级别）
- ❌ **缺失实时监控仪表板**
- ❌ **缺失根因分析工具**（无法快速诊断瓶颈）

**具体痛点：**

| 痛点 | 影响 | 优先级 |
|------|------|--------|
| 发布/批量处理的固定延迟（30-60s）| 吞吐量 ↓ 50% | 🔴 |
| 并发控制无性能监控 | 无法评估并发效率 | 🟡 |
| 日志文件增长无限制 | 磁盘占用 ↑，查询变慢 | 🟡 |
| 错误诊断缺上下文信息 | 平均修复时间 ↑ | 🔴 |
| 性能基线未建立 | 无法检测异常 | 🟡 |

---

## 需求与成功标准

### 功能需求

- **R1：** 性能指标远程查询 API（支持 `/api/stats`, `/api/metrics`）
- **R2：** 性能监控内置仪表板（Web UI，实时更新）
- **R3：** 跨模块调用链追踪（span + trace 支持）
- **R4：** 结构化根因分析工具（快速定位瓶颈）
- **R5：** 日志性能优化（异步写入、压缩、采样）
- **R6：** 性能基线建立与异常告警

### 成功标准

- **性能指标：** 日志写入 P99 延迟 < 10ms（异步批量）
- **可观测性：** 100% 的关键操作有 span 追踪
- **诊断效率：** 从日志搜索到瓶颈定位 < 5 分钟
- **仪表板：** 支持查询最近 24h 数据，刷新周期 < 2s
- **可维护性：** 新增模块日志接入成本 < 5 min/模块

---

## 范围边界

### 包含

- 性能指标 API（stats, metrics, traces）
- Web 仪表板（React + 简易图表）
- 异步日志写入优化
- 根因分析工具库（瓶颈识别、慢操作推荐）
- VSCode 扩展（条件断点、性能标注）

### 不包含

- ❌ 分布式系统追踪（Jaeger/Zipkin 集成）— 暂定为原生实现
- ❌ 机器学习异常检测 — 暂定为阈值告警
- ❌ 日志中心化存储（ELK 集成）— 暂定为本地文件 + API 查询
- ❌ 实时告警通知系统（Slack 集成）— 暂定为 UI 展示

---

## 关键技术决策

1. **原生 Span 追踪 vs OpenTelemetry：** 选择原生实现
   - **理由：** 当前系统单体应用，无分布式场景；原生实现减少依赖，轻量化
   - **实现：** 自定义 span 对象 + context 传递

2. **异步日志写入策略：** 批量缓冲 + 定时刷新
   - **理由：** 避免 I/O 阻塞，减少日志输出 P99 延迟
   - **参数：** 缓冲大小 1000 条，刷新间隔 5s

3. **性能指标存储：** 内存 + 持久化
   - **理由：** 实时查询快速，定期持久化保证数据安全
   - **保留策略：** 最近 1000 条指标 + 历史汇总（每小时）

4. **仪表板框架：** React + ECharts（轻量化）
   - **理由：** 已有 Node.js/TypeScript 技栈，ECharts 图表库轻量且功能完善
   - **替代方案考虑：** 若仅需简易HTML/canvas，可改用纯 JS 方案

5. **根因分析方法：** 启发式规则 + 统计（非机器学习）
   - **理由：** 可解释性强，易于维护；阶段一足够满足需求

---

## 上下文与研究

### 现有模式与资源

- **日志 API：** `src/utils/logger.ts` — 已有 info/warn/error/debug 结构化接口
- **上下文管理：** `src/utils/context.ts` — 已有 contextId 自动追踪（cls-hooked）
- **性能监控：** `src/utils/systemMonitor.ts` — 已有操作记录、统计、慢操作查询
- **错误处理：** `src/utils/errorHandler.ts` — 已有错误分类（NETWORK, AUTH, TIMEOUT 等）
- **缓存统计：** `src/cache/scrapeCache.ts` — 已有命中率、LRU 统计
- **路由层日志：** `src/routes/publish.ts` — 高频日志位置（38 条），性能优化重点

### 现有性能瓶颈

1. **publish.ts 中的固定延迟**（L56, L101-103）
   - 发布每平台后固定延迟 5-10s，批量处理 30-60s
   - **优化策略：** 改为平台适配延迟 + 指数退避

2. **parallel.ts 缺少性能记录**
   - runParallel 无并发效率监控
   - **优化策略：** 植入性能埋点，记录队列等待、任务分布

3. **autoCleanup.ts 中的 O(n) 清理**
   - 缓存清理每 60s 遍历所有条目
   - **优化策略：** 改为增量清理或对数复杂度策略

### 已解决的参考方案

- **Phase 4 完成：** 本地开发工具优化（Docker Compose、VSCode 调试）
- **docs/solutions 中：** 错误分类框架、contextId 追踪实现

---

## 开放问题

### 规划期间已解决

- **Q1：** 是否需要支持多进程？ **A：** 暂不，当前单进程，未来可扩展
- **Q2：** 日志采样策略？ **A：** 初期不采样，后续可按操作名/错误率配置

### 实现期间需要延迟决策

- **Q3：** 仪表板如何集成到主应用（新 React 页面 vs 独立服务）
- **Q4：** Span 追踪的粒度（按函数 vs 按关键操作）
- **Q5：** 性能基线的学习周期（多少条数据认为「稳定」）

---

## 高层技术设计

> *此设计为方向指导，实现时应作为上下文而非代码模板。*

```
┌─────────────────────────────────────────────────────────────┐
│              调试优化系统总体架构                              │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  应用层（routes, services, adapters）                │   │
│  │  └─ logger.info/warn/error (现有)                    │   │
│  │     + tracer.span(operation, fn)  [NEW]            │   │
│  │     + asyncLogger.enqueue(...)     [NEW]            │   │
│  └──────────────────────────────────────────────────────┘   │
│                        ↓                                      │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  TraceLayer（跨模块追踪）[NEW]                        │   │
│  │  ├─ tracer.span(name, fn) → 自动记录耗时/错误       │   │
│  │  └─ 自动追踪上下文 (parentSpanId, traceId)          │   │
│  └──────────────────────────────────────────────────────┘   │
│           ↓                    ↓                   ↓          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │ AsyncLogger  │  │  Tracer      │  │RootCause     │       │
│  │（日志批缓）  │  │（span收集）  │  │Analyzer      │       │
│  │              │  │              │  │（诊断分析）  │       │
│  │ • enqueue()  │  │ • span()     │  │              │       │
│  │ • flush()    │  │ • getTraces()│  │ • analyze()  │       │
│  │ • getStats() │  │              │  │ • getAdvice()│       │
│  └──────────────┘  └──────────────┘  └──────────────┘       │
│         ↓                  ↓                  ↓              │
│         └──────────────────┼──────────────────┘              │
│                            ↓                                 │
│         ┌──────────────────────────────────┐               │
│         │  MetricsAggregator [NEW]         │               │
│         │  • 聚合 span/log/系统指标         │               │
│         │  • 计算基线 & 异常告警            │               │
│         │  • 生成诊断报告                  │               │
│         └──────────────────────────────────┘               │
│                  ↓                    ↓                     │
│         ┌─────────────────┐  ┌──────────────────┐          │
│         │  API Endpoints  │  │ Web Dashboard    │          │
│         │  /api/stats     │  │ /dashboard       │          │
│         │  /api/metrics   │  │ React + ECharts  │          │
│         │  /api/traces    │  │                  │          │
│         │  /api/analyze   │  │                  │          │
│         └─────────────────┘  └──────────────────┘          │
│                                                               │
└─────────────────────────────────────────────────────────────┘

数据流向：
  应用操作
  ├─ tracer.span() → span 记录到 TracesBuffer
  ├─ logger.info() → 日志加入 AsyncLogger 队列
  └─ systemMonitor.record() → 指标记录（现有）
                   ↓
  MetricsAggregator（后台聚合线程）
  ├─ 每 5s 处理 span 和日志
  ├─ 计算聚合指标和基线
  ├─ 生成异常告警
  └─ 更新 RootCauseAnalyzer 状态
                   ↓
  API 层（同步返回）
  ├─ /api/stats → systemMonitor.getStats()
  ├─ /api/metrics → 聚合指标（缓存）
  ├─ /api/traces → 查询 span（按 contextId/traceId）
  └─ /api/analyze → 根因分析（基于聚合数据）
```

---

## 实现单元

### Unit 1：异步日志层（AsyncLogger）

**目标：** 优化日志输出性能，将同步写入改为异步缓冲。

**需求：** R5（日志性能优化）

**依赖：** 无

**文件：**
- Create: `src/utils/async-logger.ts`
- Test: `src/utils/__tests__/async-logger.test.ts`
- Modify: `src/utils/logger-config.ts`（集成 AsyncLogger）

**方法：**

- 创建 AsyncLogger 类，封装日志缓冲队列
- 实现 enqueue(logEntry) 方法，支持非阻塞写入
- 后台线程定期批量刷新（5s 间隔或 1000 条阈值）
- 集成到 logger-config 中的 Winston transport
- 提供 flush() 方法，用于进程关闭前清空队列

**技术设计：** *(伪代码)*

```
class AsyncLogger {
  private buffer: LogEntry[] = []
  private timerId: NodeJS.Timeout

  constructor(flushInterval = 5000, maxBufferSize = 1000) {
    this.timerId = setInterval(() => this.flush(), flushInterval)
  }

  enqueue(entry: LogEntry) {
    this.buffer.push(entry)
    if (this.buffer.length >= maxBufferSize) {
      this.flush()
    }
  }

  flush() {
    if (this.buffer.length === 0) return
    const entries = this.buffer.splice(0)
    // 异步写入磁盘（不阻塞）
    setImmediate(() => this.writeToFile(entries))
  }

  getStats() {
    return {
      pendingEntries: this.buffer.length,
      flushCount: this.stats.flushCount
    }
  }
}
```

**模式参考：**
- 现有 systemMonitor 的批量记录机制
- Winston transport 接口（write 方法实现）

**测试场景：**
- Happy path：连续 enqueue 100 条日志，验证缓冲后批量写入
- Edge case：缓冲上限触发（1000 条），验证自动刷新
- Edge case：进程关闭时，验证 flush() 清空所有待写入日志
- Error path：文件写入失败，验证错误日志（降级到 stderr）
- Integration：日志文件大小 < 原方案 10%（压缩）

**验证：**
- 日志写入 P99 延迟 < 10ms（相比原方案 > 50ms）
- 内存占用稳定（缓冲不无限增长）

---

### Unit 2：跨模块追踪系统（Tracer）

**目标：** 实现 span 级别的调用链追踪，支持跨模块操作的耗时、错误、上下文记录。

**需求：** R3（跨模块调用链追踪）

**依赖：** Unit 1（异步日志），context.ts（contextId）

**文件：**
- Create: `src/utils/tracer.ts`
- Create: `src/utils/trace-collector.ts`（span 存储和查询）
- Test: `src/utils/__tests__/tracer.test.ts`
- Modify: `src/utils/logger.ts`（集成 tracer API）

**方法：**

- 定义 Span 接口：`{ traceId, spanId, parentSpanId, name, startTime, duration, status, meta }`
- 实现 tracer.span(operationName, asyncFn) 高阶函数
- 自动从上下文获取 traceId（链路追踪 ID）和 parentSpanId
- 记录 span 的执行时间、错误、元数据
- TraceCollector 维护 span 缓冲，支持按 traceId/contextId 查询

**技术设计：** *(伪代码)*

```
type Span = {
  traceId: string,       // 链路 ID，同一请求全程使用
  spanId: string,        // 本 span 唯一 ID
  parentSpanId?: string, // 父 span ID
  name: string,          // 操作名，如 'services.publish.start'
  startTime: number,
  duration: number,
  status: 'ok' | 'error',
  errorMessage?: string,
  meta: Record<string, any> // 自定义元数据
}

async span<T>(
  name: string,
  fn: () => Promise<T>,
  meta?: Record<string, any>
): Promise<T> {
  const traceId = getContextTraceId() || generateTraceId()
  const spanId = generateSpanId()
  const startTime = Date.now()

  try {
    return await runWithContext({ traceId, spanId }, fn)
  } catch (err) {
    // 记录错误 span
    this.collect({
      traceId, spanId, parentSpanId: getCurrentSpanId(),
      name, startTime, duration: Date.now() - startTime,
      status: 'error', errorMessage: err.message, meta
    })
    throw err
  } finally {
    // 记录成功 span
  }
}
```

**模式参考：**
- 现有 context.ts 的 runWithContext 实现
- systemMonitor.measureOperation 的包装思路

**测试场景：**
- Happy path：嵌套调用（A → B → C），验证 span 链正确性
- Edge case：并发 span 调用，验证 traceId 不混淆
- Error path：span 中抛出异常，验证错误 span 记录
- Integration：与 logger 集成，日志中自动包含 spanId/traceId

**验证：**
- 100 个嵌套 span，无性能退化（相比无 span）< 5%
- 追踪链完整性 100%（无丢失的 span）

---

### Unit 3：指标聚合引擎（MetricsAggregator）

**目标：** 定期聚合 span、日志、系统指标，计算基线和异常告警。

**需求：** R6（性能基线与异常告警）

**依赖：** Unit 2（Tracer），systemMonitor.ts（现有指标）

**文件：**
- Create: `src/utils/metrics-aggregator.ts`
- Create: `src/utils/performance-baseline.ts`（基线计算）
- Test: `src/utils/__tests__/metrics-aggregator.test.ts`
- Modify: `src/utils/systemMonitor.ts`（暴露聚合数据）

**方法：**

- 后台定时任务（5 秒），聚合最近 span、日志、系统指标
- 计算操作的平均耗时、P95、P99、错误率
- 维护性能基线（滑动窗口 100 条，用于异常检测）
- 生成异常告警（操作耗时 > 1.5x 基线）
- 支持按操作名、时间范围查询聚合结果

**技术设计：** *(伪代码)*

```
interface AggregatedMetrics {
  timestamp: number,
  operations: {
    [operationName]: {
      count: number,
      avgDuration: number,
      p95Duration: number,
      p99Duration: number,
      errorRate: string,  // '%'
      baseline: number,   // 基线值
      isAnomaly: boolean, // 是否异常
      slowestTrace?: string // 最慢的 traceId
    }
  },
  systemMetrics: {
    cpu: number,
    memory: { rss, heapUsed, heapTotal },
    uptime: number
  }
}

class MetricsAggregator {
  private aggregationTimer: NodeJS.Timeout
  private baseline: Map<string, Baseline> = new Map()

  start() {
    this.aggregationTimer = setInterval(() => {
      this.aggregate()
    }, 5000)
  }

  private aggregate() {
    // 1. 收集最近 5s 的 span
    const spans = traceCollector.getRecent(5000)
    
    // 2. 按操作名分组统计
    const groupedByOp = this.groupByOperation(spans)
    
    // 3. 计算统计量（avg, p95, p99, errorRate）
    const metrics = this.computeMetrics(groupedByOp)
    
    // 4. 检测异常并更新基线
    const anomalies = this.detectAnomalies(metrics)
    
    // 5. 保存聚合结果
    this.saveAggregatedMetrics({
      timestamp: Date.now(),
      operations: metrics,
      systemMetrics: getResourceUsage(),
      anomalies
    })
  }

  private detectAnomalies(metrics: Metrics): Anomaly[] {
    return Object.entries(metrics)
      .filter(([op, m]) => {
        const baseline = this.baseline.get(op)?.avgDuration || m.avgDuration
        return m.avgDuration > baseline * 1.5
      })
      .map(([op, m]) => ({
        operation: op,
        actualDuration: m.avgDuration,
        baseline: this.baseline.get(op)?.avgDuration,
        severity: m.errorRate > 0.1 ? 'high' : 'medium'
      }))
  }
}
```

**模式参考：**
- systemMonitor 的统计计算
- 缓存命中率计算（scrapeCache.ts）

**测试场景：**
- Happy path：100 个 span，聚合后得到正确的平均、P95、P99
- Edge case：操作耗时波动（3s、5s、7s），异常检测触发
- Edge case：零样本时，基线初始化逻辑
- Integration：与 /api/stats 集成，返回最新聚合数据

**验证：**
- 异常检测准确性 > 95%（在 1.5x 基线的阈值下）
- 聚合延迟 < 500ms（不阻塞主线程）

---

### Unit 4：根因分析工具（RootCauseAnalyzer）

**目标：** 基于聚合指标和异常告警，提供快速根因分析和优化建议。

**需求：** R4（结构化根因分析工具）

**依赖：** Unit 3（MetricsAggregator），errorHandler.ts（错误分类）

**文件：**
- Create: `src/utils/root-cause-analyzer.ts`
- Create: `src/utils/recommendations.ts`（优化建议库）
- Test: `src/utils/__tests__/root-cause-analyzer.test.ts`
- Modify: `src/routes/api.ts`（新增 /api/analyze 端点）

**方法：**

- 输入：操作名 + 时间范围，输出：根因诊断 + 优化建议
- 诊断逻辑（启发式）：
  1. 检查错误率（>10% → 「错误堆积」，建议检查错误日志）
  2. 检查耗时异常（> 1.5x 基线 → 「性能下降」，列出慢 trace）
  3. 检查依赖操作（if publish_slow AND scrape_slow → 「上游阻塞」）
  4. 检查资源占用（CPU/内存 > 80% → 「资源竞争」）
- 优化建议库：按问题类型映射到具体的优化方向

**技术设计：** *(伪代码)*

```
interface RootCauseAnalysis {
  operation: string,
  timeRange: { start, end },
  
  diagnosis: {
    primary: string,      // 主要问题，如 '性能下降：publish_service 耗时增加 80%'
    factors: Array<{
      type: 'error' | 'latency' | 'resource' | 'dependency',
      severity: 'high' | 'medium' | 'low',
      metric: string,
      currentValue: number,
      baseline: number,
      affected: number    // 受影响的请求数
    }>
  },

  recommendations: Array<{
    priority: 1 | 2 | 3,
    title: string,           // 如 '优化 publish.ts 中的平台延迟'
    description: string,
    estimatedImprovement: string, // 如 '预期提速 30-50%'
    implementation: string,  // 简单说明（不是代码）
    relatedIssues: string[]
  }>,

  relatedTraces: Array<{
    traceId: string,
    duration: number,
    errorMessage?: string
  }>
}

class RootCauseAnalyzer {
  analyze(
    operation: string,
    timeRange: { start: number, end: number }
  ): RootCauseAnalysis {
    
    // 1. 获取聚合指标
    const metrics = metricsAggregator.query(operation, timeRange)
    
    // 2. 诊断问题
    const diagnosis = this.diagnose(operation, metrics)
    
    // 3. 生成建议
    const recommendations = this.generateRecommendations(diagnosis)
    
    // 4. 收集相关 trace
    const traces = traceCollector.query({
      name: operation,
      timeRange,
      sortBy: 'duration',
      limit: 5
    })
    
    return { operation, timeRange, diagnosis, recommendations, relatedTraces: traces }
  }

  private diagnose(
    operation: string,
    metrics: AggregatedMetrics[operation]
  ): Diagnosis {
    const factors = []
    
    // 检查 1: 错误率
    if (metrics.errorRate > 0.1) {
      factors.push({
        type: 'error',
        severity: metrics.errorRate > 0.5 ? 'high' : 'medium',
        metric: 'errorRate',
        currentValue: metrics.errorRate,
        baseline: 0.02
      })
    }
    
    // 检查 2: 延迟
    if (metrics.avgDuration > metrics.baseline * 1.5) {
      factors.push({
        type: 'latency',
        severity: metrics.avgDuration > metrics.baseline * 2.5 ? 'high' : 'medium',
        metric: 'avgDuration',
        currentValue: metrics.avgDuration,
        baseline: metrics.baseline
      })
    }
    
    // 检查 3: 依赖操作
    const slowDependencies = this.findSlowDependencies(operation, metrics.timeRange)
    if (slowDependencies.length > 0) {
      factors.push({
        type: 'dependency',
        severity: 'medium',
        metric: 'slowDependencies',
        currentValue: slowDependencies.length
      })
    }
    
    // 诊断：按严重度排序，选择主要问题
    const primary = factors
      .sort((a, b) => (a.severity === 'high' ? -1 : 1))
      .map(f => `${f.type.toUpperCase()}: ${f.metric} 异常`)
      .join('; ')
    
    return { primary, factors }
  }

  private generateRecommendations(diagnosis: Diagnosis): Recommendation[] {
    const recommendations = []
    
    for (const factor of diagnosis.factors) {
      if (factor.type === 'error') {
        recommendations.push({
          priority: 1,
          title: '查看错误日志，分类错误类型',
          description: `错误率 ${factor.currentValue.toFixed(2)}% 超过基线，建议审查日志。`,
          estimatedImprovement: '根据错误类型决定',
          relatedIssues: ['error-rate-spike']
        })
      } else if (factor.type === 'latency' && factor.operation === 'publish_service') {
        recommendations.push({
          priority: 2,
          title: '优化 publish.ts 中的平台延迟',
          description: '当前固定延迟 30-60s，建议改为平台适配 (2-8s) + 指数退避。',
          estimatedImprovement: '30-50% 性能提升',
          relatedIssues: ['publish-fixed-delay']
        })
      }
      // ... 更多规则
    }
    
    return recommendations
  }
}
```

**模式参考：**
- errorHandler.ts 的错误分类规则
- systemMonitor 的统计分析

**测试场景：**
- Happy path：输入 publish_service + 时间范围，输出包含 latency 和 recommendation
- Edge case：无历史数据（cold start），基线为 null，诊断退化为「无基线」提示
- Error path：查询时间范围超大（30 天），性能影响评估
- Integration：与 /api/analyze 端点集成，返回诊断报告

**验证：**
- 诊断准确性：与实际问题根源匹配度 > 80%（手工验证）
- 查询延迟 < 2s（支持实时仪表板）

---

### Unit 5：性能指标 API（Endpoints）

**目标：** 暴露 /api/stats、/api/metrics、/api/traces、/api/analyze 端点，支持远程查询。

**需求：** R1（性能指标远程查询）

**依赖：** Unit 1-4（各组件），routes 层

**文件：**
- Create: `src/routes/metrics.ts`（新路由模块）
- Modify: `src/index.ts`（注册路由）
- Test: `src/routes/__tests__/metrics.integration.test.ts`

**方法：**

- `GET /api/stats` → 返回 systemMonitor.getStats()（实时）
- `GET /api/metrics?operation=publish*&since=1h` → 查询聚合指标（缓存）
- `GET /api/traces?traceId=xyz` → 查询 span 链（按 traceId/contextId/timeRange）
- `POST /api/analyze` → body: {operation, timeRange} → 根因分析（同步返回）

**方法：**

- 使用现有的 asyncRoute 包装，统一错误处理
- 实现查询参数验证（timeRange、operation 名称格式）
- 缓存聚合指标结果（5 秒有效期）
- 日志审计（记录每个 API 调用）

**路由定义：** *(伪代码)*

```
router.get('/stats', asyncRoute(async (req, res) => {
  const stats = systemMonitor.getStats()
  res.json({
    ok: true,
    data: {
      timestamp: Date.now(),
      ...stats
    }
  })
}))

router.get('/metrics', asyncRoute(async (req, res) => {
  const { operation, since = '1h' } = req.query
  const timeRange = parseTimeRange(since)
  
  const metrics = metricsAggregator.query({
    operation: operation as string,
    ...timeRange
  })
  
  res.json({
    ok: true,
    data: { timeRange, metrics, generatedAt: Date.now() }
  })
}))

router.get('/traces', asyncRoute(async (req, res) => {
  const { traceId, contextId, since = '1h', limit = 50 } = req.query
  
  const query = {
    ...(traceId && { traceId }),
    ...(contextId && { contextId }),
    timeRange: parseTimeRange(since),
    limit: Math.min(limit as number, 100)  // 限制最多 100
  }
  
  const traces = traceCollector.query(query)
  
  res.json({
    ok: true,
    data: { query, traces, count: traces.length }
  })
}))

router.post('/analyze', asyncRoute(async (req, res) => {
  const { operation, timeRange } = req.body
  
  // 验证
  if (!operation) throw new BadRequestError('operation required')
  
  const analysis = rootCauseAnalyzer.analyze(operation, timeRange)
  
  res.json({
    ok: true,
    data: analysis
  })
}))
```

**模式参考：**
- src/routes/publish.ts（asyncRoute 包装）
- src/routes/_helpers.ts（错误处理）

**测试场景：**
- Happy path：GET /api/stats，返回有效的 stats 对象
- Happy path：GET /api/metrics?operation=publish*&since=1h，返回聚合指标
- Happy path：GET /api/traces?traceId=xyz，返回完整 span 链
- Happy path：POST /api/analyze，返回根因分析报告
- Edge case：查询不存在的 operation，返回空结果（而非 404）
- Error path：timeRange 格式错误，返回 400 Bad Request
- Integration：与 CORS 头配合，支持跨域查询

**验证：**
- API 响应时间 < 500ms（使用缓存）
- 支持并发查询（>10 concurrent requests）

---

### Unit 6：Web 监控仪表板

**目标：** 构建实时监控仪表板，展示关键性能指标、异常告警、根因分析。

**需求：** R2（性能监控仪表板）

**依赖：** Unit 5（API），前端框架（React）

**文件：**
- Create: `src/client/pages/dashboard.tsx`（主仪表板组件）
- Create: `src/client/components/MetricsChart.tsx`（图表组件）
- Create: `src/client/hooks/useMetrics.ts`（数据 Hook）
- Create: `src/client/utils/api.ts`（API 客户端）
- Modify: `src/client/App.tsx`（路由集成）
- Modify: `src/index.ts`（服务静态文件）

**方法：**

- React 组件：TopNav（导航） → MetricsPanel（关键指标卡） → ChartsSection（时间序列图表） → AnomaliesPanel（异常告警） → AnalysisPanel（根因分析）
- 数据获取：useMetrics Hook 定期轮询 /api/stats、/api/metrics（刷新周期 2s）
- 图表库：ECharts 绘制时间序列（操作耗时、错误率、吞吐量）
- 实时更新：WebSocket（可选，阶段二）或定时轮询（阶段一）
- UI 框架：Tailwind CSS（已有）+ 简易组件库

**组件树：** *(伪结构)*

```
Dashboard
├─ TopNav
│  ├─ 时间范围选择器（1h, 6h, 24h）
│  ├─ 自动刷新开关（启用/禁用）
│  └─ 刷新频率滑块（2s-30s）
├─ MetricsPanel
│  ├─ OperationCount（过去 1h 操作总数）
│  ├─ AvgLatency（平均延迟）
│  ├─ ErrorRate（错误率）
│  └─ SystemHealth（CPU/内存占用）
├─ ChartsSection
│  ├─ LatencyChart（操作耗时时间序列，按百分位 avg/p95/p99）
│  ├─ ThroughputChart（吞吐量时间序列）
│  ├─ ErrorRateChart（错误率时间序列）
│  └─ DependencyGraph（依赖关系可视化）[可选]
├─ AnomaliesPanel
│  ├─ 异常告警列表（操作名 + 偏差百分比 + 时间戳）
│  └─ 一键跳转到根因分析
└─ AnalysisPanel
   ├─ 选择操作 → 触发 /api/analyze
   ├─ 诊断结果展示
   └─ 优化建议列表（可展开详情）
```

**技术实现：** *(伪代码)*

```typescript
// src/client/hooks/useMetrics.ts
function useMetrics(timeRange: string) {
  const [metrics, setMetrics] = useState(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const fetchMetrics = async () => {
      setLoading(true)
      try {
        const res = await fetch(`/api/metrics?since=${timeRange}`)
        const data = await res.json()
        setMetrics(data.data)
      } finally {
        setLoading(false)
      }
    }

    fetchMetrics()
    const timer = setInterval(fetchMetrics, 2000) // 2s 轮询

    return () => clearInterval(timer)
  }, [timeRange])

  return { metrics, loading }
}

// src/client/components/MetricsChart.tsx
function MetricsChart({ data }) {
  const chartRef = useRef()

  useEffect(() => {
    if (!chartRef.current || !data) return

    const chart = echarts.init(chartRef.current)
    chart.setOption({
      xAxis: { type: 'time' },
      yAxis: { type: 'value' },
      series: [
        { name: 'avg', data: data.avgDuration, type: 'line' },
        { name: 'p95', data: data.p95Duration, type: 'line', smooth: true },
        { name: 'p99', data: data.p99Duration, type: 'line', smooth: true }
      ]
    })
  }, [data])

  return <div ref={chartRef} style={{ width: '100%', height: 400 }} />
}

// src/client/pages/dashboard.tsx
export function Dashboard() {
  const [timeRange, setTimeRange] = useState('1h')
  const [selectedOp, setSelectedOp] = useState(null)
  
  const { metrics, loading } = useMetrics(timeRange)
  const stats = useStats() // 实时 stats

  return (
    <div className="dashboard">
      <TopNav timeRange={timeRange} onTimeRangeChange={setTimeRange} />
      
      {loading ? (
        <Spinner />
      ) : (
        <>
          <MetricsPanel stats={stats} metrics={metrics} />
          <ChartsSection metrics={metrics} />
          <AnomaliesPanel 
            anomalies={metrics?.anomalies}
            onSelectAnomaly={(op) => setSelectedOp(op)}
          />
          {selectedOp && (
            <AnalysisPanel operation={selectedOp} timeRange={timeRange} />
          )}
        </>
      )}
    </div>
  )
}
```

**模式参考：**
- src/client 中现有的 React 组件结构
- Tailwind CSS 样式约定

**测试场景：**
- Happy path：加载仪表板，显示最近 1h 的指标和图表
- Happy path：切换时间范围（1h → 6h），图表自动更新
- Happy path：点击异常告警，跳转到根因分析，显示诊断报告
- Edge case：数据为空（系统刚启动），显示「暂无数据」提示
- Edge case：API 查询失败，显示重试按钮和错误信息
- Performance：100 个数据点的图表，渲染耗时 < 500ms

**验证：**
- 仪表板首屏加载 < 2s
- 图表平滑滚动（帧率 > 30 FPS）
- 支持 > 50 并发用户查看

---

### Unit 7：动态延迟优化（publish.ts）

**目标：** 优化 publish.ts 中的固定延迟问题，改为平台适配 + 动态调整。

**需求：** R5（日志性能优化间接相关），解决 🔴 性能瓶颈

**依赖：** systemMonitor（性能监控），logger（日志）

**文件：**
- Modify: `src/routes/publish.ts`（L56, L101-103）
- Create: `src/utils/platform-delay-config.ts`（平台延迟配置）
- Test: `src/routes/__tests__/publish.integration.test.ts`（新增场景）

**方法：**

1. 创建平台延迟配置表：
   ```
   {
     'Blogger': { min: 1000, max: 3000 },
     'Medium': { min: 3000, max: 8000 },
     'Dev.to': { min: 2000, max: 5000 },
     'GitHub': { min: 1000, max: 2000 },
     'Telegraph': { min: 2000, max: 4000 },
     'Hashnode': { min: 3000, max: 6000 },
     'WordPress': { min: 4000, max: 10000 }
   }
   ```

2. 在发布每个平台后，使用平台对应的延迟范围

3. 批量处理延迟：改为指数退避（初始 5s，每次 × 1.2，最大 20s）或基于成功率动态调整

4. 所有延迟参数可通过环境变量覆盖（支持动态调优）

5. 记录每次延迟到 systemMonitor，便于分析

**代码改动：** *(伪代码)*

```typescript
// src/utils/platform-delay-config.ts
export const PLATFORM_DELAYS = {
  'Blogger': { min: 1000, max: 3000 },
  'Medium': { min: 3000, max: 8000 },
  // ...
}

export function getPlatformDelay(platform: string): number {
  const config = PLATFORM_DELAYS[platform] || { min: 2000, max: 5000 }
  const envVar = process.env[`DELAY_${platform.toUpperCase()}_MS`]
  
  if (envVar) {
    return parseInt(envVar)
  }
  
  return Math.random() * (config.max - config.min) + config.min
}

// src/routes/publish.ts，Line 56 之前
import { getPlatformDelay } from '../utils/platform-delay-config'
import { systemMonitor } from '../utils/systemMonitor'

// 修改发布循环
for (const platform of platforms) {
  try {
    await adapters[platform].publish(article)
    const delay = getPlatformDelay(platform)
    systemMonitor.recordOperation(`publish.delay.${platform}`, delay, true)
    await sleep(delay)  // 改为平台适配延迟
  } catch (err) {
    logger.error(`publish.${platform}.failed`, { error: err.message })
  }
}

// 批量处理延迟：指数退避
let batchDelay = 30000  // 初始 30s
for (let i = 0; i < articles.length; i++) {
  // 发布当前文章
  // ...
  
  if (i < articles.length - 1) {
    const exponentialDelay = Math.min(batchDelay * 1.2, 60000)  // 最多 60s
    systemMonitor.recordOperation('publish.batch.delay', exponentialDelay, true)
    await sleep(exponentialDelay)
    batchDelay = exponentialDelay
  }
}
```

**模式参考：**
- src/utils/smartRetry.ts 的指数退避实现
- systemMonitor 的操作记录

**测试场景：**
- Happy path：发布 3 个平台，延迟按平台调整（2-3s, 4-8s, 2-5s）
- Happy path：批量发布 5 篇文章，延迟按指数退避（30s × 1.2^n）
- Edge case：环境变量 DELAY_MEDIUM_MS=5000，覆盖默认配置
- Edge case：不存在的平台，使用默认延迟（2-5s）
- Integration：所有延迟操作记录到 systemMonitor，可通过 /api/metrics 查询

**验证：**
- 平均发布延迟 < 原方案 40%（从 60s 降至 36s）
- 吞吐量提升 40%
- 错误率不增加

---

### Unit 8：文档与集成指南

**目标：** 编写完整的使用文档、集成指南，方便开发者快速上手。

**需求：** 支持 R1-R6 的可使用性

**依赖：** Unit 1-7（全部功能）

**文件：**
- Create: `docs/DEBUG_OPTIMIZATION_GUIDE.md`（总体指南）
- Create: `docs/API_METRICS_REFERENCE.md`（API 文档）
- Create: `docs/INSTRUMENTATION_GUIDE.md`（埋点指南）
- Modify: `DEVELOPMENT.md`（补充调试章节）

**内容大纲：**

1. **DEBUG_OPTIMIZATION_GUIDE.md**
   - 快速开始（查看仪表板，解读异常告警）
   - 根因分析工作流（从异常 → 诊断 → 优化建议）
   - 常见问题 FAQ
   - 最佳实践

2. **API_METRICS_REFERENCE.md**
   - 各 API 端点详细说明（参数、响应格式、示例）
   - 时间范围格式（1h, 6h, 24h, custom）
   - 查询示例（curl、JavaScript）

3. **INSTRUMENTATION_GUIDE.md**
   - 如何在新模块中使用 logger（日志规范）
   - 如何在关键操作中使用 tracer.span（追踪埋点）
   - 性能指标的解读

**验证：**
- 文档完整性（包含所有公共 API）
- 示例可执行性（curl 命令可直接运行）

---

## 系统级影响分析

### 交互图表

关键组件间的交互关系：

```
应用层请求 (routes/services)
    ↓
    ├→ logger.info() ─→ AsyncLogger (Unit 1)
    ├→ tracer.span() ─→ TraceCollector (Unit 2)
    └→ systemMonitor.record() (现有)
    
    ↓ (后台 5s 聚合)
    
MetricsAggregator (Unit 3)
    ↓
    ├→ 计算基线、异常检测
    └→ 更新内存缓存
    
    ↓ (API 查询)
    
API 层 (Unit 5)
    ├→ /api/stats
    ├→ /api/metrics
    ├→ /api/traces
    └→ /api/analyze ─→ RootCauseAnalyzer (Unit 4)
    
    ↓ (前端轮询)
    
Web Dashboard (Unit 6)
    ├→ 展示关键指标
    ├→ 绘制时间序列图表
    └→ 展示异常告警 & 优化建议
```

### 失败处理

- **AsyncLogger 队列溢出：** 设置最大缓冲上限（10000 条），超过时丢弃最早的日志，记录告警
- **TraceCollector 内存爆炸：** 设置最大 span 数（100000 条），超过时按 FIFO 驱逐，记录指标
- **API 查询超时：** 返回 504 Gateway Timeout，建议缩小时间范围
- **仪表板请求失败：** 前端降级显示缓存数据或「暂无数据」提示

### 数据一致性

- **contextId 追踪链完整性：** 由 cls-hooked 保证，无需额外处理
- **span 与 log 的时间戳同步：** 都使用 Date.now()，精度 ms 级
- **基线更新竞态：** 基线计算为原子操作（Map 赋值），无并发问题

### 性能与可扩展性

- **异步日志：** 减少主线程阻塞，预期 P99 延迟从 50ms → 10ms
- **指标聚合：** 5s 聚合周期，相比实时计算成本降低 80%
- **API 缓存：** 聚合结果缓存 5s，相同查询命中缓存，查询延迟 < 100ms
- **仪表板轮询：** 2s 刷新周期，相比 WebSocket 实时方案更简洁，足够满足监控需求

---

## 风险分析

| 风险 | 可能性 | 影响 | 缓解 |
|------|--------|------|------|
| AsyncLogger 队列丢失日志 | 中 | 失去诊断信息 | 设置告警 + 定期持久化 |
| TraceCollector 内存溢出 | 低 | OOM 应用崩溃 | 设置上限 + 定期清理 |
| 性能基线初始化问题 | 低 | 异常检测误报 | 学习期 100 条样本后启用 |
| 前端仪表板卡顿 | 低 | 用户体验差 | 图表数据采样 + 增量更新 |

---

## 排序与依赖

```
Unit 1: AsyncLogger
    ↓
Unit 2: Tracer ──→ Unit 3: MetricsAggregator ──→ Unit 4: RootCauseAnalyzer
    ↓                                                   ↓
Unit 5: API Endpoints ────────────────────────────────┘
    ↓
Unit 6: Web Dashboard

Unit 7: publish.ts 延迟优化 (可并行)

Unit 8: 文档 (最后)
```

**并行可能性：**
- Unit 1, 2 可并行（无依赖）
- Unit 7 可与 1-4 并行（独立修改）
- Unit 8 在 7 完成后开始

**建议执行顺序：**
1. Unit 1 + Unit 2（基础层，2-3 天）
2. Unit 3 + Unit 4（聚合分析层，2-3 天）
3. Unit 5（API 层，1-2 天）
4. Unit 6（前端仪表板，2-3 天）
5. Unit 7（性能优化，1 天）
6. Unit 8（文档，1 天）

**总耗时估计：** 10-14 天（4 人周）

---

## 后续考虑（不在本计划范围）

- ⏳ WebSocket 实时日志推送（性能消耗较大，暂不优先）
- ⏳ 分布式追踪完整集成（OpenTelemetry）
- ⏳ 机器学习异常检测
- ⏳ 告警通知集成（Slack、钉钉）
- ⏳ 性能自动优化建议（AI 驱动）

---

## 成功指标

在完成本计划后，系统应满足：

- ✅ 日志写入 P99 延迟 < 10ms
- ✅ 100% 关键操作有 span 追踪，无丢失
- ✅ 5 分钟内可诊断性能异常根因
- ✅ 仪表板支持 > 50 并发用户
- ✅ 新模块日志接入成本 < 5 分钟
- ✅ 文档完整且示例可执行

---

## 参考资源

- [现有 logger 实现](src/utils/logger.ts)
- [现有 systemMonitor](src/utils/systemMonitor.ts)
- [现有 context.ts](src/utils/context.ts)
- [Winston 文档](https://github.com/winstonjs/winston)
- [React Hooks 最佳实践](https://react.dev/reference/react/hooks)
- [ECharts 文档](https://echarts.apache.org)
