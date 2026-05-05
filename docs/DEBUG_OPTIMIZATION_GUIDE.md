# 调试优化系统使用指南

## 快速开始

### 访问仪表板

性能监控仪表板可通过以下方式访问：

```
http://localhost:3000/dashboard
```

仪表板实时显示：
- **关键指标**：操作总数、平均延迟、错误率、系统状态
- **时间序列图表**：延迟趋势（avg/p95/p99）、错误率趋势
- **异常告警**：性能下降或错误率异常的操作
- **根因分析**：输入操作名称获取诊断和优化建议

### 理解异常告警

仪表板异常告警面板会实时列出：

| 指标 | 触发条件 | 含义 |
|------|--------|------|
| 延迟异常 | avgDuration > 1.5x baseline | 操作耗时超过基线 |
| 错误率 | errorRate > 10% | 错误率显著上升 |

**行动**：点击任何异常的「分析」按钮，跳转到根因分析。

---

## 根因分析工作流

### 场景 1：收到性能告警

1. **打开仪表板** → 在「异常告警」面板看到操作性能下降
2. **点击「分析」按钮** → 自动分析该操作的诊断报告
3. **查看诊断** → 系统列出了什么问题（延迟 / 错误 / 资源）
4. **按优先级执行建议** → P1（紧急）优先处理

**示例输出：**

```
诊断: 性能下降：services.publish.start 耗时增加 80% + 错误率升高（15%）

问题因素：
  [latency] avgDuration: 2500.00 (基线: 1389.00, 严重度: high)
  [error] errorRate: 0.15 (基线: 0.02, 严重度: high)

优化建议：
  [P1] 查看错误日志并分析错误类型
       错误率 15.00%，影响 150 个请求
       实现: 使用 /api/traces 端点查询失败的 trace，分析错误堆栈

  [P2] 优化发布路由中的固定延迟
       当前耗时 2500.00ms，基线 1389.00ms
       预期改进: 30-50% 性能提升
       实现: 将发布路由中的固定延迟改为平台适配延迟 + 指数退避

置信度: 95%
```

### 场景 2：主动诊断特定操作

1. 在根因分析面板输入操作名称（支持 * 通配符）
2. 点击「分析」按钮
3. 获取该操作的完整诊断报告

**操作名称示例：**
- `services.publish.start` - 发布服务启动
- `services.*.start` - 所有服务启动
- `publish*` - 所有发布相关操作

---

## 常见问题 FAQ

### Q1: 仪表板显示「暂无数据」

**原因：** 系统刚启动或没有操作发生

**解决：**
1. 确保系统已运行至少 5 秒（指标聚合周期）
2. 执行一些操作（如发布文章）
3. 点击「刷新」按钮或等待自动刷新（2 秒）

### Q2: 延迟数据为什么不更新？

**原因：** 可能是以下之一
- 网络问题（浏览器 → API 连接失败）
- 指标聚合服务未运行
- API 端点异常

**诊断步骤：**
```bash
# 检查 API 是否响应
curl http://localhost:3000/api/stats

# 输出应包含 systemMonitor 和 metricsAggregator 统计
{
  "ok": true,
  "data": {
    "timestamp": 1714920000000,
    "systemMonitor": { ... },
    "metricsAggregator": { ... }
  }
}
```

### Q3: 如何重置性能基线？

基线是自动学习的（前 100 个样本），无需手动重置。

如需重新学习：
```bash
# 1. 重启应用（清除内存中的指标）
npm start

# 2. 系统会在 100 个新样本后重新计算基线
```

### Q4: 置信度（Confidence）是什么意思？

置信度表示诊断的可靠性（0-100%）：
- **< 50%** - 样本数据太少，诊断不可靠
- **50-80%** - 可以参考，但需验证
- **> 80%** - 诊断结果可靠，可以采取行动

**提高置信度的方法：** 收集更多样本（运行更多操作）

### Q5: 错误率数据从哪里来？

错误率统计来自：
1. **Tracer span 失败记录** - 操作中抛出异常
2. **应用日志** - 记录的 error 级别日志
3. **API 调用失败** - HTTP 5xx 响应

查看具体错误：
```bash
# 获取最近 1 小时的失败 trace
curl 'http://localhost:3000/api/traces?name=services.publish*&since=1h' \
  | jq '.data.traces[] | select(.status == "error")'
```

---

## 最佳实践

### 1. 定期监控仪表板

**建议频率：** 每周 1-2 次

- 观察延迟趋势是否稳定
- 发现潜在的性能隐患（>5% 错误率）
- 记录 baseline 变化（是否有长期趋势）

### 2. 在重大变更后观察指标

发布新代码后，应该：

```
发布 → 等待 5min → 打开仪表板 → 检查是否有新的异常
  → 如有异常，立即查看诊断和建议
  → 根据建议调整代码或配置
```

### 3. 使用 Root Cause Analysis 推动优化

不要等待告警，主动使用 RCA 来发现优化机会：

```
每周选择 3-5 个关键操作
  ↓
运行 RCA（分析最近 24h 数据）
  ↓
收集建议（优先级 2、3 的改进）
  ↓
创建 issue 或 PR 实现
```

### 4. 记录 Baseline 变化

如果 baseline 大幅波动（> 20% 变化），记录原因：

```
日期: 2026-05-05
操作: services.publish.start
基线变化: 1000ms → 1500ms (+50%)
原因: 新增错误处理逻辑
行动: 继续监控，计划优化
```

### 5. 关注依赖操作的性能

某个操作延迟可能由上游操作引起：

```
如果 publish.end 延迟高
  ↓
检查 tracer 链中的 publish.*.start 是否也延迟高
  ↓
是 → 根因在 publish 步骤
否 → 根因在 cleanup 步骤
```

---

## 性能优化循环

完整的优化循环应该是：

```
┌─ 监控（Dashboard）
│  ├─ 发现异常操作
│  └─ 触发诊断
│
├─ 诊断（Root Cause Analysis）
│  ├─ 分析问题因素
│  └─ 获取优化建议
│
├─ 改进（Implement）
│  ├─ 按建议修改代码
│  └─ 部署变更
│
├─ 验证（Validate）
│  ├─ 等待 5-10 min 数据收集
│  ├─ 重新运行诊断
│  └─ 对比改进前后指标
│
└─ 迭代（Repeat）
   └─ 继续优化次优因素
```

---

## 故障排除

### 仪表板无法加载

**错误信息：** `Cannot GET /dashboard`

**解决：**
```bash
# 确认仪表板文件存在
ls -la public/dashboard.html
ls -la public/dashboard.js

# 如不存在，需要重新部署应用
npm run build
npm start
```

### 图表不显示

**原因：** ECharts CDN 加载失败或数据为空

**诊断：**
```javascript
// 在浏览器开发者工具 Console 中运行
// 检查 ECharts 是否加载
console.log(typeof echarts)  // 应输出 "object"

// 检查数据是否到达
fetch('/api/metrics?since=1h')
  .then(r => r.json())
  .then(d => console.log(d))
```

**修复：**
- 如果 ECharts 未加载，检查网络连接和 CDN 可用性
- 如果数据为空，确保系统有正在执行的操作

### API 返回 500 错误

**原因：** 后端服务异常

**诊断：**
```bash
# 检查应用日志
npm start 2>&1 | grep -i error

# 检查是否是特定操作的问题
curl 'http://localhost:3000/api/analyze' \
  -X POST \
  -H 'Content-Type: application/json' \
  -d '{"operation":"services.publish.start"}'
```

---

## 相关资源

- **API 文档**: 见 `docs/API_METRICS_REFERENCE.md`
- **埋点指南**: 见 `docs/INSTRUMENTATION_GUIDE.md`
- **系统架构**: 见 `src/ARCHITECTURE.md`
- **源代码**:
  - 仪表板: `public/dashboard.html`, `public/dashboard.js`
  - 后端 API: `src/routes/metrics.ts`
  - 核心模块: `src/utils/metrics-aggregator.ts`, `src/utils/root-cause-analyzer.ts`
