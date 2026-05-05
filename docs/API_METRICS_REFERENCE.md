# 性能指标 API 参考

所有 API 端点基础 URL: `http://localhost:3000/api`

---

## GET /api/stats

获取实时系统统计信息（CPU、内存、运行时间）。

### 请求

```bash
curl http://localhost:3000/api/stats
```

### 响应

```json
{
  "ok": true,
  "data": {
    "timestamp": 1714920000000,
    "systemMonitor": {
      "uptime": 3600,
      "memory": {
        "rss": 102400000,
        "heapUsed": 51200000,
        "heapTotal": 102400000,
        "percentage": 50
      },
      "cpu": 25,
      "slowOperations": []
    },
    "metricsAggregator": {
      "isRunning": true,
      "aggregationCount": 15,
      "lastAggregationTime": "2026-05-05T14:41:03Z",
      "operationCount": 127
    }
  }
}
```

### 参数

无

### 响应字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `timestamp` | number | 当前时间戳（毫秒） |
| `systemMonitor.uptime` | number | 应用运行时长（秒） |
| `systemMonitor.memory` | object | 内存使用统计 |
| `systemMonitor.cpu` | number | CPU 使用率（0-100%） |
| `metricsAggregator.isRunning` | boolean | 指标聚合是否运行中 |
| `metricsAggregator.aggregationCount` | number | 已完成的聚合周期数 |
| `metricsAggregator.operationCount` | number | 已追踪的不同操作数 |

---

## GET /api/metrics

查询聚合指标，支持按操作名和时间范围筛选。

### 请求

```bash
# 查询所有操作，最近 1 小时
curl 'http://localhost:3000/api/metrics?since=1h'

# 查询特定操作，支持通配符
curl 'http://localhost:3000/api/metrics?operation=services.publish*&since=6h'

# 限制结果数量
curl 'http://localhost:3000/api/metrics?since=1h&limit=10'
```

### 参数

| 参数 | 类型 | 必需 | 默认 | 说明 |
|------|------|------|------|------|
| `operation` | string | 否 | * | 操作名称，支持 * 通配符（如 `publish*` 匹配所有发布操作） |
| `since` | string | 否 | 1h | 时间范围，格式 `<数字><单位>`，单位: s/m/h/d/w |
| `limit` | number | 否 | 50 | 最多返回条数（上限 1000） |

### 响应

```json
{
  "ok": true,
  "data": {
    "query": {
      "operation": "services.publish*",
      "since": "1h",
      "limit": 50
    },
    "timeRange": {
      "start": 1714916400000,
      "end": 1714920000000
    },
    "results": [
      {
        "timestamp": 1714919500000,
        "operations": {
          "services.publish.start": {
            "count": 42,
            "avgDuration": 1500,
            "p95Duration": 2300,
            "p99Duration": 3100,
            "errorRate": 0.05,
            "baseline": 1000,
            "isAnomaly": true
          }
        },
        "systemMetrics": {
          "cpu": 45,
          "memory": {
            "rss": 110000000,
            "heapUsed": 55000000,
            "heapTotal": 110000000
          },
          "uptime": 3600
        }
      }
    ],
    "count": 1,
    "generatedAt": 1714920000000
  }
}
```

### 响应字段

| 字段 | 说明 |
|------|------|
| `results[]` | 聚合结果数组，每条包含时间戳、操作指标、系统指标 |
| `results[].operations.<op>` | 操作的聚合统计 |
| `.count` | 该时间段内的操作次数 |
| `.avgDuration` | 平均耗时（毫秒） |
| `.p95Duration` | 95 分位数耗时 |
| `.p99Duration` | 99 分位数耗时 |
| `.errorRate` | 错误率（0-1） |
| `.baseline` | 性能基线（毫秒） |
| `.isAnomaly` | 是否为异常（超过 1.5x 基线） |

### 时间范围格式

| 格式 | 含义 |
|------|------|
| `10s` | 最近 10 秒 |
| `5m` | 最近 5 分钟 |
| `1h` | 最近 1 小时 |
| `24h` | 最近 24 小时 |
| `7d` | 最近 7 天 |

---

## GET /api/traces

查询分布式追踪（Span），支持按 ID、名称、时间范围筛选。

### 请求

```bash
# 查询特定 traceId 的所有 span
curl 'http://localhost:3000/api/traces?traceId=abc123'

# 查询名称匹配的 span，最近 6 小时
curl 'http://localhost:3000/api/traces?name=services.publish*&since=6h'

# 查询失败的 span，按耗时排序
curl 'http://localhost:3000/api/traces?status=error&limit=10'
```

### 参数

| 参数 | 类型 | 必需 | 默认 | 说明 |
|------|------|------|------|------|
| `traceId` | string | 否 | - | 追踪 ID，返回该链路的所有 span |
| `contextId` | string | 否 | - | 上下文 ID（对应 HTTP 请求） |
| `name` | string | 否 | - | Span 名称，支持 * 通配符 |
| `since` | string | 否 | 1h | 时间范围 |
| `limit` | number | 否 | 50 | 最多返回条数（上限 100） |

### 响应

```json
{
  "ok": true,
  "data": {
    "query": {
      "traceId": "trace-abc123",
      "contextId": null,
      "name": null,
      "since": "1h",
      "limit": 50
    },
    "timeRange": {
      "start": 1714916400000,
      "end": 1714920000000
    },
    "traces": [
      {
        "traceId": "trace-abc123",
        "spanId": "span-001",
        "parentSpanId": null,
        "name": "services.publish.start",
        "duration": 1523,
        "status": "ok",
        "errorMessage": null,
        "startTime": 1714919500000,
        "meta": {
          "platform": "Medium",
          "articleId": "art-001"
        }
      },
      {
        "traceId": "trace-abc123",
        "spanId": "span-002",
        "parentSpanId": "span-001",
        "name": "adapter.medium.publish",
        "duration": 1200,
        "status": "ok",
        "errorMessage": null,
        "startTime": 1714919500200,
        "meta": {}
      }
    ],
    "count": 2,
    "generatedAt": 1714920000000
  }
}
```

### 响应字段

| 字段 | 说明 |
|------|------|
| `traces[].traceId` | 追踪链 ID（同一请求内相同） |
| `traces[].spanId` | 当前 span 唯一 ID |
| `traces[].parentSpanId` | 父 span ID（嵌套关系） |
| `traces[].name` | Span 操作名 |
| `traces[].duration` | 执行耗时（毫秒） |
| `traces[].status` | 执行状态（ok / error） |
| `traces[].errorMessage` | 错误信息（如有） |
| `traces[].startTime` | 开始时间戳 |
| `traces[].meta` | 自定义元数据 |

---

## POST /api/analyze

执行根因分析，诊断性能问题并提供优化建议。

### 请求

```bash
# 分析特定操作，使用默认时间范围（最近 1 小时）
curl -X POST http://localhost:3000/api/analyze \
  -H 'Content-Type: application/json' \
  -d '{"operation":"services.publish.start"}'

# 分析自定义时间范围
curl -X POST http://localhost:3000/api/analyze \
  -H 'Content-Type: application/json' \
  -d '{
    "operation": "services.publish.start",
    "timeRange": {
      "start": 1714910400000,
      "end": 1714920000000
    }
  }'
```

### 请求体

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `operation` | string | 是 | 待分析的操作名称 |
| `timeRange.start` | number | 否 | 时间范围起点（毫秒时间戳） |
| `timeRange.end` | number | 否 | 时间范围终点（毫秒时间戳） |

### 响应

```json
{
  "ok": true,
  "data": {
    "operation": "services.publish.start",
    "timeRange": {
      "start": 1714916400000,
      "end": 1714920000000
    },
    "diagnosis": {
      "primary": "性能下降：publish_service 耗时增加 80%",
      "factors": [
        {
          "type": "latency",
          "severity": "high",
          "metric": "avgDuration",
          "currentValue": 2500,
          "baseline": 1389,
          "affectedCount": 42
        },
        {
          "type": "error",
          "severity": "medium",
          "metric": "errorRate",
          "currentValue": 0.15,
          "baseline": 0.02,
          "affectedCount": 6
        }
      ]
    },
    "recommendations": [
      {
        "priority": 1,
        "title": "查看错误日志并分析错误类型",
        "description": "错误率 15.00%，影响 6 个请求",
        "estimatedImprovement": "根据错误类型决定",
        "implementation": "使用 /api/traces 端点查询失败的 trace，分析错误堆栈",
        "relatedIssues": ["error-rate-spike"]
      },
      {
        "priority": 2,
        "title": "优化发布路由中的固定延迟",
        "description": "当前耗时 2500.00ms，基线 1389.00ms",
        "estimatedImprovement": "30-50% 性能提升",
        "implementation": "将发布路由中的固定延迟改为平台适配 (2-8s) + 指数退避",
        "relatedIssues": ["publish-fixed-delay"]
      }
    ],
    "relatedTraces": [
      {
        "traceId": "trace-001",
        "duration": 3200,
        "errorMessage": null
      }
    ],
    "confidence": 0.95
  }
}
```

### 响应字段

| 字段 | 说明 |
|------|------|
| `diagnosis.primary` | 主要诊断结果 |
| `diagnosis.factors[]` | 问题因素列表 |
| `factors[].type` | 因素类型（error / latency / resource / dependency） |
| `factors[].severity` | 严重度（high / medium / low） |
| `recommendations[]` | 优化建议列表 |
| `recommendations[].priority` | 优先级（1 = 紧急，2 = 重要，3 = 可选） |
| `relatedTraces[]` | 相关 trace 列表（最多 5 条） |
| `confidence` | 诊断置信度（0-1） |

---

## GET /api/baselines

获取所有操作的性能基线信息。

### 请求

```bash
curl http://localhost:3000/api/baselines
```

### 响应

```json
{
  "ok": true,
  "data": {
    "baselines": [
      {
        "operation": "services.publish.start",
        "baseline": 1389,
        "samples": 234,
        "lastUpdated": 1714920000000
      },
      {
        "operation": "services.scrape.execute",
        "baseline": 3200,
        "samples": 189,
        "lastUpdated": 1714920000000
      }
    ],
    "count": 2,
    "generatedAt": 1714920000000
  }
}
```

---

## POST /api/metrics/start

启动指标聚合引擎（通常自动启动，手动控制场景）。

### 请求

```bash
curl -X POST http://localhost:3000/api/metrics/start
```

### 响应

```json
{
  "ok": true,
  "message": "Metrics aggregator started",
  "data": {
    "timestamp": 1714920000000
  }
}
```

---

## POST /api/metrics/stop

停止指标聚合引擎。

### 请求

```bash
curl -X POST http://localhost:3000/api/metrics/stop
```

### 响应

```json
{
  "ok": true,
  "message": "Metrics aggregator stopped",
  "data": {
    "timestamp": 1714920000000
  }
}
```

---

## 错误处理

所有 API 返回标准错误格式：

```json
{
  "ok": false,
  "error": "Invalid operation name"
}
```

### 常见错误

| HTTP 状态 | 错误 | 原因 |
|---------|------|------|
| 400 | Invalid operation name | operation 参数不合法 |
| 400 | Invalid time range | since 或 timeRange 格式错误 |
| 400 | operation is required | POST 请求缺少 operation 字段 |
| 500 | Internal server error | 后端异常 |

---

## 速率限制

目前无速率限制，建议在生产环境中：
- 查询频率不超过 10 req/s
- 时间范围不超过 30 天
- limit 参数不超过 1000

---

## 示例使用

### 场景 1：监控 publish 操作

```bash
#!/bin/bash

# 获取最近 1 小时的 publish 指标
echo "=== Publish Metrics (Last 1 Hour) ==="
curl -s 'http://localhost:3000/api/metrics?operation=services.publish*&since=1h' \
  | jq '.data.results[] | .operations | keys'

# 获取最近 6 小时的诊断报告
echo -e "\n=== Publish Analysis (Last 6 Hours) ==="
curl -s -X POST http://localhost:3000/api/analyze \
  -H 'Content-Type: application/json' \
  -d '{
    "operation": "services.publish.start",
    "timeRange": {
      "start": '$(date -d '6 hours ago' '+%s000')',
      "end": '$(date '+%s000')'
    }
  }' | jq '.data.diagnosis'
```

### 场景 2：追踪故障请求

```bash
#!/bin/bash

# 查询最近 2 小时的失败 trace
curl -s 'http://localhost:3000/api/traces?since=2h&limit=20' \
  | jq '.data.traces[] | select(.status == "error")' \
  | jq '{traceId, name, duration, errorMessage}'
```

---

## 相关资源

- **仪表板**: http://localhost:3000/dashboard
- **使用指南**: 见 `docs/DEBUG_OPTIMIZATION_GUIDE.md`
- **埋点指南**: 见 `docs/INSTRUMENTATION_GUIDE.md`
