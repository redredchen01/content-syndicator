---
title: "fix: 修复主入口「系统设置」无法点击配置 + 串接 7 个分发平台到统一面板"
type: fix
status: active
date: 2026-05-05
origin: docs/brainstorms/2026-04-30-third-party-voice-syndicator-requirements.md
related: docs/plans/2026-05-05-002-feat-streamlined-distribution-channel-binding-plan.md
---

# 修复主入口「系统设置」无法点击配置 + 串接 7 个分发平台到统一面板

## Overview

主入口 `public/index.html` 侧栏的「系統設置」视图（`x-show="view === 'settings'"`，第 339-352 行）目前是一个**纯只读 grid**，把 `/api/settings` 返回的脱敏环境变量逐项展示出来 — 没有任何 input、button、form，因此用户「点不动」。

后端配置 API 已经齐全（`POST /api/settings`、`PATCH /api/platforms/:id/api-key`、`POST /api/auth/import-sessions`、`POST /api/auth/test-connection`、`GET /api/models`），都被先前 plan 002 实现过，但这些能力散落在 `public/admin.html` 和 `public/onboarding.html` 两个独立 HTML 页面里，主入口完全没有调用。

本规划做两件事：

1. **修复**：把「系統設置」视图从只读 grid 改造为 Alpine.js 交互组件，让用户能直接在主入口配置 LLM key、7 个分发平台 API key、浏览器自动化开关、ZIP 批量导入、Sheets / 摘要参数。
2. **串接**：复用 plan 002 已有的后端能力，在主入口形成一个可折叠的「设置中心」（LLM 与基础 / 分发平台 / 浏览器自动化 / Sheets 与摘要），不再要求用户跳转 `/admin.html`。

> **明确不做**（A 方案选项）：保留 `public/admin.html` 与 `public/onboarding.html` 不变。前者保留为高级页面，在主入口侧栏添加深链入口；后者继续用于首次绑定。

## Problem Frame

### 当前痛点

1. **主入口配置失能**：`public/index.html` 第 340-352 行的 settings 视图只渲染 `settingsEntries`（`Object.entries(/api/settings 返回值)`）为只读卡片，没有交互控件。用户在主入口看不到任何「修改」入口。

2. **配置能力分散**：
   - LLM key、Sheets ID、浏览器模式 → `POST /api/settings`（只有调用方在 `admin.html`/`onboarding.html` 早期版本，当前版本主入口无人调用）
   - 7 个 API 平台 key → `PATCH /api/platforms/:id/api-key`（仅 `admin.html` 与 `onboarding.html` 调用）
   - 浏览器会话 → `POST /api/auth/browser`、`POST /api/auth/import-sessions`、`POST /api/auth/test`（仅 admin/onboarding）
   - 一键验证 → `POST /api/platforms/batch-validate`（仅 admin）

3. **结果**：
   - 老用户回主页想改 key、加新平台 → 找不到入口
   - 新用户走完 onboarding 后想再加一个平台 → 没有自助路径
   - 「品牌資料已就緒」徽章亮绿，但底层 LLM key 失效时主入口毫无提示

### 用户需求

- 在主入口侧栏的「系統設置」一处搞定所有配置
- 输入即时验证（避免发布失败才发现 key 过期）
- 视觉化平台连接状态，不健康的平台一眼可见
- 浏览器自动化（可选）的开关 + 批量导入入口要在同一处

## Requirements Trace

- **R1（修复）**：`view === 'settings'` 视图必须可输入 / 可保存，覆盖 LLM key、平台 API key、Sheets ID、浏览器模式 4 类配置（对应 `getMaskedEnv()` 列出的环境变量及 `api_keys_encrypted` 内的密钥）。
- **R2（验证）**：每个分发平台的 API key 输入框旁边要有「测试」按钮，触发 `POST /api/auth/test-connection/:platformId` 并即时显示 ✓/✗。
- **R3（批量导入）**：浏览器自动化面板要支持上传 ZIP 触发 `POST /api/auth/import-sessions`，导入结果要能看到（成功列表 / 失败原因）。
- **R4（一键全检）**：要有「全部测试」按钮，调用 `POST /api/platforms/batch-validate`，刷新所有平台状态。
- **R5（保护）**：保存 LLM key / Sheets 凭据后必须立即调用 `resetLLMClients()`（已在 `POST /api/settings` 内部实现，前端无需特殊处理）；保存平台 key 后必须刷新 `view === 'brand'` 的「品牌資料已就緒」徽章状态。
- **R6（不破坏）**：`public/admin.html`、`public/onboarding.html` 不动；`POST /api/settings` 的契约（接受的 KEYS 列表）不动；`PATCH /api/platforms/:id/api-key` 不动。
- **R7（origin R3 衍生）**：保留 plan 002 的「品牌档案前置闸」检测，这一视图只增不减。

## Scope Boundaries

**包含**：
- 仅改 `public/index.html`（settings view 与 `syndicatorApp()` 内 `loadSettings/saveSettings` 等数据流）
- 复用现有所有后端 API，不新增端点
- 在侧栏 footer 增加一个「高级管理 → /admin.html」深链
- 新增的 settings 视图要把现有 `loadSettings()` 升级为加载 + 编辑 + 保存的双向数据绑定

**不包含**：
- 不重构 `admin.html`、`onboarding.html`
- 不新增后端 API、不改数据库 schema
- 不改 LLM 调用逻辑、不改适配器、不改队列
- 不引入新的前端框架（继续 Alpine.js + Tailwind via CDN）
- 不做暗色模式 / 国际化
- 不做密钥导出 / 导入（除现有 ZIP 浏览器会话外）
- 不做权限分级 / 审计日志

## Context & Research

### Relevant Code and Patterns

- `public/index.html:339-352` — 当前只读 settings view（待重构）
- `public/index.html:357-613` — `syndicatorApp()` Alpine 组件（已有的数据流模式：`loadBrandProfile`、`saveBrand`、`loadHistory`、`loadSettings`）
- `public/index.html:431-437` — `switchView()` 已自带 lazy-load（`if (id === 'settings') this.loadSettings()`），可直接复用
- `public/admin.html:204-619` — 已有的 vanilla JS 实现，作为前端交互参考（特别是 `loadPlatformsWithCaching`、`openApiKeyForm`、`quickAddChannel`、`updateChannelDiagnostics`）
- `public/onboarding.html:221-275` — `renderApiChannels()` 内的「输入框 → blur 自动验证」交互模式
- `src/routes/config.ts:21-49` — `getMaskedEnv()` 决定哪些 key 暴露给前端
- `src/routes/config.ts:80-92` — `POST /api/settings` 接受的 KEYS 白名单（前端表单字段必须匹配）
- `src/routes/admin.ts:104-114` — `GET /api/platforms` 返回结构（`name`、`id`、`connected`、`reason`、`browserAutomation`、`canPublishAutomatically`、`last_test_error`、`test_timestamp`）
- `src/routes/admin.ts:248-352` — `PATCH /api/platforms/:platformId/api-key`：接受 `{apiKey}`，内部即时调用 `adapter.testConnection()`，失败返回 422
- `src/routes/admin.ts:398-...` — `POST /api/platforms/batch-validate`：批量重测
- `src/routes/auth.ts:22-51` — `POST /api/auth/import-sessions`：multipart ZIP 上传
- `src/routes/auth.ts:54-85` — `POST /api/auth/test-connection/:platformId`：单平台重测
- `src/routes/admin.ts:144-202` — `POST /api/auth/browser`：触发浏览器自动化登入弹窗
- `src/services/credential-validator.ts` + `src/index.ts:30-56` — 后台每 24h 自动重测，结果写入 `brand_profiles.platform_test_status`，`GET /api/platforms` 已会返回最新状态

### Institutional Learnings

- 当前 plan 002 已经把「testConnection、ZIP 导入、preferred_platforms」全部实现并单元测试覆盖；本 plan 只是把这些能力的前端入口收口到主入口
- `admin.html` 内的 `loadPlatformsWithCaching` 用了 10 秒缓存 + 30 秒强制刷新，避免高频拉 `/api/platforms` 引发 testConnection 重跑；本 plan 的 settings 视图应沿用同款节流策略
- index.html 已经使用 Alpine.js + CDN 加载，无 build pipeline；新增 UI 必须保持纯 HTML/JS，不引入 npm 依赖

### External References

- 不需要外部研究 — 本工作的所有模式都已在 admin.html 和 onboarding.html 中存在，且后端契约已定。

## Key Technical Decisions

| 决策 | 选择 | 理由 |
|---|---|---|
| **前端框架** | 继续用 Alpine.js + Tailwind CDN | 与 index.html 现状一致，零迁移成本；新增 ~150 行 Alpine 代码即可覆盖 |
| **设置面板布局** | 4 个折叠 section（LLM 与基础 / 分发平台 / 浏览器自动化 / Sheets 与摘要） | 配置项数量大（18+），单页拖很长；折叠让用户聚焦在自己要改的那一块 |
| **保存粒度** | 每个 section 独立「保存」按钮（不是全局一键保存） | 用户改单个 key 不应触发整体重启；更接近 onboarding 已有的逐项保存模式 |
| **API key 验证时机** | 输入框 blur 时验证（沿用 onboarding.html 模式），不在每次按键 | 避免重复打 testConnection，节省外部 API 配额 |
| **平台 key 存储** | 优先走 `PATCH /api/platforms/:id/api-key`（加密入库 `api_keys_encrypted`），不再用 `POST /api/settings` 改 env | plan 002 已统一到加密 DB 存储；env 写入仅留给 LLM / Sheets / 浏览器模式 |
| **浏览器自动化集成** | 同一个 section 里：开关 + 模式选择（separate-chromium / chrome-profile / installed-chrome） + 「上传 ZIP 批量导入」+ 平台逐个「在浏览器登入」 | 让用户在一处看到所有浏览器相关能力，不用跨视图 |
| **节流** | `loadSettings()` 自身缓存 10 秒；`loadPlatforms()` 复用同一缓存 | 切换 view 时不再重复打 `/api/settings` + `/api/platforms` |
| **回退兼容** | 保留 `loadSettings()` 原本的 `settingsEntries` 数据，仅在 settings view 渲染层改造；其他 view 不受影响 | 最小爆炸半径 |

## Open Questions

### Resolved During Planning

- **Q：要不要把 admin.html 的「渠道诊断」也搬过来？**
  A：不要。admin.html 的「快速修复」依然存在，主入口侧栏增加深链入口（footer 加一行「⚙ 高级管理」）即可。重复实现两套诊断 UI 没意义。

- **Q：批量导入 ZIP 用什么 UI？**
  A：直接用 HTML `<input type="file" accept=".zip">`，参考 onboarding.html:130-131；上传后用 `FormData` 提交，不引入额外库。

- **Q：保存 LLM key 后要不要把 `/api/models` 自动重新拉一次？**
  A：要。`POST /api/settings` 已经内部 `resetLLMClients()`，前端在保存成功后立即重拉 `/api/models` 刷新模型选择下拉框即可。

- **Q：`telegraph` 不需要 API key（无 token 也能发），如何展示？**
  A：`GET /api/platforms` 返回的 `connected: true` 已经覆盖（telegraph 永远是 connected）；UI 显示「无需配置」标签即可，不渲染输入框。

### Deferred to Implementation

- **DB 字段命名一致性**：`platform_test_status` 是 JSON 列，新加的字段如 `connected_at` 对每个平台是否要持久化？现有 `credential-validator.ts:109-113` 已写入 `connected_at`，前端直读即可；如发现遗漏由实现期补 migration（不在本 plan 范围）。
- **Telegraph 之外是否还有「无需 key」的平台**：当前只有 telegraph 一例，实现期按 `adapter.config?.requiresApiKey` 判断更稳，需要在 base adapter 加这个字段或用 `getMaskedEnv()` 反推。
- **浏览器模式切换是否需要重启 service**：`getBrowserAuthMode()` 从 env 读，`POST /api/settings` 写完 env 后立即生效（next request reads new env），不需要重启 — 实现期验证一次即可。

## High-Level Technical Design

> *以下示意 settings 视图的数据流与组件结构，是评审用的方向性指引，不是实现规范。实现 agent 不要照抄字段名。*

```
┌── index.html (Alpine.js: syndicatorApp) ─────────────────────────────┐
│                                                                       │
│  view === 'settings' →  <SettingsPanel> (新增)                       │
│                          │                                            │
│         ┌────────────────┴────────────────┬──────────────┬─────────┐ │
│         │                                 │              │         │ │
│      LLM 与基础       分发平台 (7)     浏览器自动化   Sheets/摘要   │ │
│         │                                 │              │         │ │
│   GET /api/settings  GET /api/platforms  GET /api/      GET /api/  │ │
│   GET /api/models    (10s cache)          settings      settings   │ │
│         │                                 │              │         │ │
│   [保存]              [测试][配置]       [开关]          [保存]    │ │
│   POST /api/settings  PATCH /api/        POST /api/     POST /api/ │ │
│   then refresh        platforms/:id/     auth/browser   settings   │ │
│   /api/models         api-key            POST /api/                │ │
│                       (auto validate)    auth/import-              │ │
│                                          sessions (ZIP)            │ │
└───────────────────────────────────────────────────────────────────────┘

侧栏 footer 新增：
┌──────────────────────────────┐
│ ✓ 品牌资料已就绪              │
│ ⚙ 高级管理 → /admin.html      │  ← 新增深链
└──────────────────────────────┘
```

### Settings Panel 折叠结构（mockup，非实现）

```
┌────────────────────────────────────────────────────────────┐
│ 系統設置                                       [全部测试]  │
├────────────────────────────────────────────────────────────┤
│ ▾ LLM 与基础                                                │
│   Gemini Key  [●●●●●abcd          ] [验证]                │
│   OpenAI Key  [                    ] [验证]                │
│   选用模型    [▾ gemini-1.5-flash                  ]       │
│                                              [保存 LLM]   │
│                                                            │
│ ▾ 分发平台 (7)                       已连接 4 / 待配置 3 │
│   ✓ Dev.to       ●●●●●xyz   [测试][更新]                 │
│   ✗ Medium       未配置      [配置]                       │
│   ✓ Hashnode     ●●●●●...   [测试][更新]                 │
│   ✓ GitHub       ●●●●●...   [测试][更新]                 │
│   ✗ Blogger      未配置      [配置]                       │
│   ✗ WordPress    未配置      [配置]                       │
│   ⊙ Telegra.ph   无需配置                                 │
│                                                            │
│ ▸ 浏览器自动化（可选）                            [关]    │
│                                                            │
│ ▸ Google Sheets / 日终摘要                                │
└────────────────────────────────────────────────────────────┘
```

## Implementation Units

- [ ] **Unit 1: 重写 settings view 为可折叠 4-section 容器，废弃只读 grid**

**Goal:** 把 `view === 'settings'` 视图从只读 grid 改成 4 section 折叠面板，引入 Alpine `x-data` 子组件状态（`sectionOpen`、`saving`、`testStatus`），为后续 Unit 2-5 的具体 section 提供容器。

**Requirements:** R1, R6

**Dependencies:** None

**Files:**
- Modify: `public/index.html`（替换第 339-352 行的 settings view 区块；在 `syndicatorApp()` 内新增 `settingsView` 子状态，约第 423 行 `settingsEntries` 附近）
- 无后端改动

**Approach:**
- 保留现有 `loadSettings()`，但把返回值赋给一个结构化对象 `settingsRaw`（替代原来的 `settingsEntries` Object.entries 数组），便于子 section 取用
- 新建 4 个 section（LLM / Platforms / Browser / Sheets），用 `<details>` 或 Alpine `x-show + x-transition` 实现折叠
- 每个 section 顶部留一个 placeholder（Unit 2-5 填充）
- 顶部增加全局「全部测试」按钮，调用 `POST /api/platforms/batch-validate`，结果只更新 platforms 缓存
- 把 settings view 容器宽度从 `max-w-2xl` 改为 `max-w-3xl`（与 admin.html 一致），避免折叠后挤压

**Patterns to follow:**
- `public/index.html:431-437` 的 lazy load 模式
- `public/admin.html:139-164` 的卡片样式
- Alpine 折叠用法：`x-data="{open: false}" @click="open = !open" x-show="open"`

**Test scenarios:**
- Happy path：切换到 settings view → 看到 4 个折叠 section 的标题，默认全部折叠（首屏不渲染密集表单）
- Happy path：点开 LLM section → `loadSettings()` 已被 lazy load 调用过，`settingsRaw.GEMINI_API_KEY` 显示脱敏值
- Happy path：点击「全部测试」→ 平台状态徽章（在 platforms section 中）出现 loading → 测试完毕刷新颜色
- Edge case：`loadSettings()` 失败 → section 内显示「加载失败，[重试]」
- Edge case：用户在 saving 中切走 view → saving 状态 promise 完成后不应触发 toast（用 `if (this.view !== 'settings') return`）

**Verification:**
- 切换 view 时 settings 内容不再是只读 grid
- `settingsEntries` 老数据完全不再被引用（grep 通过）
- 4 个 section 标题可点击折叠 / 展开，无 console 错误

---

- [ ] **Unit 2: LLM 与基础 section（Gemini/OpenAI key + 模型选择）**

**Goal:** 在 LLM section 提供 Gemini key、OpenAI key 输入与脱敏展示、保存、即时验证（拉一次 `/api/models` 看是否返回非空），以及 SELECTED_MODEL 下拉。

**Requirements:** R1, R2, R5

**Dependencies:** Unit 1

**Files:**
- Modify: `public/index.html`（LLM section 内嵌 form 与按钮；`syndicatorApp()` 新增 `saveLlmSettings()`、`loadModels()`）
- 无后端改动（复用 `POST /api/settings`、`GET /api/models`）

**Approach:**
- 输入框使用 `type="password"`，旁边一个 👁 按钮可临时切换为 text（不持久化）
- placeholder 显示当前脱敏值（如 `●●●●abcd`），用户清空后再输入会触发覆盖；空值不提交（避免清掉已存在 key）
- 「保存 LLM」点击后：调 `POST /api/settings`，body 仅含本 section 字段（`GEMINI_API_KEY`、`OPENAI_API_KEY`、`SELECTED_MODEL`）；成功后重拉 `/api/models` 刷新模型下拉
- 模型下拉用 `<select x-model="selectedModel">`，选项来自 `loadModels()` 返回的 `models[]`

**Patterns to follow:**
- `public/admin.html:178-200` 的「快速添加 key」对话框结构（输入 + 状态提示）
- `public/index.html:312-314` 的 saveBrand 反馈消息样式

**Test scenarios:**
- Happy path：用户粘贴新 Gemini key → 点保存 → 状态提示「✓ 已保存，模型列表已刷新」→ 模型下拉新增可用模型
- Happy path：仅修改 SELECTED_MODEL 不改 key → 保存成功，env 中 SELECTED_MODEL 被更新
- Edge case：用户清空 OpenAI key 输入框（仅留 placeholder） → 不提交该字段，原 key 保持
- Error path：保存后 `/api/models` 返回空数组 → 状态提示「✗ 保存了但模型列表为空，请检查 key 是否有效」
- Edge case：网络中断 → 状态提示「✗ 网络错误：xxx」，不清空输入框（用户可重试）

**Verification:**
- 改 LLM key 后无需重启，下一次发布自动用新 key（`resetLLMClients()` 已在 `POST /api/settings` 内部触发）
- SELECTED_MODEL 变更立即影响后续 `/api/v2/generate` 调用

---

- [ ] **Unit 3: 分发平台 section（7 平台列表 + inline 配置 + 测试 + 状态徽章）**

**Goal:** 列出 7 个 API 平台的连接状态，每行支持「测试」、「配置/更新 key」（弹出嵌入式 inline 表单，无对话框），覆盖 `connected_at`、`last_test_error`、`test_timestamp` 展示。

**Requirements:** R1, R2, R4, R5, R7

**Dependencies:** Unit 1

**Files:**
- Modify: `public/index.html`（platforms section 渲染列表 + inline form；`syndicatorApp()` 新增 `loadPlatforms()`、`testPlatform(id)`、`savePlatformKey(id, key)`、`platformsCache`、`platformsCacheTime`）
- 无后端改动（复用 `GET /api/platforms`、`PATCH /api/platforms/:id/api-key`、`POST /api/auth/test-connection/:id`、`POST /api/platforms/batch-validate`）

**Approach:**
- 每行结构：图标（✓/✗/⊙）+ 平台名 + 脱敏 key（如有）+ 错误提示（`last_test_error`）+ 测试时间（`test_timestamp`，相对时间） + [测试][更新]按钮
- `[配置]` / `[更新]` 点击 → 该行下方展开 inline 输入框 + 保存按钮（不弹 modal）
- key 输入框 blur 时自动验证（沿用 onboarding.html:236-274 的模式）
- 保存成功后：清除 `platformsCache`，重拉 `loadPlatforms()`；触发 `loadBrandProfile()` 刷新顶部「品牌資料已就緒」徽章状态
- Telegra.ph 单独显示「无需配置」灰色标签，无操作按钮
- 浏览器自动化平台（`adapter.isBrowserAutomation === true`）不在本 section 列出 → 留给 Unit 4
- 缓存策略：`loadPlatforms()` 10 秒内复用 cache（避免连续切换 view 触发后端 testConnection）

**Patterns to follow:**
- `public/admin.html:577-611` 的渲染模板（直接复制再适配 Alpine）
- `public/onboarding.html:251-274` 的 blur 验证 + apiKeysMap 模式
- `public/admin.html:544-569` 的缓存逻辑

**Test scenarios:**
- Happy path：进入 settings 展开 platforms section → 看到 7 个平台 + 默认平台标签 + 颜色徽章
- Happy path：点击「测试」单个平台 → 200 ms 内显示 loading → 测试结果替换徽章颜色
- Happy path：点击「配置」未连接平台 → inline 输入框展开 → 粘贴 key → blur 后即时验证 ✓ → 自动保存
- Error path：粘贴无效 key → blur 验证 ✗ → 红色提示「✗ 401 Unauthorized」→ 不写入后端
- Edge case：用户在 inline 输入框中点「取消」→ 该平台行收起，缓存不变
- Integration：保存任一平台 key 成功 → 顶部品牌徽章状态联动刷新（验证 `loadBrandProfile()` 被调用）
- Edge case：`/api/platforms` 返回 telegraph，但显示「无需配置」+ 无操作按钮
- Edge case：「全部测试」并发触发，UI 不允许重复点击（loading flag）

**Verification:**
- 7 个 API 平台都可在主入口完成 key 配置，无需跳 admin.html
- 状态徽章准确反映 `GET /api/platforms` 返回的 `connected` / `reason`
- 保存后，下一次 `/api/v2/dispatch` 不再因为 key 缺失被 precheck 拒绝

---

- [ ] **Unit 4: 浏览器自动化 section（开关 + 模式选择 + ZIP 批量导入 + 平台逐个登入）**

**Goal:** 同一个 section 内提供「启用浏览器自动化」开关、3 种模式选择、ZIP 批量导入、列出浏览器自动化平台并支持逐个「在浏览器登入」+「测试会话」。

**Requirements:** R1, R3, R6

**Dependencies:** Unit 1

**Files:**
- Modify: `public/index.html`（browser section 内嵌开关、模式 select、ZIP 上传、浏览器平台列表；`syndicatorApp()` 新增 `saveBrowserSettings()`、`importSessionsZip(file)`、`openBrowserLogin(platformId)`、`testBrowserSession(platformId)`）
- 无后端改动（复用 `POST /api/settings` 写入 `ENABLE_BROWSER_AUTOMATION`/`BROWSER_AUTH_MODE`/`BROWSER_AUTH_CHROME_*`、`POST /api/auth/browser`、`POST /api/auth/test`、`POST /api/auth/import-sessions`）

**Approach:**
- 顶部一个 toggle：`x-model="browserEnabled"`，对应 `ENABLE_BROWSER_AUTOMATION`，关闭时下方所有控件 disabled
- 模式 select：`separate-chromium` / `chrome-profile` / `installed-chrome`，根据选中显示/隐藏 `BROWSER_AUTH_CHROME_USER_DATA_DIR` 与 `BROWSER_AUTH_CHROME_PROFILE` 输入框
- ZIP 上传：`<input type="file" accept=".zip">` + 「导入」按钮 → `FormData` POST `/api/auth/import-sessions`；返回结果在下方列出 `imported[]` ✓ 与 `failed[]` ✗（带 error）
- 浏览器自动化平台列表：从 `loadPlatforms()` 缓存中过滤 `isBrowserAutomation === true` 的项；每行「会话存在 / 不存在」徽章 + [在浏览器登入] [测试会话] 按钮
- 「在浏览器登入」：`POST /api/auth/browser` 触发 — 后端会打开 Playwright 窗口，用户在窗口完成登入并关闭窗口后 cookies 自动持久化；前端 toast「已打开 [模式名] 登入窗口，登入后关闭即可保存」
- 「测试会话」：`POST /api/auth/test` 触发，前端 toast「已打开测试窗口，看到编辑器/仪表板说明 cookies 有效」

**Patterns to follow:**
- `public/admin.html:155-158` 的「快速修复」按钮样式
- `public/onboarding.html:118-133` 的浏览器自动化开关 + 文件输入
- `src/routes/admin.ts:144-202` 现有后端契约（含禁用时的 403 / loginUrl 不支持时的 400）

**Test scenarios:**
- Happy path：用户开启 toggle → 选择 `separate-chromium` 模式 → 保存 → env 已写入；下次开浏览器登入按钮可用
- Happy path：上传 ZIP（含 medium.json + devto.json）→ 状态显示「✓ 导入 2 个：medium、devto」
- Happy path：点击 medium 「在浏览器登入」→ toast 出现 → 后台 Playwright 启动（手动登入由用户完成）
- Error path：toggle 关闭时点「在浏览器登入」→ 前端 disabled 不响应；若绕过则后端返回 403
- Error path：上传非 ZIP 文件 → multer 拦截，前端显示「✗ 仅支持 ZIP 文件」
- Edge case：上传 ZIP 含未知平台文件 → 列出 imported + failed 两段，未知平台在 failed 段
- Edge case：模式选 `chrome-profile` → 显示用户数据目录与 profile 输入框；改为 `separate-chromium` → 隐藏

**Verification:**
- 开关 + 模式 + ZIP 导入 + 浏览器登入全部可在主入口操作，不再要求跳 admin.html
- 上传 ZIP 后浏览器平台行徽章自动刷新为「会话存在」
- 模式切换不需要重启 server（下一个浏览器请求读新 env 即可）

---

- [ ] **Unit 5: Sheets / 摘要 section（Sheet ID + Service Account 凭据 + Digest 渠道）**

**Goal:** 让用户在主入口配置 Google Sheets ID、service account JSON、digest_channel 与 digest_destination（与 plan 002 brand-profile 中的 digest 字段不冲突，这里管的是基础设施级开关）。

**Requirements:** R1, R6

**Dependencies:** Unit 1

**Files:**
- Modify: `public/index.html`（sheets section 内嵌 form；`syndicatorApp()` 新增 `saveInfraSettings()`）
- 无后端改动（复用 `POST /api/settings` 接受的 `GOOGLE_APPLICATION_CREDENTIALS_JSON`、`GOOGLE_SHEET_ID`）

**Approach:**
- 字段：`GOOGLE_SHEET_ID`（input text）、`GOOGLE_APPLICATION_CREDENTIALS_JSON`（textarea，placeholder 显示「{ ...已配置... }」如果已存在）
- digest_channel / digest_destination 已经在 brand-profile 维护（plan 002），本 section 不重复，但放一个「→ 跳到品牌资料库的 digest 部分」链接
- 保存按钮独立，不与平台 / LLM 干扰

**Patterns to follow:**
- `public/admin.html:60-117` 的 brand-form 字段布局
- `src/routes/config.ts:80-92` 的 KEYS 列表（确保前端只提交允许的字段）

**Test scenarios:**
- Happy path：粘贴 service account JSON → 保存成功 → 状态显示「✓ 已保存」
- Happy path：仅改 Sheet ID 不改 JSON → 仅提交 SHEET_ID 字段
- Edge case：JSON 字符串非法 → 前端不做严格校验（后端 `getMaskedEnv()` 用 `JSON.parse` 时若失败由后端兜底）；仅在 toast 中显示后端错误信息
- Edge case：Sheet ID 留空提交 → 后端按 KEYS 白名单过滤，空字符串不写入

**Verification:**
- 改完 Sheet ID 后下一次 sheets-jobs 用新 ID（无需重启）
- service account JSON 替换后下一次 sheets 写入用新凭据

---

- [ ] **Unit 6: 侧栏「高级管理」深链 + 「品牌资料就绪」徽章联动**

**Goal:** 在 index.html 侧栏 footer 增加一行「⚙ 高级管理 → /admin.html」，作为高级配置（含批次诊断、失败列表）的入口；同时，settings 视图中保存任何配置后必须刷新「品牌资料已就绪」徽章。

**Requirements:** R5, R7

**Dependencies:** Unit 3

**Files:**
- Modify: `public/index.html`（第 46-50 行 footer 结构追加一个 `<a>`；`saveLlmSettings/savePlatformKey/saveBrowserSettings/saveInfraSettings` 完成后调 `loadBrandProfile()`）
- 无后端改动

**Approach:**
- footer 在原品牌徽章下方加 `<a href="/admin.html" target="_blank" class="...">⚙ 高级管理</a>`
- 任何 save\* 函数末尾都补 `await this.loadBrandProfile()`，刷新 `brandReady` 与 `brandProfile`

**Patterns to follow:**
- `public/index.html:46-50` 的现有 footer 结构

**Test scenarios:**
- Happy path：点击「⚙ 高级管理」→ 在新标签页打开 /admin.html
- Integration：在 settings 中保存第一个平台 key → 顶部 sidebar 徽章从「⚠ 請先配置品牌資料」变为「✓ 品牌資料已就緒」（前提：品牌资料库本身也已配置）
- Edge case：保存失败 → `loadBrandProfile()` 仍调用一次，确保徽章不会卡在错误状态

**Verification:**
- 任何 settings 内的保存动作都触发徽章刷新
- 老用户能从主入口直接到达 admin.html 不丢失原能力

## System-Wide Impact

- **Interaction graph**：
  - settings view 调用：`/api/settings`、`/api/models`、`/api/platforms`、`/api/platforms/:id/api-key`、`/api/auth/import-sessions`、`/api/auth/test-connection/:id`、`/api/auth/browser`、`/api/auth/test`、`/api/platforms/batch-validate`
  - 触发的副作用：`POST /api/settings` 内部 `resetLLMClients()` + 写 `.env` + 同步 `process.env`；`PATCH /api/platforms/:id/api-key` 内部 `testConnection()` + 写 `api_keys_encrypted` + 写 `platform_test_status`
  - 上游影响：`view === 'brand'` 的徽章、`view === 'publish'` 的「立即发布」前置闸（`isReadyForDispatch`）

- **Error propagation**：
  - 所有保存按钮 → try/catch → `saveMsg` 显示成功/失败文案
  - testConnection 失败由后端返回 422 → 前端展示 `data.error`，不写入存储
  - ZIP 上传失败由 multer/服务端返回 400/500 → 前端展示 `data.error`

- **State lifecycle**：
  - `platformsCache` 在 settings view 与 brand view 之间共享（10 秒 TTL）
  - 保存任意 key/会话后立即清缓存，避免下次读到旧状态
  - settings view 切走时不停止任何后台 polling（无 polling）

- **API surface parity**：admin.html 与 onboarding.html 仍调用相同的端点；本规划不破坏任何契约

- **Integration coverage**：
  - 「保存 LLM key 后下一次 /api/v2/generate 用新 key」(env 写入 + resetLLMClients)
  - 「保存平台 key 后下一次 /api/v2/dispatch 不被 precheck 拒绝」(brand-profile 徽章刷新)
  - 「ZIP 导入后浏览器平台徽章变为已连接」(`hasSavedBrowserSession` 立即返回 true)

- **Unchanged invariants**：
  - 后端所有路由 / 入参 / 出参不变
  - admin.html、onboarding.html 不动
  - DB schema 不动
  - LLM 适配器 / 队列 / 调度 不动

## Risks & Dependencies

| 风险 | 缓解 |
|------|------|
| 用户在 settings 视图同时改多 section、保存按钮分散导致部分提交 | 每个 section 独立 saveMsg，明确告知本次保存范围；section 顶部加「未保存改动」红点 |
| `POST /api/settings` 写入 .env 是文本替换（`config.ts:51-68`），并发保存可能产生竞态导致字段丢失 | 前端避免并发提交（同时只允许一个 saving 状态）；竞态在原 admin/onboarding 已存在，不在本 plan 修复 |
| 前端 Alpine 组件膨胀（额外 ~150 行 JS）影响主入口启动速度 | 用 lazy load：进入 settings 才 `loadPlatforms/loadModels`；`x-show` 让未点开 section 不渲染表单 |
| testConnection 重跑撞外部 API 速率限制 | 「全部测试」按钮加 5 秒冷却；单平台「测试」按钮 loading 期间 disabled |
| 浏览器自动化「在浏览器登入」要求服务端能弹出 GUI 窗口（headless 环境下会失败） | 复用 admin.html 已有的 503/500 错误处理，前端展示「请检查 ENABLE_BROWSER_AUTOMATION 与运行环境」 |
| ZIP 上传 50MB 限制（multer fileSize），用户分批导出可能超限 | 错误信息明确给出「请将 ZIP 拆分为 ≤50MB」，与 admin 一致 |

## Documentation / Operational Notes

- 更新 `CHANNEL_SETUP_GUIDE.md`：把「在 admin.html 配置」段落改为「在主入口侧栏「系统设置」配置」，admin.html 标记为「高级管理（保留）」
- 更新 `README.md` 的「快速开始」段：onboarding 完成后再次配置走 `/index.html#settings`，不需要再去 admin.html
- 不改 `.env.example`、不改 `package.json`、不动 `tsconfig.json`

## Sources & References

- **Origin document**: [docs/brainstorms/2026-04-30-third-party-voice-syndicator-requirements.md](../brainstorms/2026-04-30-third-party-voice-syndicator-requirements.md)
- **Related plan**: [docs/plans/2026-05-05-002-feat-streamlined-distribution-channel-binding-plan.md](2026-05-05-002-feat-streamlined-distribution-channel-binding-plan.md)
- Related code:
  - `public/index.html:339-352`（待重构的只读 settings view）
  - `public/index.html:357-613`（`syndicatorApp()` Alpine 组件）
  - `public/admin.html:204-619`（参考的交互模式）
  - `public/onboarding.html:221-275`（输入框 blur 自动验证模式）
  - `src/routes/config.ts:21-92`（`getMaskedEnv` 与 `POST /api/settings` 契约）
  - `src/routes/admin.ts:104-352`（`/api/platforms` 与 `PATCH .../api-key`）
  - `src/routes/auth.ts:22-85`（ZIP 导入 + test-connection）
  - `src/services/credential-validator.ts`（24h 后台验证 + `platform_test_status`）
- 后端不需要改动，所有需要的 API 端点已经实现并测试覆盖
