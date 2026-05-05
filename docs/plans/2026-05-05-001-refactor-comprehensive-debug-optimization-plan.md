---
title: refactor: 全面 Debug 优化体系建设
type: refactor
status: active
date: 2026-05-05
origin: docs/brainstorms/2026-05-05-comprehensive-debug-optimization-requirements.md
---

# 全面 Debug 优化体系建设实施计划

## Overview

当前项目的四大痛点（Bug 定位缓慢、测试覆盖不完整、模块交互复杂、本地开发成本高）都源于**架构边界不清**。本计划分 4 个阶段系统性地解决这些问题，从模块治理为基础，配套升级日志、测试、开发工具体系，预期 2-3 周完成，使 Bug 定位时间从 2 小时降至 30 分钟。

## Problem Frame

项目现有：
- **13 个核心模块**（adapters, services, routes, agent, db, llm, utils 等）已清晰分界，无循环依赖
- **简陋的日志系统**（仅 console.log 包装，无时间戳、模块追踪、持久化）
- **不均的测试覆盖**（db 层 85%，services 层 40%，adapters 层 0%，routes 层 5%）
- **缺乏本地开发工具**（无 debug 配置、无启动检查、无开发文档）

这导致：
1. Bug 报告时需要大量手工打日志重现，耗时 2+ 小时
2. 新功能常伤害既有模块，风险高
3. 开发人员本地启动困难，开发效率低

## Requirements Trace

- **R1-R4** — 模块治理：梳理职责清单、依赖关系、通信边界、单向依赖原则
- **R5-R8** — 日志升级：结构化日志（winston）、文件持久化、关键路径埋点、context_id 追踪
- **R9-R12** — 测试覆盖规划：单元测试 80/70/90% 目标、集成测试框架、模块通信测试、回归清单
- **R13-R15** — 开发工具链：启动脚本优化、调试工具、开发者文档

## Scope Boundaries

**不在本范围内：**
- 模块重构或架构大改（仅梳理现状、不调整职责）
- 完整的容器化或微服务拆分
- 性能优化或端到端测试
- UI 级别或 E2E 自动化测试

## Context & Research

### Relevant Code and Patterns

**模块结构（13 个核心模块）：**
- `/src/routes/` — Express 路由层（5 个子路由：publish, admin, config, history, _helpers）
- `/src/services/` — 业务逻辑（publish-service, variant-generator, anchor-generator, browser-session, queue 调度器）
- `/src/adapters/` — 平台适配器（7 个平台：blogger, devto, github, hashnode, medium, telegraph, wordpress）
- `/src/db/` — 数据库层（SQLite 单例 + 8 张表 + repositories 6 个命名空间）
- `/src/llm/` — LLM 客户端（OpenAI/Gemini 单例）
- `/src/utils/` — 工具库（logger, browserManager, smartRetry, parallel, authManager 等 10 个）
- `/src/agent/`, `/src/sheets/`, `/src/scraper/`, `/src/cache/`, `/src/types/`, `/src/prompts/`, `/src/middleware/`

**现有 Logger 实现** (`/src/utils/logger.ts`)：
```typescript
export const logger = {
  info: (msg: string) => console.log(`[INFO] ${msg}`),
  warn: (msg: string) => console.warn(`[WARN] ${msg}`),
  error: (msg: string, err?: any) => { console.error(`[ERROR] ${msg}`); if (err) console.error(err); },
  success: (msg: string) => console.log(`[SUCCESS] ${msg}`)
};
```
问题：无结构化日志、无时间戳、无模块追踪、无 context_id、无持久化。

**现有测试框架** (`vitest.config.ts`)：
- vitest 3.2.0 配置完整，已有 21 个测试文件覆盖 66 个源文件的 31.8%
- 数据库隔离测试模式成熟（`:memory:` SQLite + `applyV2Schema(db)`）
- Mock 模式已建立（vi.mock 覆盖 client, logger, systemMonitor 等）
- 缺乏：adapters 单测（0%）、routes 集成测试（5%）

**技术栈确认：**
- Node.js + TypeScript 6.0 + Express 5.2.1
- SQLite (better-sqlite3) + WAL 模式
- Vitest 3.2.0 + supertest（集成测试）
- Docker + docker-compose（无外部依赖）
- Winston 库**已在 package.json devDeps 中可用**

### Institutional Learnings

来自 `/src/utils/smartRetry.ts` 的错误分类模式（已有完整单测）：
- ErrorType 枚举：RATE_LIMIT, TIMEOUT, NETWORK, AUTH, SERVER_ERROR, NOT_FOUND, UNKNOWN
- classifyError() 函数可复用于日志错误分类

来自 `/src/db/__tests__/repositories.test.ts` 的数据库隔离模式：
```typescript
function freshDb(): Database { const db = new Database(':memory:'); applyV2Schema(db); return db; }
```
此模式可推广到所有涉及 DB 的测试。

来自 `/src/routes/_helpers.ts` 的路由错误包装：
```typescript
export function asyncRoute(fn: (req, res) => Promise<unknown>) {
  return async (req, res) => { try { await fn(req, res); } catch (error) { logger.error(`${req.method} ${req.path}`, error); ... } }
}
```

### External References

- **Winston 官方文档**：结构化日志框架，支持多个 transport（文件、控制台、网络等），支持日志级别、格式化、metadata
- **Vitest 文档**：测试隔离、mock、覆盖率，已在项目中使用
- **Database 隔离最佳实践**：内存数据库 + schema 应用是单测隔离的标准做法

## Key Technical Decisions

| 决策 | 方案 | 理由 |
|------|------|------|
| **日志库选型** | Winston（不是 pino）| 功能完整，支持 transport、metadata、日志级别，项目规模适配 |
| **日志文件位置** | `.data/logs/{YYYY-MM-DD}.log` | 与现有 `.data/syndicator.db` 存储位置一致，便于管理 |
| **Context 追踪** | context_id（UUID）贯穿整个调用链 | 使用 `cls-hooked` 或 `async_hooks` 自动注入，无需手工传递 |
| **依赖管理** | 明确模块间调用约定，暂不引入 DI 容器 | 项目规模（66 个源文件）不需 DI，约定优于框架 |
| **测试隔离** | `:memory:` SQLite + `freshDb()` 模式 | 现有代码已验证，快速、无污染 |
| **模块通信** | 保持现有直接调用，新增事件发射选项（future） | 当前调用链清晰，足以满足需求 |
| **本地开发** | docker-compose.dev.yml（带 volume mount 源码） | 与生产 docker-compose.yml 分离，便于开发 |

## Open Questions

### Resolved During Planning

- **Q1. 模块职责如何定义？** — 根据现有代码分析，每个模块已有清晰的单一职责（见 Context & Research）。计划中将明文化为 ARCHITECTURE.md
- **Q2. 是否存在循环依赖？** — 研究表明无（严格的单向依赖：utils → services → routes）
- **Q3. Winston 依赖是否已添加？** — 否，需在 package.json 中添加 winston 依赖
- **Q4. context_id 如何跨层传递？** — 使用 `cls-hooked` 库的 namespace.run() 在每个请求/作业启动时创建上下文

### Deferred to Implementation

- **Q5. 日志输出格式具体如何设计？** — 实施时确定（建议 JSON + 可读格式混合）
- **Q6. 哪些关键路径需要重点埋点？** — 实施时基于 flame graph 或日志观察确定
- **Q7. adapters 单测中是否需要真实网络调用？** — 否，使用 mock（HTTP stubbing 或 MSW）
- **Q8. 本地 docker-compose.dev.yml 是否需要外部服务？** — 根据配置验证结果确定（目前预期无需）

## High-Level Technical Design

> *本节阐述日志系统和测试框架的集成方式，是实施的方向指引，非代码规范。*

### 日志系统升级架构

```
所有模块 ──→ 新 logger.ts（Winston wrapper）
                ├─→ struct logger（context_id, module, level, message, metadata）
                ├─→ Console transport（开发环境，可读格式）
                ├─→ File transport（持久化，JSON 格式，按日期轮转）
                └─→ Error transport（仅 ERROR 级别，单独文件）

Context 追踪流程：
  requestId/jobId 生成
    ↓
  cls-hooked namespace.run() 创建隔离作用域
    ↓
  所有嵌套调用自动获取 context_id
    ↓
  日志输出时自动注入 context_id
    ↓
  使用 grep "context_id=abc123" logs/*.log 快速定位一个请求的全部日志
```

### 测试覆盖体系分阶段建设

```
Phase 1（现状）：
  - db 层：85% ✅
  - services 层：40% ⚠️
  - adapters 层：0% ❌
  - routes 层：5% ❌
  - utils 层：60% ⚠️

Phase 2（目标）：
  - db 层：85% → 90% （补充边界情况）
  - services 层：40% → 80% （补充 publish-service, browser-session）
  - adapters 层：0% → 70% （新增 7 个平台各 2 个关键路径）
  - routes 层：5% → 50% （新增 4 个 API 路由的集成测试）
  - utils 层：60% → 90% （补充 authManager, errorHandler, configValidator）

Phase 3（维护）：
  - 每个 PR 新增时保持覆盖率
  - 回归测试清单（voice syndicator, sheets, scheduler 各 3 个场景）
```

## Implementation Units

**依赖关系图：**
```
Unit 1 (ARCHITECTURE.md) 
  ↓
Unit 2 (module-graph.md) 
  ↓
Unit 3 (通信边界定义) 
  ↓
Unit 4 (单向依赖检查)
  ↓
Unit 5-9 (日志系统升级，并行可进行单元测试补充)
  ↓
Unit 10-14 (测试覆盖)
  ↓
Unit 15-18 (开发工具链)
```

---

### Unit 1: 模块职责清单梳理与文档化

**Goal:** 编写 `/src/ARCHITECTURE.md`，明确 13 个模块各自的单一职责，建立团队共识。

**Requirements:** R1

**Dependencies:** None

**Files:**
- Create: `src/ARCHITECTURE.md`

**Approach:**
1. 基于现有代码结构和导入关系，为每个模块编写职责描述
2. 格式：模块名、职责（1-2 句）、输入/输出类型、关键函数、外部依赖
3. 重点模块（routes, services, adapters, db, llm, utils）各占 50-100 字；其他模块 20-30 字
4. 包含当前测试覆盖率和已知债务（如 adapters 0% 测试）
5. 指明相邻模块间的调用方向（单向依赖）

**Patterns to follow:**
- `/src/utils/logger.ts` 的职责描述（"Logger 提供统一的日志接口"）
- 现有 README.md 中的模块介绍风格

**Test scenarios:**
- Happy path：新人能通过 ARCHITECTURE.md 快速理解模块拓扑
- Verification：ARCHITECTURE.md 与现有代码结构完全对应，无二义性

**Verification:**
- ARCHITECTURE.md 文档已生成，包含 13 个模块的完整描述
- 团队可根据文档快速定位功能所属模块

---

### Unit 2: 模块依赖关系图梳理

**Goal:** 生成 `/docs/module-graph.md`，用文本和/或 ASCII 图表表示 13 个模块的依赖关系，识别循环依赖和过多跨界依赖。

**Requirements:** R2

**Dependencies:** Unit 1

**Files:**
- Create: `docs/module-graph.md`

**Approach:**
1. 扫描 `/src/` 下所有 TypeScript 文件的 import 语句
2. 构建依赖图：模块A → 模块B 表示 A 导入 B
3. 检查循环依赖（预期：无）
4. 识别"红旗项"：单个模块有 5+ 个出向依赖（预期：services）
5. 生成 Mermaid 图表或 ASCII 箭头图表
6. 汇总成依赖矩阵表格（行为源模块，列为目标模块，✓ 表示有依赖）

**Patterns to follow:**
- 使用 Mermaid TB（top-to-bottom）格式，易于 diff 和阅读

**Test scenarios:**
- Happy path：无循环依赖，依赖方向清晰
- Edge case：services 的多个出向依赖是合理的（业务编排）
- Verification：自动化检查脚本可在 CI 中验证无循环依赖

**Verification:**
- module-graph.md 文档已生成，包含完整的依赖矩阵
- 通过人工检查确认无循环依赖和意外跨界依赖

---

### Unit 3: 模块间通信边界定义

**Goal:** 编写 `/src/COMMUNICATION_CONTRACTS.md`，定义模块间通信方式和数据流向约定，特别是 adapters ↔ services ↔ routes 的数据格式规范。

**Requirements:** R3

**Dependencies:** Unit 1, Unit 2

**Files:**
- Create: `src/COMMUNICATION_CONTRACTS.md`

**Approach:**
1. 分析现有的关键调用链（publish 流、generate 流、monitor 流）
2. 为每条链定义：入参类型、出参类型、错误处理约定、副作用（日志、持久化、外部调用）
3. 定义"标准返回值"结构：`{ ok: boolean, data?: T, error?: string }`（已在 parallel.ts 中使用）
4. 定义日志输出规范：每个 API 端点和 service 函数的日志点（入口、关键决策点、出口、错误）
5. 定义 mock 约定：adapters 在测试中应如何 mock（返回什么结构）

**Patterns to follow:**
- 使用 TypeScript interface 定义数据结构
- 参考 `/src/types/index.ts` 中的已有类型定义

**Test scenarios:**
- Happy path：新模块与既有模块通信无歧义
- Edge case：错误处理约定在 adapter 失败时能正确传递
- Verification：contracts 中的结构与代码中的实际实现一致

**Verification:**
- COMMUNICATION_CONTRACTS.md 文档已生成
- 包含 3+ 个主要调用链的完整数据流约定
- 能作为新人编写代码时的参考

---

### Unit 4: 单向依赖原则检查与建议

**Goal:** 建立单向依赖原则，确保 utils → services → routes 的依赖方向，提出违反原则的重构建议。

**Requirements:** R4

**Dependencies:** Unit 2

**Files:**
- Create: `scripts/check-circular-deps.ts`（脚本）
- Create: `docs/dependency-principles.md`（文档）

**Approach:**
1. 编写 TypeScript 脚本分析导入关系，检查：
   - 是否存在循环依赖
   - 是否存在"低层模块依赖高层模块"（如 utils 依赖 services）
   - 是否存在跨越多层的直接依赖（如 routes 直接依赖 db，应通过 services）
2. 生成报告：通过/失败、具体违反的依赖链
3. 在 `docs/dependency-principles.md` 中记录：
   - 依赖分层：utils（低）→ db, agent, llm（中低）→ services, cache, scraper（中）→ routes（高）
   - 允许的例外（如 services 依赖 db 是合理的）
4. 将脚本集成到 CI 流程（作为 pre-commit hook 或 CI 检查）

**Patterns to follow:**
- 参考 `scripts/preflight-check.ts` 的结构

**Test scenarios:**
- Happy path：脚本运行成功，无循环依赖告警
- Verification：手动审查一个模块的导入，确认脚本检查准确

**Verification:**
- check-circular-deps.ts 脚本可执行，报告清晰
- dependency-principles.md 文档已生成
- 可在本地运行 `tsx scripts/check-circular-deps.ts` 验证无问题

---

### Unit 5: Winston Logger 实现与集成

**Goal:** 实现新的结构化 logger 框架，基于 Winston，支持时间戳、模块追踪、日志级别、文件持久化。

**Requirements:** R5

**Dependencies:** Unit 1-4

**Files:**
- Modify: `src/utils/logger.ts`（完全重写，但保留现有 API 兼容性）
- Modify: `package.json`（添加 winston 和 cls-hooked 依赖）
- Create: `src/utils/logger-config.ts`（logger 配置工厂）
- Create: `src/utils/context.ts`（context_id 管理，使用 cls-hooked）

**Approach:**
1. 在 `logger-config.ts` 中创建 Winston 实例：
   ```typescript
   const logger = winston.createLogger({
     format: winston.format.combine(
       winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
       winston.format.errors({ stack: true }),
       winston.format.json()
     ),
     defaultMeta: { service: 'syndicator' },
     transports: [
       new winston.transports.Console({ format: winston.format.simple() }),
       new winston.transports.File({ filename: '.data/logs/error.log', level: 'error' }),
       new winston.transports.File({ filename: `.data/logs/${dateString}.log` })
     ]
   })
   ```
2. 在 `context.ts` 中集成 `cls-hooked` 管理 context_id：
   ```typescript
   const namespace = createNamespace('syndicator-context');
   export function createContext(contextId: string, fn: () => Promise<T>): Promise<T> {
     return namespace.run(() => { namespace.set('contextId', contextId); return fn(); });
   }
   export function getContextId(): string | undefined { return namespace.get('contextId'); }
   ```
3. 在新 logger.ts 中保持现有 API 兼容性（info, warn, error, success），但底层使用 Winston：
   ```typescript
   export const logger = {
     info: (msg: string, meta?: any) => winstonLogger.info(msg, { ...meta, contextId: getContextId() }),
     // ...
   };
   ```
4. 在 `.data/logs/` 目录中实现日志轮转（按日期分割）

**Execution note:** 这是关键单元，需要测试覆盖，确保现有的 35 个 logger 调用点无行为变化。

**Patterns to follow:**
- Winston 官方文档中的 logger 创建模式
- 参考 `src/db/index.ts` 的单例模式

**Test scenarios:**
- Happy path：新 logger 输出包含时间戳、level、message
- Integration：现有的 logger.info() 等调用正常工作，且输出包含 contextId（若有）
- Edge case：并发日志输出时 contextId 不混乱
- Verification：日志文件创建在 `.data/logs/{YYYY-MM-DD}.log`，内容为有效 JSON

**Verification:**
- logger.ts 已重写，通过 npm start 或 npm test 验证日志输出正确
- 至少 3 个现有 logger 调用点的行为保持一致

---

### Unit 6: 日志文件持久化与轮转配置

**Goal:** 配置 Winston 的 File transport，实现日志按日期分割、自动轮转、避免文件无限增长。

**Requirements:** R6

**Dependencies:** Unit 5

**Files:**
- Modify: `src/utils/logger-config.ts`（添加轮转配置）
- Create: `.data/logs/.gitkeep`（确保目录存在）

**Approach:**
1. 使用 winston-daily-rotate-file 库（或手工实现）按日期轮转：
   ```typescript
   new winston.transports.File({
     filename: path.join('.data/logs', '%DATE%.log'),
     datePattern: 'YYYY-MM-DD',
     maxSize: '20m',  // 单文件最大 20MB
     maxDays: '7d',   // 保留 7 天日志
   })
   ```
2. 实现不同级别日志的分离（error 单独文件，combined 文件包含全部）
3. 确保日志目录在应用启动时存在（在 index.ts 中调用 ensureLogs Dir()）
4. 配置开发环境（npm run dev）的日志级别为 DEBUG，生产为 INFO

**Patterns to follow:**
- Winston 官方的日志轮转配置

**Test scenarios:**
- Happy path：日志文件按日期创建，无错误
- Verification：手动检查 `.data/logs/` 目录中的文件名格式正确

**Verification:**
- `.data/logs/{YYYY-MM-DD}.log` 文件已创建
- 日志输出中包含时间戳、级别、message

---

### Unit 7: 关键路径埋点与日志覆盖

**Goal:** 在 adapters、services、routes 的入出口和关键业务逻辑点埋下日志，实现完整的请求跟踪。

**Requirements:** R7

**Dependencies:** Unit 5, Unit 6

**Files:**
- Modify: `src/routes/publish.ts`, `src/routes/admin.ts`, `src/routes/config.ts`, `src/routes/history.ts`
- Modify: `src/services/publish-service.ts`, `src/services/variant-generator.ts`, `src/services/anchor-generator.ts`, `src/services/browser-session.ts`
- Modify: `src/adapters/*.ts`（所有 7 个平台）
- Modify: `src/services/queue/*.ts`（scheduler, publish-worker, liveness-worker 等）

**Approach:**
1. 为每个 API 路由的入口和出口添加日志：
   ```typescript
   // routes/publish.ts
   export async function POST /api/v2/generate(req, res) {
     const contextId = req.headers['x-request-id'] || uuid();
     logger.info('publish.generate.start', { contextId, url: req.body.url });
     try {
       const result = await publishService.generate(...);
       logger.info('publish.generate.success', { contextId, variants: result.length });
     } catch (err) {
       logger.error('publish.generate.failed', { contextId, error: err.message });
       throw;
     }
   }
   ```
2. 在 service 层的关键决策点添加日志：
   ```typescript
   // services/variant-generator.ts
   logger.debug('variant-generator.invoking_llm', { contextId, platform, persona });
   const variants = await invokeLLMWithTools(...);
   logger.debug('variant-generator.llm_completed', { contextId, variantCount: variants.length });
   ```
3. 在 adapters 的发布结果添加日志：
   ```typescript
   // adapters/blogger.ts
   logger.info('blogger.publish', { contextId, postId, url: result.url });
   ```
4. 特别关注 voice syndicator、sheets 聚合、scheduler 等新增模块的日志覆盖

**Execution note:** 埋点时遵循 COMMUNICATION_CONTRACTS.md 中定义的日志规范。

**Patterns to follow:**
- 参考 `/src/services/queue/scheduler.ts` 中现有的日志调用
- 遵循格式：`logger.level('module.function.event', { contextId, ...context })`

**Test scenarios:**
- Integration：端到端请求（如 /api/v2/generate）的全部日志能通过 grep contextId 收集
- Verification：日志输出包含请求入口、关键处理步骤、结果/错误、完成

**Verification:**
- 至少 4 个主要 API 路由的日志埋点完成
- 至少 3 个 service 函数的关键路径日志完成
- 至少 2 个 adapter（如 blogger, medium）的发布日志完成

---

### Unit 8: Context 追踪实现与自动注入

**Goal:** 使用 cls-hooked 实现 context_id 在整个请求生命周期内的自动追踪，无需手工传递。

**Requirements:** R8

**Dependencies:** Unit 5

**Files:**
- Create: `src/utils/context.ts`（context 管理）
- Modify: `src/server.ts`（Express middleware 注入 context）
- Modify: `src/index.ts`（作业调度器启动时创建 context）

**Approach:**
1. 在 `context.ts` 中定义：
   ```typescript
   import { createNamespace } from 'cls-hooked';
   const contextNamespace = createNamespace('syndicator');
   
   export function createRequestContext(contextId: string) {
     contextNamespace.set('contextId', contextId);
   }
   
   export function getContextId(): string | undefined {
     return contextNamespace.get('contextId');
   }
   ```
2. 在 `server.ts` 的 Express middleware 中为每个请求创建 context：
   ```typescript
   app.use((req, res, next) => {
     const contextId = req.headers['x-request-id'] || uuid();
     contextNamespace.run(() => {
       createRequestContext(contextId);
       res.setHeader('x-request-id', contextId);
       next();
     });
   });
   ```
3. 在 `index.ts` 的作业调度器中为每个作业创建 context：
   ```typescript
   // scheduler.ts 中
   await contextNamespace.run(() => {
     createRequestContext(jobId);
     await publishWorker.execute(job);
   });
   ```
4. 修改 logger 在输出时自动获取当前 contextId 并注入

**Execution note:** cls-hooked 需要在 npm install 或已在 package.json 中；若无则需添加。

**Patterns to follow:**
- cls-hooked 官方文档中的 namespace 使用模式

**Test scenarios:**
- Happy path：单个请求的所有日志自动包含同一个 contextId
- Integration：并发请求时各自的 contextId 不混乱
- Verification：通过 grep logs/*.log -i contextId=<某个值> 能收集到一个完整的请求的所有日志

**Verification:**
- context.ts 已创建，middleware 已集成
- 一个完整的 API 请求的日志能通过 contextId 完整追踪
- 日志中 contextId 字段正确注入

---

### Unit 9: 日志系统集成测试与性能验证

**Goal:** 编写集成测试验证日志系统的正确性、性能和无副作用，确保升级不影响现有功能。

**Requirements:** R5-R8

**Dependencies:** Unit 5-8

**Files:**
- Create: `src/utils/__tests__/logger.integration.test.ts`
- Modify: `src/utils/__tests__/logger.test.ts`（若已存在，补充新测试）

**Approach:**
1. 编写单元测试验证日志格式：
   ```typescript
   test('logger outputs with timestamp, level, message', () => {
     logger.info('test message', { key: 'value' });
     // 检查日志文件中包含 ISO 时间戳、'INFO'、'test message'、'key=value'
   });
   ```
2. 编写集成测试验证 context_id 追踪：
   ```typescript
   test('context_id is automatically injected', async () => {
     await contextNamespace.run(() => {
       createRequestContext('test-123');
       logger.info('msg1');
       logger.info('msg2');
       // 检查两条日志都包含 contextId=test-123
     });
   });
   ```
3. 性能测试：验证日志写入不成为瓶颈（<1ms per log call）
4. 无副作用测试：现有的 logger.info/warn/error/success 调用的行为保持一致

**Patterns to follow:**
- 参考 `/src/db/__tests__/repositories.test.ts` 的测试风格

**Test scenarios:**
- Happy path：日志格式、内容、contextId 都正确
- Integration：多个并发日志操作时无竞态条件
- Performance：单条日志写入 <1ms
- Backward compat：现有代码中的 logger 调用无需修改

**Verification:**
- 集成测试通过：`npm run test src/utils/__tests__/logger.integration.test.ts`
- 覆盖率 >90%
- 没有任何现有的 logger 调用报错

---

### Unit 10: Adapters 单元测试补充（7 个平台）

**Goal:** 为 7 个 adapters（blogger, devto, github, hashnode, medium, telegraph, wordpress）各编写 2-3 个单元测试，覆盖关键发布路径。

**Requirements:** R9, R10

**Dependencies:** Unit 1-9

**Files:**
- Create: `src/adapters/__tests__/blogger.test.ts`
- Create: `src/adapters/__tests__/devto.test.ts`
- Create: `src/adapters/__tests__/github.test.ts`
- Create: `src/adapters/__tests__/hashnode.test.ts`
- Create: `src/adapters/__tests__/medium.test.ts`
- Create: `src/adapters/__tests__/telegraph.test.ts`
- Create: `src/adapters/__tests__/wordpress.test.ts`

**Approach:**
1. 为每个 adapter 编写 3 个测试场景：
   - **Happy path**：正常发布，返回有效的 publishedUrl
   - **Error path**：网络错误、认证错误、平台错误时的处理
   - **Edge case**：特殊字符、长内容、边界值
2. 使用 mock：
   - Mock 浏览器自动化（没有真实网络调用）
   - Mock HTTP 请求（使用 MSW 或 nock）
   - Mock 平台 API 响应
3. 测试覆盖率目标：每个 adapter 的 publish() 方法 >70%

**Patterns to follow:**
- 参考 `/src/services/__tests__/variant-generator.test.ts` 的 mock 模式
- 使用 `vi.mock()` mock 浏览器和网络

**Test scenarios:**
- Happy path：adapter 正常发布，返回 { ok: true, publishedUrl }
- Error handling：adapter 捕获网络错误、平台错误，返回 { ok: false, error }
- Edge cases：特殊字符、长文本、超时等

**Verification:**
- 7 个 adapter 各至少有 2 个测试通过
- 测试覆盖率 >70%
- `npm run test:coverage src/adapters/__tests__/` 显示覆盖率提升

---

### Unit 11: Services 单元测试补充（重点模块）

**Goal:** 补充 services 层的单元测试，重点是 publish-service.ts 和 browser-session.ts，提升 services 层的覆盖率从 40% 到 80%。

**Requirements:** R9, R10

**Dependencies:** Unit 1-9

**Files:**
- Create/Modify: `src/services/__tests__/publish-service.test.ts`
- Create/Modify: `src/services/__tests__/browser-session.test.ts`
- Modify: 其他 services 的 test 文件以补充边界情况

**Approach:**
1. 为 publish-service.ts 编写测试覆盖：
   - 不同 variant 的质量评分和平台选择逻辑
   - 多平台并发发布的错误处理
   - Sheets 同步的成功/失败情况
2. 为 browser-session.ts 编写测试覆盖：
   - 浏览器启动/关闭的生命周期
   - 并发任务的隔离（每个任务独立的浏览器实例）
   - 超时处理和清理
3. 使用 freshDb() 模式隔离数据库测试
4. Mock 浏览器和外部 API

**Patterns to follow:**
- 参考 `/src/db/__tests__/repositories.test.ts` 的 :memory: database 隔离模式
- 参考 `/src/services/queue/__tests__/scheduler.test.ts` 的 mock 模式

**Test scenarios:**
- publish-service：多variant场景、全部platform成功、部分platform失败、所有platform失败
- browser-session：启动成功、启动失败、并发任务、超时恢复

**Verification:**
- `npm run test src/services/__tests__/publish-service.test.ts` 通过
- `npm run test src/services/__tests__/browser-session.test.ts` 通过
- services 层覆盖率达到 80%+

---

### Unit 12: Routes 集成测试（API 端点）

**Goal:** 使用 supertest 为 4 个主要 API 路由编写集成测试：POST /api/v2/generate, /api/v2/dispatch, /api/v2/admin, GET /api/v2/history。

**Requirements:** R10

**Dependencies:** Unit 1-11

**Files:**
- Create: `src/routes/__tests__/publish.test.ts`
- Create: `src/routes/__tests__/admin.test.ts`
- Create: `src/routes/__tests__/config.test.ts`
- Create: `src/routes/__tests__/history.test.ts`

**Approach:**
1. 为每个路由编写 happy path 和 error path 测试：
   ```typescript
   import request from 'supertest';
   import { app } from '../server';
   
   test('POST /api/v2/generate returns 200 with variants', async () => {
     const res = await request(app)
       .post('/api/v2/generate')
       .send({ url: 'https://example.com', title: 'Test' })
       .expect(200);
     expect(res.body.variants).toBeDefined();
   });
   ```
2. 测试验证请求参数验证（缺少必要字段时返回 400）
3. 测试验证错误处理（发布失败时返回 500 + 错误信息）
4. 使用 freshDb() 隔离数据库状态
5. Mock 外部服务（LLM、adapters、Google Sheets 等）

**Patterns to follow:**
- 参考 `/src/__tests__/server.health.test.ts` 的 supertest 使用
- 参考 `/src/routes/_helpers.ts` 的 asyncRoute 错误处理

**Test scenarios:**
- Happy path：请求参数正确，返回预期响应
- Validation：请求缺少必要字段，返回 400 + 详细错误信息
- Error path：下游服务失败，返回 500 + 错误信息
- Integration：完整的 request → service → db → response 流程

**Verification:**
- 4 个主要路由各至少有 3 个测试通过
- `npm run test src/routes/__tests__/` 覆盖率 >50%

---

### Unit 13: Utils 单元测试补充

**Goal:** 补充 utils 层缺失的测试：authManager.ts, errorHandler.ts, configValidator.ts, autoCleanup.ts。

**Requirements:** R9

**Dependencies:** Unit 1-9

**Files:**
- Create: `src/utils/__tests__/authManager.test.ts`
- Create: `src/utils/__tests__/errorHandler.test.ts`
- Create: `src/utils/__tests__/configValidator.test.ts`
- Create: `src/utils/__tests__/autoCleanup.test.ts`

**Approach:**
1. 为每个工具函数编写单元测试，涵盖 happy path 和 error path
2. 特别关注：
   - authManager：token 生成、验证、过期处理
   - errorHandler：不同错误类型的分类和处理
   - configValidator：必要配置项的验证
   - autoCleanup：过期数据的清理逻辑
3. 目标：utils 层覆盖率 >90%

**Patterns to follow:**
- 参考 `/src/utils/__tests__/smartRetry.test.ts` 和 `/src/utils/__tests__/parallel.test.ts`

**Test scenarios:**
- authManager：正常认证、过期令牌、无效令牌
- errorHandler：网络错误、认证错误、服务器错误
- configValidator：有效配置、缺失配置、无效配置
- autoCleanup：清理过期数据、保留有效数据

**Verification:**
- 4 个模块各至少 2 个测试通过
- utils 层覆盖率 >90%

---

### Unit 14: 回归测试清单建立与自动化

**Goal:** 为近期新增的 voice syndicator、sheets 聚合、scheduler 模块各建立 3 个关键场景的回归测试，作为 CI 流程的一部分。

**Requirements:** R12

**Dependencies:** Unit 1-13

**Files:**
- Create: `src/services/queue/__tests__/scheduler.regression.test.ts`
- Create: `src/sheets/__tests__/sheets.regression.test.ts`
- Create: `src/agent/__tests__/agent.regression.test.ts`（如 voice syndicator 属于 agent）
- Modify: `.github/workflows/ci.yml`（若使用 GitHub Actions）或 CI 配置文件

**Approach:**
1. 为 scheduler 建立回归测试：
   - 正常作业调度和执行
   - 作业失败和重试
   - 僵尸作业清理
2. 为 sheets 建立回归测试：
   - 数据同步成功
   - 同步失败时的降级处理
   - 令牌刷新和速率限制
3. 为 voice syndicator 建立回归测试（如适用）
4. 在 CI 中添加一个 `regression-test` 步骤，在每次提交时运行

**Patterns to follow:**
- 参考 `/src/services/queue/__tests__/scheduler.test.ts` 的现有测试结构

**Test scenarios:**
- 每个新增模块的 3-5 个关键场景（发布流、同步流、错误恢复流）

**Verification:**
- 回归测试通过：`npm run test -- scheduler.regression.test.ts sheets.regression.test.ts agent.regression.test.ts`
- CI 流程中自动运行回归测试

---

### Unit 15: Docker Compose Dev 配置与本地启动脚本

**Goal:** 创建 `docker-compose.dev.yml` 便于本地开发，以及优化本地启动脚本 `start.sh`，使新人能 5 分钟内启动项目。

**Requirements:** R13

**Dependencies:** Unit 1-14

**Files:**
- Create: `docker-compose.dev.yml`
- Modify: `start.sh` 或创建 `start-dev.sh`
- Create: `.dev.env.example`
- Modify: `.gitignore`（添加 `.dev.env` 和 `.data/logs/`）

**Approach:**
1. 创建 docker-compose.dev.yml：
   ```yaml
   version: '3.8'
   services:
     syndicator-dev:
       build: .
       ports: ["3000:3000"]
       volumes:
         - .:/app  # 挂载源代码，支持热重载
         - /app/node_modules  # 排除 node_modules
       environment:
         - NODE_ENV=development
         - BROWSER_HEADLESS=false  # 开发模式显示浏览器窗口
       depends_on: []  # 无外部依赖
   ```
2. 创建 start-dev.sh：
   ```bash
   #!/bin/bash
   # 检查依赖：Node.js, Docker, npm
   npm install
   npm run preflight  # 运行启动检查
   docker-compose -f docker-compose.dev.yml up
   ```
3. 创建 .dev.env.example，包含本地开发所需的环境变量模板
4. 更新 .gitignore，忽略 .dev.env 和日志目录

**Execution note:** 确保 npm start 和 docker-compose.dev.yml 一致。

**Patterns to follow:**
- 参考现有 `docker-compose.yml` 和 `start.sh`

**Test scenarios:**
- Happy path：新人按 README 的步骤运行，5 分钟内项目启动成功

**Verification:**
- docker-compose.dev.yml 可执行：`docker-compose -f docker-compose.dev.yml up`
- 项目成功启动，health check 通过：`curl http://localhost:3000/health`

---

### Unit 16: VSCode Debug 配置与断点调试

**Goal:** 创建 `.vscode/launch.json`，支持在 VSCode 中直接断点调试，无需额外启动命令。

**Requirements:** R14

**Dependencies:** Unit 1-9

**Files:**
- Create: `.vscode/launch.json`
- Create: `.vscode/tasks.json`（可选，定义 build task）

**Approach:**
1. 创建 launch.json 支持两种调试模式：
   ```json
   {
     "version": "0.2.0",
     "configurations": [
       {
         "name": "Debug with tsx",
         "type": "node",
         "request": "launch",
         "program": "${workspaceFolder}/src/index.ts",
         "preLaunchTask": "tsc: build",
         "skipFiles": ["<node_internals>/**"],
         "outFiles": ["${workspaceFolder}/dist/**/*.js"],
         "console": "integratedTerminal"
       },
       {
         "name": "Debug Tests",
         "type": "node",
         "request": "launch",
         "program": "${workspaceFolder}/node_modules/vitest/vitest.mjs",
         "args": ["run", "${file}"],
         "skipFiles": ["<node_internals>/**"],
         "console": "integratedTerminal"
       }
     ]
   }
   ```
2. 创建 tasks.json 支持 TypeScript 编译
3. 在 README 中说明调试步骤：设置断点 → 按 F5 启动调试器

**Patterns to follow:**
- VSCode 官方调试配置文档

**Test scenarios:**
- Happy path：在 src/services/publish-service.ts 设置断点，启动调试器，程序在断点处暂停

**Verification:**
- .vscode/launch.json 文件存在且格式正确
- VSCode 中按 F5 能启动调试器

---

### Unit 17: 开发者文档编写（DEVELOPMENT.md）

**Goal:** 编写 `/DEVELOPMENT.md`，为新人提供快速上手指南，涵盖模块地图、API 调用约定、常见调试场景的排查步骤。

**Requirements:** R15

**Dependencies:** Unit 1-16

**Files:**
- Create: `DEVELOPMENT.md`

**Approach:**
1. **快速启动** — 分 3 个步骤：
   ```
   1. npm install
   2. npm run start-dev （或 docker-compose -f docker-compose.dev.yml up）
   3. 访问 http://localhost:3000/health
   ```
2. **模块地图** — 引用 ARCHITECTURE.md 和 module-graph.md，附加关键函数链接
3. **常见任务** — 如何：
   - 添加新的 API 端点
   - 支持新的发布平台（adapter）
   - 调试一个 API 请求的完整流程
4. **调试场景** — 3-5 个例子：
   - "如何查找一个发布失败的原因"：通过 grep logs/*.log -i contextId=<id> 查看完整日志
   - "如何测试新 adapter"：编写单元测试，mock 浏览器和网络
   - "如何跟踪一个请求从 routes → services → adapters → db"：阅读日志中的关键路径
5. **常见错误** — FAQ：
   - "项目启动失败" — 检查依赖项、.env 配置、数据库初始化
   - "测试失败" — 检查数据库隔离、mock 配置

**Patterns to follow:**
- 参考现有 README.md 的风格和结构

**Test scenarios:**
- Happy path：新人按照 DEVELOPMENT.md 的步骤，能完成常见任务

**Verification:**
- DEVELOPMENT.md 文件存在，包含快速启动、模块地图、常见任务、调试场景等章节

---

### Unit 18: 启动检查脚本与 CI 集成

**Goal:** 增强现有 `scripts/preflight-check.ts`，或创建新的启动检查脚本，在开发和 CI 中验证环境、依赖、配置完整性。

**Requirements:** R13, R15

**Dependencies:** Unit 1-17

**Files:**
- Modify: `scripts/preflight-check.ts`（或创建新脚本）
- Modify: `package.json`（添加 `npm run preflight` 命令）
- Modify: `.github/workflows/ci.yml`（若使用 GitHub Actions）

**Approach:**
1. 检查项：
   - Node.js 版本 ≥ 18
   - npm/yarn 已安装
   - 必要的环境变量（OPENAI_API_KEY, GEMINI_API_KEY 等）已配置
   - SQLite 数据库可初始化
   - 日志目录 `.data/logs/` 可创建
   - Docker 已安装（如需）
2. 输出清晰的报告，红旗项标记为 ❌，绿旗项标记为 ✅
3. 在启动脚本中自动运行：`npm run preflight && npm start`
4. 在 CI 中添加 preflight 检查步骤

**Patterns to follow:**
- 参考现有 `scripts/preflight-check.ts` 的结构（如已存在）

**Test scenarios:**
- Happy path：环境完整，preflight 返回全绿
- Failure path：缺少某个环境变量或依赖，preflight 清晰指出问题和解决方案

**Verification:**
- `npm run preflight` 执行成功，输出包含环境检查结果
- CI 中 preflight 步骤通过

---

## System-Wide Impact

- **Interaction graph：** 日志升级后，所有 35 个导入 logger 的模块输出格式变化，但 API 兼容；结构化日志使跨模块追踪变为可能
- **Error propagation：** 错误处理不变，但日志捕获更详细，便于问题诊断
- **State lifecycle risks：** 日志文件的轮转和清理需管理，预计每周产生 7 个日志文件（每日一个）；测试数据库隔离通过 :memory: 模式无污染
- **API surface parity：** logger API 保持兼容（info, warn, error, success），无破坏性变化
- **Integration coverage：** 模块间通信约定文档化后，新人理解调用链更快；context_id 追踪跨模块自动生效
- **Unchanged invariants：** 发布流程、数据持久化、平台适配器接口无变化，仅增加日志和测试覆盖

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Winston 库依赖未安装 | 在 Unit 5 前验证 package.json 中已有 winston 和 cls-hooked；若无则添加 |
| 现有日志调用大量变化导致兼容性问题 | 新 logger 完全保持现有 API（info, warn, error, success），测试覆盖现有调用点 |
| Context 追踪在并发场景下混乱 | cls-hooked 的 namespace 隔离天然支持并发；集成测试验证无混乱 |
| 日志文件无限增长或磁盘满 | Unit 6 实现日志轮转和最大 7 天保留；监控 `.data/logs/` 空间 |
| 测试覆盖补充导致测试时间过长 | 使用 :memory: 数据库和 mock，避免真实网络调用；预计整体测试 <30s |
| 新人文档不够清晰 | DEVELOPMENT.md 包含 3-5 个具体例子和常见错误排查 |

## Documentation / Operational Notes

- **部署影响：** 无需改变部署流程；日志文件在 `.data/logs/` 需确保存储空间（预计每周 <100MB）
- **监控：** 建议监控 `.data/logs/error.log` 的大小和更新频率
- **回滚计划：** 若 Winston 升级导致问题，可快速回滚到 Unit 4（模块治理完成）之前的状态，日志系统暂时不升级
- **新人培训：** 使用 DEVELOPMENT.md 作为培训材料，重点讲解模块地图和常见调试场景

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-05-comprehensive-debug-optimization-requirements.md](docs/brainstorms/2026-05-05-comprehensive-debug-optimization-requirements.md)
- **Related code patterns:**
  - Logger 现有实现：`/src/utils/logger.ts`
  - Database 隔离模式：`/src/db/__tests__/repositories.test.ts`
  - Error 分类：`/src/utils/smartRetry.ts`
  - Route 包装：`/src/routes/_helpers.ts`
- **External docs:**
  - [Winston.js Documentation](https://github.com/winstonjs/winston)
  - [cls-hooked Documentation](https://github.com/Jeff-Lewis/cls-hooked)
  - [Vitest Documentation](https://vitest.dev/)
  - [Supertest Documentation](https://github.com/visionmedia/supertest)

