---
title: feat: Streamline local distribution channel binding with single-login flow
type: feat
status: active
date: 2026-05-05
---

# Streamline Local Distribution Channel Binding with Single-Login Flow

## Overview

当前系统需要用户逐个为 7 个 API 平台和 15 个浏览器自动化渠道进行认证绑定，整个初始化过程需要 5-10 分钟。本规划通过以下方式简化流程：

1. **一体化认证入口** — 统一的登入页面展示所有渠道状态
2. **快速绑定向导** — 用户登入后自动进入渠道绑定向导流程
3. **智能检测和验证** — API 密钥即时验证、浏览器会话批量导入
4. **渠道优先级管理** — 用户可设置首选发布目标，减少选择成本

**目标**：将完整初始化时间从 5-10 分钟压缩至 2-3 分钟，提升用户体验。

## Problem Frame

### 当前痛点

1. **流程割裂**
   - API 平台需要编辑 `.env` 文件（环保变量）
   - 浏览器平台需要通过 UI 逐个启动浏览器登入
   - 品牌档案需要单独配置
   - 用户需要在多个页面/工具间切换

2. **无即时反馈**
   - 设置 API key 后无法验证是否有效
   - 首次发布失败才知道密钥过期或有误
   - 浏览器会话保存后无快速测试方式

3. **初始化体验差**
   - 新用户不知道需要做什么
   - 没有优先级提示（哪些渠道应该先配置）
   - 浏览器自动化的 5 步流程（启用 → 启动 → 登入 → 等待 → 测试）体验混乱

4. **批量操作困难**
   - 若用户有多个浏览器会话文件（如备份、团队共享），无法批量导入
   - 更换设备或重装系统需要重新登入所有渠道

### 用户需求

- **简化认证流程** — 登入一次，配置所有渠道
- **提高效率** — 减少手动步骤和等待时间
- **即时反馈** — 知道每个渠道是否已成功绑定
- **智能推荐** — 系统告诉用户应该绑定哪些渠道

## Requirements Trace

- **R1** — 用户登入后能在一个页面看到所有 22 个渠道的连接状态
- **R2** — 用户能为 API 平台快速添加/更新密钥，并即时验证有效性
- **R3** — 用户能批量上传浏览器会话文件（`.auth/*.json`），一次配置多个渠道
- **R4** — 用户能设置首选发布目标，避免每次都手动选择
- **R5** — 完整初始化流程（品牌档案 + 渠道绑定）不超过 3 分钟
- **R6** — 系统自动检测已过期的密钥或会话，提示用户更新

## Scope Boundaries

**包含**：
- 认证流程简化（API 密钥 + 浏览器会话）
- 渠道状态统一视图和管理
- 批量会话导入功能
- API 密钥即时验证
- 首选目标配置

**不包含**：
- OAuth 集成（作为 Phase 2 考虑）
- 用户隔离和多租户支持（单租户假设继续）
- 细粒度的权限管理
- 审计日志（Phase 3）

## Key Technical Decisions

1. **API 密钥验证方式 — 轻量级测试发布**
   - 每个适配器实现 `testConnection()` 方法
   - 发送最小可行的测试请求（如获取用户信息、创建草稿）
   - 同步响应，不阻塞主流程
   - **理由**：避免额外的验证 API 调用，利用现有适配器能力

2. **浏览器会话存储格式 — 保持 Playwright `storageState` JSON**
   - 继续使用 `.auth/{platform}.json` 格式
   - 支持用户手动编辑或外部导出（如浏览器扩展）
   - **理由**：标准化、易于备份、与现有系统兼容

3. **UI 框架 — 增强现有 admin.html，无需 SPA 迁移**
   - 使用 vanilla JS + Tailwind（与现有风格统一）
   - 渐进增强：不依赖框架库
   - **理由**：快速迭代，与当前项目风格保持一致

4. **首选目标管理 — 存储为 brand_profiles 表的新字段**
   - 字段名：`preferred_platforms: string[]`
   - 默认为当前 `getDefaultPublishingPlatforms()` 的结果
   - **理由**：与品牌档案绑定，避免新表依赖

5. **批量导入的验证 — 白名单化的平台 ID 检查**
   - 检查 ZIP 内的文件名是否匹配已知平台 ID
   - 拒绝未知平台的会话文件（安全）
   - **理由**：防止恶意会话文件注入

## Implementation Units

- [ ] **Unit 1: Add testConnection() interface to all platform adapters**

**Goal:** 让每个平台适配器能验证其 API 密钥或浏览器会话的有效性

**Requirements:** R2, R6

**Dependencies:** None

**Files:**
- Modify: `src/adapters/base.ts` — 新增抽象方法 `testConnection(): Promise<{ok: boolean, error?: string}>`
- Modify: `src/adapters/devto.ts`, `medium.ts`, `hashnode.ts`, `github.ts`, `blogger.ts`, `wordpress.ts`, `telegraph.ts` — 实现 `testConnection()`
- Modify: `src/adapters/browser-automation/` — 实现浏览器平台的 `testConnection()`
- Test: `src/adapters/__tests__/adapter-test-connection.spec.ts`

**Approach:**
- API 平台：调用官方 API 的低开销方法（如 `/user`、`/me`），不修改任何数据
- 浏览器平台：用保存的 cookies 打开浏览器，导航到编辑/设置页面，检查是否收到 401/403，30 秒超时
- 统一返回 `{ok: true}` 或 `{ok: false, error: "Authentication failed"}`
- 缓存测试结果 5 分钟，避免高频调用

**Patterns to follow:**
- 参考 `src/services/browser-session.ts` 第 40-65 行的浏览器启动逻辑
- 参考 `src/adapters/devto.ts` 第 4-11 行的 API 调用模式

**Test scenarios:**
- Happy path：有效的 API key → 返回 `{ok: true}`
- Happy path：有效的浏览器会话 → 返回 `{ok: true}`
- Error path：过期的 API key → 返回 `{ok: false, error: "401 Unauthorized"}`
- Error path：过期的浏览器 cookies → 返回 `{ok: false, error: "Cookies expired"}`
- Edge case：网络超时 → 返回 `{ok: false, error: "Timeout after 30s"}`
- Edge case：平台服务不可用（5xx） → 返回 `{ok: false, error: "Service unavailable"}`

**Verification:**
- 所有 7 个 API 平台都能验证 API key 有效性
- 所有 15 个浏览器平台都能验证会话有效性
- 测试覆盖所有平台和错误情况（至少 30 个测试用例）

---

- [ ] **Unit 2: Add batch browser session import API endpoint**

**Goal:** 用户能一次性上传包含多个平台会话的 ZIP 文件，避免逐个导入

**Requirements:** R3, R5

**Dependencies:** Unit 1

**Files:**
- Create: `src/routes/auth.ts` — 新建认证相关路由
  - `POST /api/auth/import-sessions` — 接受 ZIP 文件，批量导入
  - `POST /api/auth/test-connection/{platform}` — 测试单个平台连接（调用 Unit 1 的 `testConnection()`）
- Modify: `src/services/browser-session.ts` — 新增 `importSessions(zipBuffer): Promise<{imported: string[], failed: Array<{platform, error}>}>`
- Create: `src/routes/__tests__/auth.spec.ts`
- Modify: `src/server.ts` — 注册 `auth` 路由，添加 `/api/auth` 前缀

**Approach:**
- 使用 npm 包 `archiver` 或 `unzipper` 解析 ZIP
- 验证文件列表：
  - 允许的文件名：`.auth/{platform}.json`（例 `.auth/medium.json`）
  - 拒绝未知平台的文件（安全白名单）
  - 检查 JSON 格式合法性（cookies 数组、origins 数组）
- 逐个导入文件到 `.auth/` 目录，记录成功/失败
- 对每个导入的平台自动调用 `testConnection()`，返回验证结果
- 返回 `{imported: ["medium", "substack"], failed: [{platform: "unknown", error: "Unknown platform"}]}`

**Patterns to follow:**
- 参考 `src/services/browser-session.ts` 的文件 I/O 模式
- 参考 `src/adapters/base.ts` 的 `getAdapterId()` 映射

**Test scenarios:**
- Happy path：有效的单文件 ZIP（`.auth/medium.json`） → 导入成功 + 通过验证
- Happy path：有效的多文件 ZIP（3-5 个平台）→ 全部导入成功
- Edge case：ZIP 包含非 `.auth/` 文件 → 忽略，导入其他有效文件
- Error path：文件名不匹配（如 `.auth/unknown-platform.json`） → 跳过该文件，返回警告
- Error path：JSON 格式错误 → 跳过该文件，返回具体错误
- Error path：导入后测试连接失败（过期 cookies） → 导入但标记为"未验证"

**Verification:**
- 能正确解析 ZIP 文件
- 能识别合法/非法的平台 ID
- 验证后能正确报告成功/失败
- 文件已正确写入 `.auth/` 目录

---

- [ ] **Unit 3: Extend /api/platforms endpoint with test status and quick-add form**

**Goal:** 统一的渠道状态视图，包含实时连接测试和快速添加/更新的能力

**Requirements:** R1, R2, R4, R6

**Dependencies:** Unit 1, Unit 2

**Files:**
- Modify: `src/routes/admin.ts` — 增强 `GET /api/platforms`，新增 `connected_at`, `last_test_error`, `test_timestamp`
- Modify: `src/routes/admin.ts` — 新增 `PATCH /api/platforms/{platformId}/api-key` — 更新 API key 并即时验证
- Modify: `src/db/repositories.ts` — 新增 `platform_credentials` 表或在 `brand_profiles` 添加 `api_keys_encrypted` 字段，存储加密后的 API key
- Test: `src/routes/__tests__/admin-platforms.spec.ts`

**Approach:**
- 平台状态响应增加字段：
  ```json
  {
    "platforms": [
      {
        "name": "Dev.to",
        "id": "devto",
        "connected": true,
        "reason": "API key valid (last tested 2 min ago)",
        "connected_at": "2026-05-05T10:30:00Z",
        "last_test_error": null,
        "test_timestamp": "2026-05-05T10:32:00Z"
      }
    ]
  }
  ```
- `PATCH /api/platforms/{platformId}/api-key` 处理：
  1. 接收 `{apiKey: string}`
  2. 即时调用 Unit 1 的 `testConnection()`
  3. 若验证失败，返回 422 + 错误原因
  4. 若验证成功，加密存储 API key，返回 200 + 成功状态
- 定期后台任务（每小时一次）检查所有已连接平台的有效性，更新 `test_timestamp`

**Patterns to follow:**
- 参考现有的 `getPlatformStatus()` 函数扩展
- 参考 `brand-profile.ts` 的字段验证模式

**Test scenarios:**
- Happy path：用户提交有效的 API key → 即时验证通过，存储成功
- Error path：用户提交过期的 API key → 返回 422 + "API key expired"
- Happy path：GET `/api/platforms` 返回最新的测试状态和时间戳
- Edge case：后台验证任务发现已存储的密钥失效 → `connected: false`, `last_test_error: "401 Unauthorized"`
- Happy path：用户查看渠道列表，看到哪些是"Ready"、哪些需要"Action"

**Verification:**
- API key 被正确加密存储
- 即时验证反馈准确
- 后台定期检查功能正常运行
- 前端能正确展示状态

---

- [ ] **Unit 4: Create unified channel binding onboarding page**

**Goal:** 新用户登入后看到一个统一的渠道绑定向导，而不是分散在多个页面

**Requirements:** R1, R4, R5

**Dependencies:** Unit 1, Unit 2, Unit 3

**Files:**
- Create: `public/onboarding.html` — 新建品牌档案 + 渠道绑定一体化页面
- Create: `src/routes/onboarding.ts` — 新建路由，支持 GET /onboarding（检查初始化状态）和 POST /api/onboarding/complete
- Modify: `src/server.ts` — 注册 onboarding 路由
- Modify: `src/routes/_helpers.ts` — 新增 `isInitialized()` 检查函数（品牌档案存在 + 至少一个渠道已连接）
- Test: `public/__tests__/onboarding.spec.ts`（E2E 测试）

**Approach:**
- **页面布局**：四步向导流程（参考 Stripe onboarding）
  1. **品牌档案** — 输入品牌名、网站 URL，触发自动配置
  2. **API 渠道** — 列出 7 个 API 平台，用户快速粘贴 API key
  3. **浏览器渠道** — 选择启用浏览器自动化（可选），上传会话 ZIP 或逐个登入
  4. **首选目标** — 勾选默认发布的 5-7 个平台

- **交互流**：
  - 步骤 1-2 是必须的（品牌档案 + 至少 1 个渠道）
  - 步骤 3 可选（用户可跳过浏览器自动化）
  - 步骤 4 提供默认推荐（已连接的平台）
  - 完成后自动跳转到主页面

- **状态持久化**：
  - 在 IndexedDB 或 localStorage 中保存部分进度（非关键数据）
  - 服务端记录 `onboarding_completed_at` 在 brand_profiles 表

- **UI 风格**：
  - 继续使用 Tailwind CSS（现有风格）
  - 进度条显示当前步骤
  - 即时反馈（API key 验证、批量导入结果）

**Patterns to follow:**
- 参考现有的 `admin.html` 的 form 和 API 交互模式
- 参考 `variant-generator.ts` 的进度条实现（如有）

**Test scenarios:**
- Happy path：用户完整走过 4 步 → 初始化完成，所有字段正确保存
- Happy path：用户跳过浏览器渠道，仅配置 API 平台 → 初始化完成
- Edge case：用户在步骤 1 输入无效 URL → 提示"请输入有效的 URL"，不能继续
- Edge case：用户在步骤 2 粘贴无效的 API key → 即时验证失败，提示特定错误
- Edge case：用户关闭浏览器后返回 onboarding → 恢复之前的进度

**Verification:**
- 新用户访问 `/onboarding` 时自动跳转到该页面（若未初始化）
- 完成后 `brand_profiles.onboarding_completed_at` 被设置
- 所有输入的数据被正确持久化

---

- [ ] **Unit 5: Add preferred_platforms field to brand_profiles and implement selection logic**

**Goal:** 用户能配置首选发布目标，减少每次发布时的手动选择

**Requirements:** R4

**Dependencies:** Unit 3

**Files:**
- Modify: `src/db/repositories.ts` — 新增字段 `preferred_platforms: string[]`（JSON 存储）
- Modify: `src/services/brand-profile.ts` — 新增 `updatePreferredPlatforms(platforms: string[])`，包含验证逻辑
- Modify: `src/routes/admin.ts` — 新增 `PATCH /api/v2/brand-profile/preferred-platforms`
- Modify: `src/routes/publish.ts` — 若用户未明确指定平台，自动使用 `preferred_platforms`（降级至 `getDefaultPublishingPlatforms()`）
- Test: `src/__tests__/preferred-platforms.spec.ts`

**Approach:**
- 首选平台需满足：
  - 在 `isDefaultPublishTarget()` 的结果中（即已连接且可自动发布）
  - 用户明确选择（不是自动推断）
  
- 默认值：当前的 `getDefaultPublishingPlatforms()`

- 发布流程中的使用：
  ```typescript
  const targetPlatforms = resolveTargetPlatforms(
    req.body.platforms || getProfile(db).preferred_platforms
  );
  ```

- 验证规则：
  - 至少选择 1 个平台
  - 所有选择的平台都必须是"已连接"状态
  - 若平台后来断连，自动从首选中移除，日志记录

**Patterns to follow:**
- 参考 `resolveTargetPlatforms()` 的现有逻辑
- 参考 `validateForDispatch()` 的验证模式

**Test scenarios:**
- Happy path：用户选择 3 个平台作为首选 → 下次发布默认使用这 3 个
- Edge case：用户选择的平台后来失效（密钥过期） → 自动移除，日志记录
- Edge case：用户尝试选择一个已断连的平台 → 返回 422 + "Platform not available"
- Happy path：用户未设置首选，发布时使用系统默认推荐

**Verification:**
- 首选平台被正确存储和加载
- 发布流程能正确使用首选平台
- 故障处理逻辑正确（断连时自动清理）

---

- [ ] **Unit 6: Implement background validation task to detect stale credentials**

**Goal:** 定期检测已存储的凭证是否过期，提醒用户更新，确保系统可靠性

**Requirements:** R6

**Dependencies:** Unit 1

**Files:**
- Create: `src/services/queue/credential-validator-worker.ts` — 后台验证任务
- Modify: `src/services/queue/scheduler.ts` — 新增定时任务，每小时运行一次 credential validator
- Modify: `src/db/repositories.ts` — 新增字段 `platform_credentials.last_validated_at`
- Test: `src/services/queue/__tests__/credential-validator-worker.spec.ts`

**Approach:**
- 定时任务（每小时）：
  1. 遍历所有已连接的平台（基于 `brand_profiles` 的 API key 和 `.auth/` 目录中的会话）
  2. 对每个平台调用 Unit 1 的 `testConnection()`
  3. 若验证失败，更新 `platform_credentials.last_validated_at` 和 `validation_error`
  4. 记录日志，便于调试
  
- 前端检测：
  - `/api/platforms` 端点返回 `needs_update: true` 的平台
  - 前端在仪表板展示警告（如红色徽章）

- 通知机制（Phase 2）：
  - 可选：通过邮件或 Slack 通知用户更新凭证

**Patterns to follow:**
- 参考 `src/services/queue/publish-worker.ts` 的任务处理模式
- 参考 `src/services/queue/scheduler.ts` 的定时触发逻辑

**Test scenarios:**
- Happy path：所有平台都有效 → 日志记录"All credentials valid"
- Error path：某个平台凭证过期 → 标记为 `needs_update: true`，日志记录错误原因
- Edge case：网络错误导致验证超时 → 记录错误但不修改 `needs_update`（下次重试）
- Happy path：用户更新过期的凭证后，下次验证通过 → `needs_update` 变为 false

**Verification:**
- 定时任务按时运行（每小时）
- 验证结果被正确存储和展示
- 日志记录详细（便于故障诊断）

---

- [ ] **Unit 7: Update frontend to show quick-add forms and import UI**

**Goal:** 前端 UI 支持快速添加 API key、批量导入会话、设置首选平台

**Requirements:** R1, R2, R3, R4

**Dependencies:** Unit 1, Unit 2, Unit 3, Unit 4, Unit 5

**Files:**
- Modify: `public/admin.html` — 新增以下区域：
  - **API 渠道面板** — 按平台列出，每个渠道有"粘贴 Key"按钮，实时验证反馈
  - **浏览器渠道面板** — 显示已保存的会话，有"上传 ZIP"按钮，批量导入结果展示
  - **首选平台面板** — 可勾选已连接的平台作为首选
  - **验证状态** — 每个平台显示"✓ Ready" / "✗ Needs Action" / "⚠ Expired"
- Create: `public/assets/js/channels.js` — 处理快速添加、批量导入、首选配置的交互逻辑
- Modify: `public/assets/css/style.css` — 新增渠道面板的样式

**Approach:**
- **UI 组件**：
  1. 平台卡片（可复用）：显示状态、操作按钮、上次验证时间
  2. 快速添加对话框：文本输入框、验证按钮、错误提示
  3. 批量导入对话框：文件上传、进度条、结果列表
  4. 首选平台勾选框：可多选，默认预选已连接的平台

- **交互流**：
  - 用户点击"添加 Key" → 弹出对话框
  - 用户粘贴 key → 自动触发验证
  - 验证结果即时显示（绿色 ✓ 或红色 ✗）
  - 批量导入：拖拽或选择 ZIP → 显示进度 → 列出导入结果
  - 首选平台：用户勾选后自动保存

- **样式**：
  - 继续使用 Tailwind CSS
  - 响应式设计（移动端友好）
  - 暗色模式支持（如果现有系统有）

**Patterns to follow:**
- 参考现有的 `admin.html` 的 fetch 和 error handling 模式
- 参考 `variant-generator.ts` 的进度条 UI（如使用 HTML5 progress element）

**Test scenarios:**
- Happy path：用户在"API 渠道"面板粘贴 key → 即时验证通过 → 显示"✓ Ready"
- Happy path：用户在"浏览器渠道"上传 ZIP → 显示进度 → 列出导入结果
- Happy path：用户勾选首选平台 → 页面自动保存
- Error path：用户粘贴无效 key → 显示"✗ API key rejected"
- UX：用户看到清晰的状态提示，知道下一步应该做什么

**Verification:**
- 所有快速添加、批量导入、首选配置的交互都正常工作
- 验证状态实时更新
- 手机端 UI 可用

---

## System-Wide Impact

### Interaction Graph

```
┌─ API 渠道绑定（Unit 2, 3, 7）
│  └─ testConnection() ─────────────┐
│                                   ├─ Platform Status（Unit 3）
├─ 浏览器渠道绑定（Unit 2, 7）    ├─ Onboarding Page（Unit 4）
│  └─ importSessions()             ├─ Preferred Platforms（Unit 5）
│     └─ testConnection()          │
│                                  └─ Credential Validator（Unit 6）
└─ 品牌档案（既有系统）
   └─ Dispatch Ready Check
```

### 错误传播

- API key 验证失败 → `{ok: false, error: "..."}` → 前端展示 422 错误
- 浏览器会话过期 → 后台 validator 检测到 → 标记 `needs_update: true` → 前端展示警告
- 其他网络错误（超时、5xx） → 记录日志，重试逻辑由调用方决定

### 状态生命周期

**平台连接状态转移**：
```
disconnected
    ↓
   添加 API key / 上传会话
    ↓
connected (需要后台验证)
    ↓
   定期验证 (background validator)
    ↓
stale (验证失败) ← 用户需要更新
    ↓
connected (用户更新凭证)
```

### 缓存与一致性

- `testConnection()` 结果缓存 5 分钟（避免高频调用）
- 后台 validator 每小时运行一次（检查所有平台）
- 用户手动操作（添加 key）时立即清除缓存，强制验证

### API 契约变更

**新增 API**：
- `POST /api/auth/import-sessions` — 批量导入会话
- `POST /api/auth/test-connection/{platform}` — 测试单个平台
- `PATCH /api/platforms/{platformId}/api-key` — 快速添加/更新 API key
- `PATCH /api/v2/brand-profile/preferred-platforms` — 设置首选平台

**现有 API 增强**：
- `GET /api/platforms` — 新增字段 `connected_at`, `last_test_error`, `test_timestamp`, `needs_update`
- `GET /api/v2/brand-profile` — 新增字段 `preferred_platforms`, `onboarding_completed_at`

### 影响的现有流程

1. **Dispatch 流程**（src/routes/publish.ts）
   - 若用户未指定平台，自动使用 `preferred_platforms`（降级至系统默认）
   - **向后兼容**：现有调用方式不变

2. **Platform Status 检查**（routes/admin.ts）
   - 增加实时验证支持
   - **向后兼容**：返回的 JSON 增加新字段，不删除现有字段

3. **品牌档案保存**（routes/admin.ts）
   - 新增可选字段 `preferred_platforms`
   - **向后兼容**：不影响现有的保存逻辑

## Open Questions

### Resolved During Planning

- **API 密钥如何存储？**
  - 加密存储在 `platform_credentials` 表或 `brand_profiles.api_keys_encrypted` 字段
  - 使用 Node.js `crypto` 模块，密钥从 `process.env.ENCRYPTION_KEY` 读取
  - 仅在验证和发布时解密

- **浏览器会话文件是否应该加密？**
  - 不加密。现有的 `.auth/{platform}.json` 已经包含 cookies，属于敏感数据
  - 用户需要自行保管 `.auth/` 目录的访问权限（建议在 `.gitignore` 中）
  - ZIP 导入时进行完整性检查（JSON 格式验证），不进行数字签名

- **首选平台的默认值是什么？**
  - 首次初始化时，默认为当前的 `getDefaultPublishingPlatforms()` 结果
  - 用户可随时修改，修改后自动保存

### Deferred to Implementation

- **多用户隔离** — 本规划基于单租户假设，多用户支持在 Phase 2 时再考虑（需要添加 user_id 外键）
- **OAuth 集成** — Phase 2，针对支持 OAuth 的平台（Medium、Dev.to）
- **审计日志** — Phase 3，记录渠道绑定/解绑的操作历史
- **邮件通知** — Phase 2，当凭证过期时发送提醒邮件

## Risks & Dependencies

| 风险 | 严重性 | 缓解方案 |
|------|--------|--------|
| API 密钥存储不当导致泄露 | 高 | 加密存储，定期审查安全性；建议用户使用平台特定的 API key（有权限限制）而非主账号密码 |
| 某些 API 的 testConnection() 实现困难 | 中 | 做好前期调研，可能需要联系平台技术支持；若某平台无低开销的测试 API，可先跳过详细验证 |
| 浏览器自动化的会话有效期短（cookie 过期） | 中 | 后台 validator 每小时检测一次，及时提醒用户；用户可选手动刷新（启动浏览器重新登入） |
| 大量用户同时验证导致 API 配额超限 | 低 | 缓存验证结果 5 分钟，每小时后台验证一次（而非实时验证）；若有配额限制，在 testConnection() 中增加重试和限流逻辑 |
| 批量导入 ZIP 的文件大小限制 | 低 | 限制单次上传大小为 10 MB；ZIP 内文件数不超过 50 个 |
| 浏览器平台和 API 平台的混合绑定流程复杂 | 中 | onboarding 页面分步骤，明确每一步的目的和操作；提供"跳过"选项，不强制用户配置浏览器渠道 |

## Documentation / Operational Notes

- **更新 README.md** — 添加"快速开始"指南，说明如何通过 onboarding 页面初始化系统
- **更新 COMMUNICATION_CONTRACTS.md** — 文档新增 API 端点和返回格式
- **更新 .env.example** — 新增 `ENCRYPTION_KEY` 变量示例
- **创建 docs/CHANNEL_BINDING_GUIDE.md** — 详细的渠道绑定指南（包括每个平台的特定说明）

---

## Sources & References

- Origin context: 用户需求澄清对话（多渠道统一管理系统、用户账户与渠道账号绑定、提高效率）
- Related code:
  - `src/services/browser-session.ts` — 浏览器会话管理
  - `src/routes/admin.ts` — 平台状态检查逻辑
  - `src/adapters/` — 平台适配器基类和实现
  - `src/services/brand-auto-configure.ts` — LLM 自动配置示例
  - `src/db/repositories.ts` — 数据库 schema 和 ORM
- External patterns:
  - Stripe Onboarding — 分步骤初始化体验
  - Playwright `storageState()` — 浏览器会话序列化格式
