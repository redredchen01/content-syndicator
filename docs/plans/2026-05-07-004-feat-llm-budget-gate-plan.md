---
title: feat: LLM Budget Gate + Auto Model Downgrade
type: feat
status: completed
date: 2026-05-07
completed: 2026-05-07T17:58:00Z
---

# LLM Budget Gate + Auto Model Downgrade

## Overview

实现预生成预检查网关，在 LLM 调用超出日/月预算前主动拦截，并通过级联模型降级（`gpt-4o → gpt-4o-mini → gemini-1.5-flash`）在预算约束下继续工作。系统目前有成本记录和预算常数定义，但缺少执行层的预防性网关。

## Problem Frame

当前系统无法在 LLM 成本超支前采取行动。`LLM_BUDGET` 常数已定义，`llm_calls` 表记录了每次调用的成本，但生成流程没有预检查。一旦开始生成变体批次，即使预算即将用尽也会继续生成，导致成本爆炸（一个回归 bug 触发重试可无声烧掉 $20+）。

同时，当单个 LLM 提供者受限（Gemini 配额耗尽、OpenAI 限流）时，系统无法自动降级到更便宜的模型。

## Requirements Trace

- R1. 在 `generateVariants()` 开始前查询过去 24 小时的 LLM 成本，与 `DAILY_USD` 预算比较
- R2. 如果日成本已超 `DAILY_USD`，跳过生成，返回 429 + `Retry-After` 头
- R3. 如果日成本在 `DAILY_USD` 和 `2 × DAILY_USD` 之间，记录警告但继续（允许一次超支）
- R4. 在生成失败时自动降级模型：`gpt-4o → gpt-4o-mini → gemini-1.5-flash`
- R5. 降级后自动重试该变体，最多 2 次降级步骤
- R6. 如果日成本已超 `2 × DAILY_USD`，硬停止，拒绝所有新请求

## Scope Boundaries

- 不涉及月度预算检查（仅实现日度预算网关）
- 不涉及基于个别变体的预算分配（整体网关，不区分变体）
- 不涉及成本优化算法（缓存、压缩已有，此处仅关注限流）
- 不修改现有的 Gemini/OpenAI fallback 机制（独立于双提供者已有逻辑）

## Key Technical Decisions

- **预检查时机**：在 `generateVariants()` 内部，调用 `generateOne()` 前检查（最小化侵入，保证同步流程）
  - 理由：避免在 Promise.allSettled 内部进行异步检查，确保所有 7 个变体生成使用同一预算快照

- **预算快照边界**：以 UTC ISO 时间戳为基准，查询 `llm_calls WHERE created_at > NOW()-24h`
  - 理由：简单、可复现、不需要时区转换

- **模型降级级联**：硬编码顺序 `['gpt-4o', 'gpt-4o-mini', 'gemini-1.5-flash']`
  - 理由：成本递减（$10 → $0.60 → $0.30 per 1M tokens），可用性递增（OpenAI → OpenAI budget-tier → Gemini）
  - 不配置化，因为在 v1 成本优先度清晰，后续再考虑灵活性

- **降级触发**：仅在生成失败（LLM 调用异常）或明确成本超限时触发，不在 429 rate-limit 时盲目降级
  - 理由：保留 gpt-4o 质量优先级；rate-limit 的 429 已由 smartRetry 处理，降级会绕过该机制

- **重试步骤**：每次降级后最多 1 次重试（不反复重试同一模型）
  - 理由：防止无限重试环，给出清晰的失败信号

## Open Questions

### Resolved During Planning

- **Q: 预检查如何考虑正在进行的变体生成？**
  - A: 不考虑。预检查基于历史成本快照，新的生成成本在执行后才写入。这是可接受的，因为：
    1. 生成成本相对较小（单变体通常 $0.02-0.10）
    2. 预算缓冲设计为允许 1 次小额超支（1-2× threshold）
    3. 精确预测需要复杂的模型定价估算，投入产出不符

- **Q: 模型降级时，是否需要修改 variant 的其他字段（如 persona、topic）？**
  - A: 不需要。降级仅影响 LLM 模型选择，变体内容生成参数保持不变。模型降级是成本约束下的透明重试，不改变业务逻辑。

### Deferred to Implementation

- 确认 `llm_calls.spendBetween()` 或类似查询函数是否存在；如果不存在，需在 `llmCalls` repository 中添加

## Context & Research

### Relevant Code and Patterns

- **LLM 成本计算** — `/src/constants.ts` (line 82–119)：`MODEL_PRICING` 价表、`computeLlmCost()` 函数、`LLM_BUDGET` 常数
- **变体生成入口** — `/src/services/variant-generator.ts` (line ~30–45)：`generateVariants()` 函数，7 平台并行调用
- **LLM 路由** — `/src/llm/agent-llm.ts` (line 11–37)：`invokeLLMWithTools()` 多模型路由，已有 Gemini → OpenAI fallback
- **重试机制** — `/src/utils/smartRetry.ts`：错误分类和重试策略，已有 429 处理（`__skipRetry` marker）
- **数据库操作** — `/src/db/repositories/index.ts`：`llmCalls.record()` 插入、假定有 `spendBetween()` 查询
- **并发控制** — `/src/constants.ts` (line 30–35)：`LLM_FAN_OUT=3` 已存在

### Institutional Learnings

- **Gemini 429 配额耗尽快速失败** — `/src/llm/agent-llm.ts` (line 101–104)：已实现 `__skipRetry` marker，避免配额耗尽时的重试风暴
  - 建议：模型降级重试时检查该 marker，如果触发则跳过降级，直接失败

- **双提供者 Fallback** — 已实现 Gemini → OpenAI 自动 fallback
  - 建议：降级逻辑与现有 fallback 分开控制，避免双重降级导致混乱

## High-Level Technical Design

```
请求: POST /api/v2/dispatch { draft, platforms, ... }
       │
       ▼
generateVariants(input, db)
       │
       ├─ [NEW] checkBudgetStatus(db)
       │   ├─ Query: SELECT SUM(cost_usd) FROM llm_calls 
       │   │         WHERE created_at > NOW()-24h
       │   └─ Return: { status: 'ok'|'warn'|'critical'|'stop', 
       │               spent: $X, limit: $Y, ratio: X/Y }
       │
       ├─ If status='stop': return 429 + Retry-After
       ├─ If status='critical': log warn but continue
       │
       ▼
       Promise.allSettled([
         generateOne(platform0, 'gpt-4o-mini'),   # Slot 0-5
         generateOne(platform1, 'gpt-4o-mini'),
         ...
         generateOne(platform6, 'gpt-4o-mini'),   # Slot 6: tier-2 (if applicable)
       ])
           │
           ├─ On failure: [NEW] tryModelDowngrade()
           │  ├─ Get nextModel from cascade ['gpt-4o', 'gpt-4o-mini', 'gemini-1.5-flash']
           │  ├─ Retry once with nextModel
           │  └─ If still fails: mark variant as failed
           │
           └─ On success: [EXISTING] llmCalls.record() + insertVariant()

[NEW] llmCalls.record() 后
       │
       └─ [NEW] checkPostRecordThreshold()
           ├─ If daily cost now > 2×DAILY_USD: 
           │  set flag for next request to reject (或记录到 db)
           └─ Log metrics
```

## Implementation Units

- [x] **Unit 1: 预算网关和状态检查**

**Goal:** 在 `generateVariants()` 前实现预检查函数，返回预算状态和指标。

**Requirements:** R1, R2, R3, R6

**Dependencies:** None (depends on existing `llm_calls` table and `spendBetween()` query)

**Files:**
- Create: `src/utils/budget-gate.ts`
- Modify: `src/db/repositories/index.ts` (add `spendBetween()` if missing)
- Test: `src/utils/__tests__/budget-gate.test.ts`

**Approach:**
- 创建 `checkBudgetStatus(db: Database)` 函数
- 查询过去 24 小时的成本总和（使用 `llmCalls.spendBetween(db, ISO_24h_ago, now)`）
- 比较与 `DAILY_USD` 预算，返回状态对象 `{ status, spent, limit, ratio }`
- 状态枚举：
  - `ok`: spent < DAILY_USD
  - `warn`: DAILY_USD ≤ spent < 2×DAILY_USD
  - `critical`: spent ≥ 2×DAILY_USD
- 记录日志（logger.info / logger.warn 带成本指标）

**Patterns to follow:**
- 参考 `src/utils/smartRetry.ts` 的错误分类模式
- 参考 `src/constants.ts` 中 `DAILY_USD` 的环变量覆盖机制

**Test scenarios:**
- Happy path: 成本在预算内，返回 `status='ok'`
- Warn path: 成本 1.5× 预算，返回 `status='warn'`
- Critical path: 成本 > 2× 预算，返回 `status='critical'`
- Edge case: llm_calls 表为空（新项目冷启动），返回 spent=0, status='ok'
- Edge case: 精确在 DAILY_USD 边界，返回 status='warn'（阈值取 `<=`）

**Verification:**
- 单元测试覆盖所有状态转移
- 集成测试验证 llm_calls 表查询结果与函数返回一致

---

- [x] **Unit 2: generateVariants 中集成预检查网关**

**Goal:** 在生成前插入预检查，根据预算状态决定是否继续。

**Requirements:** R1, R2, R3, R6

**Dependencies:** Unit 1

**Files:**
- Modify: `src/services/variant-generator.ts` (generateVariants 函数)
- Test: `src/services/variant-generator.ts` (补充或新增测试)

**Approach:**
- 在 `generateVariants()` 函数开头（参数验证之后），调用 `checkBudgetStatus(db)`
- 根据返回状态：
  - `stop`: 抛出 HTTP 429 异常（由 handler 捕获返回给客户端）
  - `critical`: logger.warn，继续（但标记 batch 为 `budget_warn`）
  - `warn` 或 `ok`: 继续正常流程
- 确保检查在 Promise.allSettled 之前（所有 7 变体共享同一预算快照）

**Patterns to follow:**
- 参考现有的 `llmCalls.record()` 调用，确保同样的 db 连接和事务处理
- 参考 v2-dispatch 中的错误处理和 HTTP 响应模式

**Test scenarios:**
- Happy path: 预算充足，正常生成 7 个变体
- Critical path: 预算已用尽，返回 429 响应
- Warn path: 预算接近上限，log 警告但继续生成
- Concurrent scenario: 同时有 2 个请求，共享同一预算快照（测试竞态）
- Edge case: 预检查通过但生成过程中成本累计超限（post-check 在 Unit 5 处理）

**Verification:**
- 预检查在 Promise.allSettled 前执行
- HTTP 429 响应包含 Retry-After 头（通常设为 300 秒）
- 日志记录预算状态信息

---

- [x] **Unit 3: 模型降级策略和重试**

**Goal:** 实现模型降级级联和自动重试逻辑。

**Requirements:** R4, R5

**Dependencies:** None (独立组件)

**Files:**
- Create: `src/services/model-downgrade-strategy.ts`
- Test: `src/services/__tests__/model-downgrade-strategy.test.ts`

**Approach:**
- 创建 `ModelDowngradeStrategy` 类或函数集合
  - `cascade = ['gpt-4o', 'gpt-4o-mini', 'gemini-1.5-flash']`（hard-coded for v1）
  - `getNextModel(currentModel: string): string | null` — 返回级联中的下一个模型，或 null 如果已是最后一个
  - `canDowngrade(currentModel: string): boolean` — 判断是否还有可降级的目标
- 创建 `tryDowngradeAndRetry(originalOptions, error)` 函数
  - 取得当前模型，获取下一个模型
  - 如果有下一个模型，修改 options.model，重新调用 `generateOne()` 或 `generateSingleVariant()`
  - 如果无下一个模型，返回原始错误

**Patterns to follow:**
- 参考 `src/llm/agent-llm.ts` 中的 Gemini → OpenAI fallback 实现（位置：line 23–31）
- 参考 `smartRetry.ts` 中的错误重试模式

**Test scenarios:**
- Happy path: 从 gpt-4o 降级到 gpt-4o-mini，重试成功
- Cascade path: 从 gpt-4o-mini 降级到 gemini-1.5-flash，重试成功
- End-of-cascade: 已是 gemini-1.5-flash，无法降级，返回 error
- Edge case: 输入不在已知模型列表，返回 null（保持不变）
- Edge case: 降级后仍失败，返回失败（不再降级）

**Verification:**
- 级联顺序正确（按成本递减）
- 降级后立即重试，不进入 smartRetry 的延迟退避（降级是主动策略，重试应快速）
- 多次降级不会导致无限循环（最多 2 步）

---

- [x] **Unit 4: invokeLLMWithTools 中集成模型降级重试**

**Goal:** 在 LLM 调用失败时自动触发模型降级重试。

**Requirements:** R4, R5

**Dependencies:** Unit 3

**Files:**
- Modify: `src/llm/agent-llm.ts` (invokeLLMWithTools 函数)
- Test: `src/llm/__tests__/agent-llm.test.ts` (补充模型降级测试)

**Approach:**
- 在 `invokeLLMWithTools()` 的外层包装降级逻辑（不修改内部调用）
- 捕获调用失败（catch block），判断是否应该降级：
  - 如果错误是 429（rate-limit），且有 `__skipRetry` marker，**不**降级（这是配额耗尽，降级也没用）
  - 否则，尝试降级
- 降级时调用 `tryDowngradeAndRetry(options, error)` 
- 如果降级重试成功，返回新结果；否则返回或重新抛出原始错误
- 确保降级重试不再进入 smartRetry 的延迟循环（直接调用底层 API，或传递 skip-retry 标记）

**Patterns to follow:**
- 参考 `src/llm/agent-llm.ts` 现有的 try-catch 和 Gemini fallback 模式
- 参考 `smartRetry` 中的 `__skipRetry` marker 机制

**Test scenarios:**
- Happy path: OpenAI gpt-4o 失败，降级到 gpt-4o-mini，重试成功
- Gemini 失败: Gemini 某个 API 错误，降级到 OpenAI（跨提供者降级）
- Rate-limit (429 + __skipRetry): 收到配额耗尽，不尝试降级，直接失败
- Other 429 (无 __skipRetry): 普通限流，尝试降级
- End-of-cascade: 降级到 gemini-1.5-flash 仍失败，返回错误
- Edge case: 降级后的模型仍抛出相同错误，不再重试

**Verification:**
- 降级后仅重试 1 次（不反复）
- 配额耗尽 (429 + __skipRetry) 时不降级
- 成功降级和重试的情况被记录（logger.info）

---

- [x] **Unit 5: 记录后预算阈值检查**

**Goal:** 在成本记录后检查是否触发硬停止条件，为后续请求做准备。

**Requirements:** R6

**Dependencies:** Unit 1

**Files:**
- Modify: `src/db/repositories/index.ts` (llmCalls.record 函数或后续调用者)
- Optionally Create: `src/utils/budget-gate.ts` (补充 checkPostRecordThreshold 函数)
- Test: `src/utils/__tests__/budget-gate.test.ts` (补充测试)

**Approach:**
- 在每次 `llmCalls.record()` 之后（通常在 `src/services/variant-generator.ts` 中调用）
- 调用 `checkPostRecordThreshold(db)` 或 `checkBudgetStatus(db)` 的变体
- 如果累积日成本已超 `2 × DAILY_USD`，设置一个标记（可选：插入到 config 表或环变量，或仅记录到日志）
- 后续 generateVariants 请求会在 Unit 2 的预检查中观察到这个状态，返回 429

**Patterns to follow:**
- 与 Unit 1 中的 checkBudgetStatus 逻辑相同或共用

**Test scenarios:**
- Happy path: 记录后成本仍在预算内，无特殊处理
- Threshold-crossed: 记录后成本跨越 2× 预算线，下一个请求应被阻止
- Concurrent: 两个成本记录同时发生，最终正确反映预算状态

**Verification:**
- 硬停止条件（2× 预算）在后续请求中生效
- 日志记录临界事件（logger.warn "Daily LLM budget exceeded: $X > $Y"）

---

## System-Wide Impact

- **Request lifecycle impact:** 新增预检查延迟（1 个 DB 查询，通常 <100ms），对整体 /api/v2/dispatch 延迟影响 <1%
- **Error propagation:** 429 返回会被客户端（SPA/CLI）解释为暂时限流，应自动重试（与 HTTP 规范一致）
- **Backwards compatibility:** 无 API 签名变化，只添加了提前返回的情况
- **Observability:** 需要在 logger 中记录预算警告和临界事件，便于运维监控

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| 模型降级导致变体质量下降 | 接受（降级是成本约束的必然权衡）；建议后续添加质量指标追踪 |
| 预检查与并发生成竞态 | 接受（预算快照只是参考值，允许 1 次小额超支） |
| 降级重试消耗额外 tokens | 接受（最多 1 次重试，降级目标更便宜，总体仍节省成本） |
| 429 响应可能被滥用重试 | 低风险（429 是标准 rate-limit 信号，客户端应遵守 Retry-After） |

## Documentation / Operational Notes

- 更新 `AGENTS.md` 或内部文档，说明 LLM 成本网关的工作原理和阈值
- 推荐在 Sheets 或仪表板中添加日成本追踪图表（已有 llm_calls 表，可直接聚合）
- 运维需监控 logger 中 "budget_warn" 和 "budget_critical" 事件，可考虑 Slack 告警集成

## Sources & References

- Origin ideation: `/docs/ideation/2026-05-07-open-ideation.md` (Idea #2)
- Related code: 
  - `/src/constants.ts` — MODEL_PRICING, LLM_BUDGET constants
  - `/src/services/variant-generator.ts` — generateVariants entry point
  - `/src/llm/agent-llm.ts` — LLM routing and fallback logic
  - `/src/utils/smartRetry.ts` — error classification and retry strategy
  - `/src/db/repositories/index.ts` — llmCalls repository operations

