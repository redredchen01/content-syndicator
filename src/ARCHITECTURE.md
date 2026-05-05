# 项目架构 - 模块职责清单

## 概述

项目采用 **13 个核心模块** 的分层架构，依赖方向为：`utils → (db, llm, agent) → services → routes`。各模块遵循单一职责原则，无循环依赖。

---

## 核心 13 个模块

### 1. **routes/** — API 层（入口）

**职责：** Express 路由处理，接收 HTTP 请求，调用 services 业务逻辑，返回响应。

**关键文件：**
- `publish.ts` — 发布相关路由（POST /api/v2/generate, /dispatch, /regenerate）
- `admin.ts` — 管理路由（品牌资料配置）
- `config.ts` — 配置管理路由
- `history.ts` — 历史查询路由
- `_helpers.ts` — asyncRoute / syncRoute 包装函数，统一错误处理

**职责细节：**
- 路由定义和 HTTP 方法映射
- 请求参数验证（由 helpers 完成）
- 调用对应 services 方法
- 错误捕获和 HTTP 状态码返回
- 日志记录（入口和出口）

**依赖：** services, db, sheets, utils (logger)

**测试覆盖：** 5%（待补充至 50%）

---

### 2. **services/** — 业务逻辑编排层（核心）

**职责：** 实现发布、生成、监控等业务流程，协调多个模块（adapters, db, llm, scraper），处理复杂的业务规则。

**子模块：**

#### 2.1 **publish-service.ts**
- 核心发布编排：variant 生成 → 质量评分 → 平台选择 → 多平台发布 → Sheets 同步
- 输入：URL 和发布配置
- 输出：`{ ok: boolean, publishedUrls: {[platform]: url}, errors: {[platform]: string} }`

#### 2.2 **variant-generator.ts**
- 使用 LLM 为不同平台生成 7 个 variants（并发）
- 调用 llm/agent-llm.ts 的 invokeLLMWithTools
- 使用 utils/parallel.ts 并发执行

#### 2.3 **anchor-generator.ts**
- 生成锚文本（mini-prompt）
- 用于防止身份暴露

#### 2.4 **brand-profile.ts**
- 验证和加载品牌资料
- 单行强制（品牌只有一份资料）

#### 2.5 **anchor-monitor.ts**
- 集中度监控（5-gram Jaccard 相似度）
- 周上限检查（防止重复发布）

#### 2.6 **browser-session.ts**
- 浏览器自动化会话管理
- 为每个并发任务分配独立浏览器实例
- 超时处理和资源清理

#### 2.7 **lint/** (子目录)
- `index.ts` — Lint 管道（Jaccard + regex 黑名单）
- `jaccard.ts` — 5-gram 相似度计算
- `regex-rules.ts` — 身份暴露词黑名单

#### 2.8 **queue/** (子目录) — 作业调度和后台处理
- `scheduler.ts` — SQLite 作业调度器（2 秒 tick，无外部依赖）
- `publish-worker.ts` — 发布作业 handler
- `liveness-worker.ts` — T+24/7/30h 存活检查
- `digest-job.ts` — 每日 18:00 摘要推送
- `sheets-jobs.ts` — Sheets 聚合和对账

**职责细节：**
- 复杂业务规则的编排和协调
- 多模块间的数据流转
- 状态管理（作业状态机）
- 错误处理和恢复逻辑

**依赖：** adapters, db, llm, utils (logger, smartRetry, parallel), cache, sheets, scraper

**测试覆盖：** 40%（待补充至 80%，重点：publish-service, browser-session）

---

### 3. **adapters/** — 平台适配层

**职责：** 为 7 个平台（Blogger, Dev.to, GitHub, Hashnode, Medium, Telegraph, WordPress）实现统一的发布接口。

**平台列表：**
- `blogger.ts` — Blogger.com 发布
- `devto.ts` — Dev.to 发布
- `github.ts` — GitHub Gists 发布
- `hashnode.ts` — Hashnode 发布
- `medium.ts` — Medium 发布
- `telegraph.ts` — Telegra.ph 发布
- `wordpress.ts` — WordPress.com 发布
- `base.ts` — PlatformAdapter 基类
- `browser.ts` — 浏览器自动化基类

**接口：**
```typescript
interface PlatformAdapter {
  publish(content: PublishPayload): Promise<PublishResult>;
  // PublishResult: { ok: boolean, publishedUrl?: string, error?: string }
}
```

**职责细节：**
- 平台特定的认证和 API 调用
- 内容格式转换
- 浏览器自动化（若需要）
- 平台特定的错误处理

**依赖：** utils (logger, browserManager, smartRetry), llm

**测试覆盖：** 0%（待补充至 70%，每个平台 2-3 个关键场景）

---

### 4. **db/** — 数据库层

**职责：** SQLite 数据持久化，提供单一的数据库接口和仓储模式。

**关键文件：**
- `index.ts` — SQLite 单例初始化，提供 v0.1 兼容 API
- `schema.ts` — 8 张表 DDL 定义 + 迁移函数
- `repositories.ts` — 6 个命名空间（publishJobs, linkChecks, llmCalls, anchorHistory, posts, draftBatches）

**8 张表：**
1. **posts** — v0.1 兼容，已发布内容记录
2. **task_progress** — 平台发布进度追踪
3. **brand_profiles** — 品牌配置（单行强制）
4. **publish_jobs** — 作业队列（状态机：scheduled → running → succeeded/failed）
5. **link_checks** — T+24h/7d/30d 存活监控记录
6. **anchor_history** — 每个发布的锚文本历史
7. **llm_calls** — LLM 调用成本追踪
8. **draft_batches** — 草稿预览状态恢复

**职责细节：**
- 数据的读写、查询、事务管理
- Schema 版本管理和迁移
- 数据库连接池和生命周期管理

**依赖：** utils (logger, errorHandler)

**测试覆盖：** 85%（已完整，现状维持）

---

### 5. **llm/** — LLM 客户端层

**职责：** 统一的 LLM 调用接口，支持 OpenAI 和 Gemini API。

**关键文件：**
- `client.ts` — OpenAI / Gemini 单例客户端初始化
- `index.ts` — invokeLLM()，通用内容生成
- `agent-llm.ts` — invokeLLMWithTools()，Agent 工具调用

**职责细节：**
- LLM API 客户端管理
- Prompt 和工具 schema 组装
- 调用参数标准化
- 错误分类和重试

**依赖：** utils (logger, smartRetry)

**测试覆盖：** 60%（已有 mock，current 维持）

---

### 6. **utils/** — 通用工具库（基础层）

**职责：** 为所有模块提供通用功能，无业务逻辑。

**工具模块（10 个）：**
- `logger.ts` — **日志系统（待升级为 Winston）**
- `browserManager.ts` — Playwright 浏览器单例 + semaphore 并发控制
- `smartRetry.ts` — 错误分类 + 断路器（5 种错误类型 + 3 级重试）
- `parallel.ts` — 非中断式并发执行（单个失败不阻止其他）
- `authManager.ts` — OAuth 认证管理
- `errorHandler.ts` — 统一错误处理（待补充测试）
- `healthCheck.ts` — 健康检查
- `systemMonitor.ts` — 系统监控（内存、CPU）
- `configValidator.ts` — 配置验证（待补充测试）
- `autoCleanup.ts` — 自动清理（过期数据）（待补充测试）

**职责细节：**
- 可复用的功能封装
- 无业务逻辑，纯工具性质
- 为上层服务提供基础能力

**依赖：** 无内部依赖（仅外部库）

**测试覆盖：** 60%（待补充至 90%，重点：authManager, errorHandler, configValidator, autoCleanup）

---

### 7. **agent/** — Agent 核心（实验功能）

**职责：** 实现自主代理逻辑，支持 Agent 模式下的自动化工作流。

**关键文件：**
- `core.ts` — Agent 主循环
- `memory.ts` — 内存管理（对话历史、上下文）
- `planner.ts` — 规划器（决策逻辑）
- `tools.ts` — Tool 基类定义
- `tools/` — 7 个具体 tool 实现（publish-tool, scrape-tool, generate-tool, analyze-tool 等）

**职责细节：**
- Agent 生命周期管理
- Tool 调用编排
- 状态和记忆持久化

**依赖：** llm, services, utils (logger)

**使用频率：** 低（目前主要用于 voice syndicator 特性）

---

### 8. **sheets/** — Google Sheets 集成

**职责：** 与 Google Sheets 集成，实现发布结果同步和数据聚合。

**关键文件：**
- `index.ts` — Google Sheets 客户端 + TokenBucket 速率限制

**职责细节：**
- Google Sheets API 客户端管理
- 数据同步（将发布结果写入 Sheets）
- 数据聚合（从 Sheets 读取汇总数据）
- 令牌刷新和速率限制

**依赖：** utils (logger, smartRetry)

---

### 9. **scraper/** — URL 爬虫

**职责：** 抓取网页内容，提取文章正文（使用 Playwright + Mozilla Readability）。

**关键文件：**
- `index.ts` — 爬虫入口函数

**职责细节：**
- 网页渲染（Playwright）
- 正文提取（Readability）
- 缓存管理（通过 cache/ 模块）

**依赖：** utils (logger, browserManager), cache

---

### 10. **cache/** — 缓存层

**职责：** 实现两层缓存（爬虫缓存、相似度缓存），加速重复操作。

**关键文件：**
- `scrapeCache.ts` — 爬虫结果缓存
- `similarityCache.ts` — 相似度计算缓存

**职责细节：**
- 缓存键的生成和管理
- TTL 和过期处理
- 缓存命中率监控

**依赖：** utils (logger)

---

### 11. **types/** — 类型定义

**职责：** 项目全局的 TypeScript 类型定义，作为类型系统的唯一来源。

**关键文件：**
- `index.ts` — 单一来源，包含：
  - `PlatformAdapter` 接口
  - `PublishResult`, `PublishPayload` 等数据结构
  - `ErrorType` 枚举
  - 其他共用类型

**职责细节：**
- 类型定义和维护
- 保证类型一致性（无重复定义）

**依赖：** 无

---

### 12. **prompts/** — Prompt 模板和人设

**职责：** 管理 LLM 的 prompt 模板和人物角色，实现 prompt 动态加载。

**关键文件：**
- `loader.ts` — Prompt 模板加载器
- `personas/` — 人设 markdown 文件（tech_blogger, personal_essay, reviewer 等）
- `anchor-generator.md` — 锚文本生成 prompt

**职责细节：**
- Prompt 的存储和版本管理
- 动态模板加载
- 人设选择和应用

**依赖：** utils (logger, configValidator)

---

### 13. **middleware/** — Express 中间件

**职责：** 通用的 Express 中间件（如认证、日志、错误处理）。

**当前状态：** 空（middleware 逻辑目前在 `routes/_helpers.ts` 中）

**计划补充：**
- 请求日志中间件（记录 context_id）
- 认证中间件
- 错误处理中间件

**依赖：** utils (logger), types

---

## 依赖关系总览

```
utils/（基础层）
  ↑
  └──→ 被所有 35 个文件导入

db/（数据层）
  ↓
services/（业务逻辑层）
  ├─→ adapters/（平台层）
  ├─→ llm/（LLM 调用层）
  ├─→ agent/（Agent 核心）
  ├─→ sheets/（Sheets 集成）
  ├─→ scraper/（爬虫）
  └─→ cache/（缓存）

routes/（API 层）
  ↓
services/
```

**关键原则：**
- ✅ utils 不依赖任何业务模块
- ✅ db 仅被 services 依赖
- ✅ adapters / llm / agent 被 services 或 routes 间接使用
- ✅ **无循环依赖**
- ❌ 不允许 routes 直接依赖 db（必须通过 services）
- ❌ 不允许 adapters 依赖 services（仅依赖 utils, llm）

---

## 测试覆盖目标

| 模块 | 现状 | 目标 | 优先级 |
|------|------|------|--------|
| **db** | 85% | 90% | 低（维持） |
| **services** | 40% | 80% | 高（重点） |
| **adapters** | 0% | 70% | 高（重点） |
| **routes** | 5% | 50% | 中 |
| **utils** | 60% | 90% | 中 |
| **llm** | 60% | 70% | 低 |
| **queue** | 80% | 85% | 低 |
| **其他** | 50% | 70% | 低 |
| **整体** | 31.8% | 70%+ | 必须 |

---

## 最后更新

**日期：** 2026-05-05  
**版本：** v0.2  
**状态：** 有效（无重构计划，仅补充测试和日志系统）

