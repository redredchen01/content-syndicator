---
title: feat: Browser platform 1-Click login flow — UI wiring + session reliability
type: feat
status: completed
date: 2026-05-06
origin: docs/plans/2026-05-05-002-feat-streamlined-distribution-channel-binding-plan.md
---

# Browser Platform 1-Click Login Flow

## Overview

后端已有完整的有头浏览器登录路由（`POST /api/auth/browser`），但 `admin.html` 没有任何代码调用它——浏览器平台的「连接」按钮当前只打开 API Key 输入框，对 browser-automation 平台完全无效。

本计划修复五个互相关联的缺口：UI 与后端断开、缺少轮询状态端点、新平台缺少登录 URL、ZIP 导入嵌套目录 bug、`testConnection()` 无法检测 session 失效。

**目标**：用户在 UI 上点击任意浏览器平台的「1-Click Connect」后，系统打开真实浏览器 → 用户手动登录 → 系统自动捕获并保存 session → UI 实时显示「已连接」。

## Problem Frame

研究发现的现状（see repo-research-analyst findings）：

| 层 | 状态 |
|---|---|
| `POST /api/auth/browser` 路由 | ✅ 已实现，打开有头浏览器，每 2s 保存 storageState |
| `POST /api/auth/test` 路由 | ✅ 已实现，在有头浏览器中重现 session |
| admin.html — 浏览器平台连接按钮 | ❌ 只调用 `openApiKeyForm()`，不调用登录路由 |
| 新平台登录 URL（Substack、Quora 等 9 个） | ❌ admin.ts 只 hardcode 了 medium/devto/blogger |
| 前端轮询「登录完成」状态 | ❌ 缺少 GET 状态端点 |
| ZIP 导入路径 | ❌ 解压到 `.auth/.auth/` 而非 `.auth/` |
| `testConnection()` 对 session 失效的检测 | ⚠️ 只捕获异常，不检测重定向到登录页 |

## Requirements Trace

- **R1** — 所有 9 个浏览器平台在 UI 上展示独立的「1-Click Connect」入口（see origin R1）
- **R2** — 点击后打开有头浏览器 → 用户完成登录后 UI 自动更新为「已连接」（see origin R5 时间目标）
- **R3** — 批量 ZIP 导入能正确写入 `.auth/{platform}.json`，无嵌套目录（see origin R3）
- **R4** — `testConnection()` 能可靠检测到 session 过期（see origin R6）

## Scope Boundaries

**In scope:**
- admin.html 浏览器平台 UI 段（1-Click Connect 按钮 + 状态轮询）
- admin.ts 登录 URL 映射补全
- 新增 `GET /api/auth/browser/status/:platform` 轮询端点
- `importSessions()` ZIP 解压路径 bug 修复
- `BrowserAutomationAdapter.testConnection()` 登录重定向检测

**Out of scope:**
- OAuth 集成（单独计划）
- 修改 authManager.ts（已确认为孤立模块，不影响当前流程）
- 浏览器自动化发布逻辑本身

## Context & Research

### Relevant Code and Patterns

- `src/routes/admin.ts` L148–206 — `POST /api/auth/browser` 实现，已有 `setInterval` 每 2s 存 storageState；参数从 `req.body.platform` 读取
- `src/routes/admin.ts` L27–35 — `API_CONNECTED` map 的 data-driven 模式（新端点仿照此风格）
- `src/services/browser-session.ts` L104–189 — `importSessions(zipBuffer)`，Bug 在 L132 的 `Extract({ path: AUTH_DIR })` — 若 ZIP 内文件路径已含 `.auth/` 前缀，会产生 `.auth/.auth/` 嵌套
- `src/adapters/browser.ts` L35–62 — `testConnection()`，当前只 `catch` 导航异常，不检测 `page.url()` 是否含 `login`/`signin`
- `src/adapters/browser.ts` L42 — auth 文件路径生成：`name.toLowerCase().replace(/[^a-z0-9]/g, '')`（即 cleanId）
- `public/admin.html` L577–611 — 平台列表渲染，当前所有平台的「连接」按钮都调用 `openApiKeyForm()`

### Key Platform Login URLs（需补全进 admin.ts）

| Platform | cleanId | Login URL |
|---|---|---|
| Substack | `substack` | `https://substack.com/sign-in` |
| Indie Hackers | `indiehackers` | `https://www.indiehackers.com/sign-in` |
| Quora | `quora` | `https://www.quora.com/` （首页含登录弹窗）|
| Product Hunt | `producthunt` | `https://www.producthunt.com/login` |
| ztndz | `ztndz` | `https://ztndz.com/login` |
| yoursocialpeople | `yoursocialpeople` | `https://yoursocialpeople.com/login` |
| zopedirectory | `zopedirectory` | `https://www.zopedirectory.com/login` |
| zed-directory | `zeddirectory` | `https://www.zed-directory.com/login` |
| youslade | `youslade` | `https://youslade.com/login` |

### Institutional Learnings

- `acquirePage()` / `releasePage()` 必须配对，直接 `page.close()` 会导致并发计数泄漏（见 browser-session research）
- `testConnection()` 当前 30s timeout 与 plan 要求一致，15s 是适配器代码中的值，需与规划对齐
- 测试结果缓存（5 分钟）在 origin plan 中已决策但尚未实现 — 本计划范围内作为 nice-to-have，不阻塞

## Key Technical Decisions

1. **状态端点设计 — 文件存在检查 + cookie 数量门槛**
   - `GET /api/auth/browser/status/:platform` 读取 `.auth/{cleanId}.json`，返回 `{ exists, cookieCount, mtime }`
   - `cookieCount`：解析 JSON 的 `cookies` 数组长度（未登录时 setInterval 写入的初次 storageState 几乎为空，≤2 个 cookies；已登录后通常 ≥5）
   - 不调用 `testConnection()`（会启动浏览器，代价太高）
   - **理由**：mtime 单独不可靠——页面刚加载时（用户还没输账号密码）setInterval 就会写入空 session，mtime 就已 > loginStartedAt；cookieCount 门槛是区分"空 session"与"已登录 session"的最轻量信号

2. **前端轮询策略 — cookieCount 门槛判定成功**
   - 点击「1-Click Connect」时记录 `loginStartedAt = Date.now()`
   - 轮询间隔 2s，最长 5 分钟
   - 判定成功条件：`mtime > loginStartedAt AND cookieCount >= 5`
   - 门槛值 5 可在代码中定义为常量 `MIN_AUTH_COOKIES = 5`，便于后续调整
   - **理由**：初次页面加载时 storageState 只含 0–2 个通用 cookie；完成登录后各平台通常写入 5–20 个 auth cookie

3. **ZIP 修复策略 — 在写入前规范化路径，不依赖 Extract 本身**
   - `importSessions()` 中用 `unzipper.Open.buffer()` 手动遍历 entries，而非 `Extract()`
   - 对每个 entry 路径做 `path.basename()` 取文件名，再拼接 `AUTH_DIR`，彻底规避路径注入和嵌套
   - **理由**：`Extract({ path })` 对含路径前缀的 ZIP entry 行为不可控，手动迭代更可靠

4. **testConnection() 增强 — 检测导航后 URL 是否含登录关键词**
   - 导航后检查 `page.url()` 是否匹配 `/\/login\b|\/sign[-_]?in\b|\/auth\b|\/account\/login/i`（路径前缀约束，避免子串误匹配如 `/design-signin-flow`）
   - 若匹配则返回 `{ ok: false, error: 'Session expired — please re-authenticate' }`
   - **例外**：Quora 使用 JS 模态弹窗检测登录态，不发生 URL 跳转，此增强对 Quora 无效（已知局限，见 Open Questions）
   - **理由**：大多数平台 session 失效后会 302 到登录页，URL 是最可靠的检测信号

## High-Level Technical Design

> *本图为方向性设计，供审阅验证，实现时以代码为准。*

```
用户点击「1-Click Connect (Substack)」
        │
        ▼
admin.html: POST /api/auth/browser  { platform: 'substack' }
        │
        ▼
admin.ts: 查 loginUrlMap → 'https://substack.com/sign-in'
        │     createBrowserAuthContext('substack')
        │     导航到登录 URL
        │     setInterval(2s) → storageState → .auth/substack.json
        │
        └── 立即响应 { success: true }
        │
        ▼
admin.html: 开始轮询 GET /api/auth/browser/status/substack
        │     (每 2s，记录 loginStartedAt)
        │
        ▼
admin.ts: 检查 .auth/substack.json mtime
        │     mtime > loginStartedAt → { exists: true, mtime }
        │
        ▼
admin.html: 更新按钮为 ✅ 已连接，停止轮询
```

## Implementation Units

```mermaid
TB
  U1[Unit 1: Login URL 映射] --> U2[Unit 2: Status 端点]
  U2 --> U3[Unit 3: admin.html UI]
  U1 --> U4[Unit 4: ZIP Bug 修复]
  U1 --> U5[Unit 5: testConnection 增强]
```

- [ ] **Unit 1: admin.ts — 补全浏览器平台登录 URL 映射**

**Goal:** 让 `POST /api/auth/browser` 对所有 9 个新平台都能导航到正确的登录页，而不是退回到 composeUrl。

**Requirements:** R1, R2

**Dependencies:** 无

**Files:**
- Modify: `src/routes/admin.ts` （loginUrl 映射段）
- Test: `src/routes/__tests__/admin-platforms.test.ts`（或新建 `admin-browser.test.ts`）

**Approach:**
- 找到 admin.ts 中的 `loginUrl` 逻辑段（目前 hardcode medium/devto/blogger 后 else 用 composeUrl）
- 将其改为 data-driven 的 `loginUrlMap: Record<string, string>`，与 `API_CONNECTED` 同风格
- 补全所有 9 个新平台的登录 URL（见 Key Platform Login URLs 表）
- Quora 无独立登录页，用 `https://www.quora.com/` + 登录弹窗 URL 即可
- cleanId 生成规则：`platform.toLowerCase().replace(/[^a-z0-9]/g, '')`，注意 `zed-directory` → `zeddirectory`

**Patterns to follow:**
- `API_CONNECTED` map（admin.ts L27–35）

**Test scenarios:**
- Happy path: 已知平台 `substack` → loginUrlMap 返回正确 URL `https://substack.com/sign-in`
- Happy path: `zed-directory` → cleanId 为 `zeddirectory`，映射到正确 URL
- Edge case: 未在 map 中的平台 → fallback 用 adapter 的 `composeUrl`（不 crash）
- Edge case: `ENABLE_BROWSER_AUTOMATION=false` → 路由返回 403（现有行为不变）

**Verification:**
- `POST /api/auth/browser { platform: 'substack' }` 触发后，日志中出现 Substack 登录 URL 导航记录

---

- [ ] **Unit 2: admin.ts — 新增 GET /api/auth/browser/status/:platform**

**Goal:** 提供轮询端点，让前端知道登录是否完成（文件是否已被写入），无需启动浏览器。

**Requirements:** R2

**Dependencies:** Unit 1（cleanId 规则需一致）

**Files:**
- Modify: `src/routes/admin.ts`
- Test: `src/routes/__tests__/admin-browser.test.ts`（新建）

**Approach:**
- 新增路由 `GET /api/auth/browser/status/:platform`
- cleanId = `platform.toLowerCase().replace(/[^a-z0-9]/g, '')`
- 用 `fs.statSync(.auth/{cleanId}.json)` 检查文件是否存在及 `mtime`
- 返回 `{ exists: boolean, mtime: number | null, platform: string }`
- 不启动浏览器，不调用 `testConnection()`
- 文件不存在时返回 `{ exists: false, mtime: null }`（HTTP 200，不是 404）

**Patterns to follow:**
- `hasSavedBrowserSession()` in `browser-session.ts`（同类文件检查逻辑）
- asyncRoute wrapper（admin.ts 中已有的错误处理 wrapper）

**Test scenarios:**
- Happy path: `.auth/substack.json` 存在 → 返回 `{ exists: true, mtime: <timestamp> }`
- Happy path: 文件不存在 → 返回 `{ exists: false, mtime: null }`
- Edge case: `platform` 含特殊字符（`zed-directory`）→ cleanId 规范化后正确查找 `zeddirectory.json`
- Error path: `AUTH_DIR` 目录不存在 → 返回 `{ exists: false, mtime: null }`（不抛 500）

**Verification:**
- 手动用 curl 查询已存在的 session 文件返回正确 mtime
- 查询不存在的平台返回 `exists: false`，HTTP 200

---

- [ ] **Unit 3: admin.html — 浏览器平台 1-Click Connect UI**

**Goal:** 让浏览器平台在 UI 上展示「1-Click Connect」按钮，点击后异步轮询状态，登录完成时自动更新显示。

**Requirements:** R1, R2

**Dependencies:** Unit 1（后端路由）, Unit 2（状态端点）

**Files:**
- Modify: `public/admin.html`

**Approach:**
- 在平台列表渲染逻辑中，按 `adapter.isBrowserAutomation` 区分两种按钮：
  - API 平台：现有的 `openApiKeyForm()` 按钮（不变）
  - 浏览器平台：新的「1-Click Connect」按钮，调用新函数 `startBrowserLogin(platformId)`
- `startBrowserLogin(platformId)`:
  1. 记录 `loginStartedAt = Date.now()`
  2. `POST /api/auth/browser { platform: platformId }`
  3. 按钮文字改为「浏览器已打开，请登录...」+ 禁用
  4. 启动轮询：`setInterval(2000)` 调用 `GET /api/auth/browser/status/{platformId}`
  5. 若 `mtime > loginStartedAt` → 轮询停止，按钮变「✅ 已连接（重新连接）」
  6. 超时 5 分钟 → 停止轮询，按钮恢复，提示「请关闭浏览器窗口后重试」
- session 已存在的平台（`hasSavedSession: true`）在初始加载时显示「✅ 已连接」状态

**Technical design（directional）:**
```
renderPlatformCard(platform):
  if platform.isBrowserAutomation:
    show 1-Click Connect button
    if platform.hasSession:
      badge = "✅ 已连接"
      button label = "重新连接"
    else:
      badge = "未连接"
      button label = "1-Click Connect"
  else:
    show existing API key form button
```

**Patterns to follow:**
- 现有平台列表渲染段（admin.html L577–611）的 DOM 生成风格
- 现有 `fetch('/api/...')` + `async/await` 模式

**Test scenarios:**
- Happy path: 浏览器平台卡片初始渲染，已有 session 的平台显示「已连接」badge
- Happy path: 点击「1-Click Connect」→ 按钮 disabled + 文字改变；2s 后轮询检测到文件 mtime 更新 → 按钮恢复并显示「已连接」
- Edge case: 5 分钟无响应 → 按钮恢复，显示超时提示
- Edge case: `POST /api/auth/browser` 返回 403（browser automation 未启用）→ 显示「请先在 .env 设置 ENABLE_BROWSER_AUTOMATION=true」

**Verification:**
- 本地启动 server，打开 admin.html，能看到浏览器平台卡片有「1-Click Connect」按钮
- 点击后浏览器窗口打开，手动登录后 UI 自动更新

---

- [ ] **Unit 4: browser-session.ts — 修复 ZIP 导入嵌套目录 bug**

**Goal:** 修复 `importSessions()` 中 ZIP 解压产生 `.auth/.auth/` 嵌套目录的问题，确保文件正确写入 `.auth/{platform}.json`。

**Requirements:** R3

**Dependencies:** 无

**Files:**
- Modify: `src/services/browser-session.ts`
- Test: `src/services/__tests__/browser-session.test.ts`（已有，需补场景）

**Approach:**
- 将 `Extract({ path: AUTH_DIR })` 替换为手动 entry 迭代：
  - `unzipper.Open.buffer(zipBuffer)` → `.files` 数组
  - 对每个 entry，取 `path.basename(entry.path)` 为文件名（丢弃目录部分）
  - 过滤：只接受 `.json` 结尾、文件名（basename）等于 `{knownPlatformId}.json` 的 entry
  - `entry.buffer()` → 内容 → 验证 JSON → `fs.writeFileSync(path.join(AUTH_DIR, basename))`
- 同时检查内容是否为合法 storageState（含 `cookies[]` 和 `origins[]`）

**Patterns to follow:**
- 现有 `importSessions()` 的 ZIP 处理流程结构（只改解压方式，保留平台验证逻辑）
- `unzipper` 已在 package.json dependencies 中

**Test scenarios:**
- Happy path: ZIP 内含 `.auth/substack.json` 路径 → 正确写入 `AUTH_DIR/substack.json`，无嵌套
- Happy path: ZIP 内含裸文件名 `substack.json`（无目录前缀）→ 同样正确处理
- Edge case: ZIP 内含 `../../../etc/passwd` 路径 → basename 过滤后拒绝（非已知平台）
- Edge case: ZIP 内含未知平台 `unknown.json` → 跳过，不写入，记入 `failed[]`
- Edge case: ZIP 内 JSON 无效（非 storageState 格式）→ 跳过，记入 `failed[]`
- Error path: ZIP buffer 损坏 → 抛出可捕获错误，路由返回 400

**Verification:**
- `importSessions()` 测试全绿
- 手动上传包含 `.auth/substack.json` 的 ZIP，检查 `ls .auth/` 无嵌套 `.auth/.auth/` 目录

---

- [ ] **Unit 5: browser.ts — testConnection() 检测登录重定向**

**Goal:** 让 `testConnection()` 能可靠检测 session 已过期（浏览器被重定向到登录页）的情况，而不仅仅是捕获导航异常。

**Requirements:** R4

**Dependencies:** 无

**Files:**
- Modify: `src/adapters/browser.ts`
- Test: `src/adapters/__tests__/browser.test.ts`（已有或新建）

**Approach:**
- 导航 `composeUrl` 成功后，检查 `page.url()` 是否匹配登录关键词正则：`/login|sign[-_]?in|signin|\/auth\b|\/account\/login/i`
- 若匹配 → 返回 `{ ok: false, error: 'Session expired — please re-authenticate via 1-Click Connect' }`
- 原有 `catch` 异常路径保持不变
- timeout 值：统一为 plan 要求的 30000ms（检查当前是否为 15000）

**Patterns to follow:**
- 现有 `testConnection()` 的 try/catch 结构（browser.ts L35–62）
- `page.url()` 检查（Playwright 标准模式）

**Test scenarios:**
- Happy path: 导航后 URL 为 `https://substack.com/publish/post/new` → `{ ok: true }`
- Error path: 导航后 URL 为 `https://substack.com/login?next=...` → `{ ok: false, error: 'Session expired...' }`
- Error path: 导航抛出异常（超时/网络）→ `{ ok: false, error: ... }`（现有行为不变）
- Edge case: URL 含 `signin` 但不是登录页（如 `https://example.com/design-signin-flow`）→ 正则不误判（用 `\b` word boundary 或更严格匹配）

**Verification:**
- 用已失效的 session 文件（或手动清空 cookies）测试，`testConnection()` 返回 `ok: false`
- 用有效 session 文件测试，`testConnection()` 返回 `ok: true`

## Open Questions

### Resolved During Planning

- **mtime 竞态问题**：单独使用 mtime 不足以判定登录完成，因为 setInterval 在页面加载完成后就开始写入空 session。解决方案：状态端点同时返回 `cookieCount`，前端以 `cookieCount >= 5` 作为「已登录」信号。
- **asyncRoute vs syncRoute（Unit 2）**：状态端点只用 `fs.statSync`（同步），应使用 `syncRoute` wrapper，与 admin.ts 的现有模式保持一致，无需新增 import。
- **正则精度**：最终正则为 `/\/login\b|\/sign[-_]?in\b|\/auth\b|\/account\/login/i`，要求路径前缀，避免子串误判。

### Deferred to Implementation

- **MIN_AUTH_COOKIES 门槛值**：初设为 5，各平台实际 cookie 数量在实现阶段通过真实登录验证，必要时调整。
- **Quora testConnection() 局限**：Quora 使用 JS 模态弹窗而非 URL 跳转，Unit 5 增强对 Quora 无效。实现时可在 `BrowserAutomationAdapter` 或 Quora adapter config 上加 `skipLoginRedirectCheck?: boolean` 标志，或接受 Quora 的 `testConnection()` 永远返回 `ok: true`（低优先级，不阻塞本计划）。

## System-Wide Impact

- **Interaction graph:** `GET /api/auth/browser/status/:platform` 为纯只读端点，无副作用。`POST /api/auth/browser` 已存在，不改变签名。
- **Error propagation:** Unit 4 修复后 ZIP 错误在 service 层捕获，路由返回结构化错误（不改变现有 500 行为）。
- **State lifecycle risks:** setInterval session 保存逻辑不变；Unit 5 只在导航成功后追加 URL 检查，不改变计时器。
- **API surface parity:** `GET /api/auth/browser/status/:platform` 与 `POST /api/auth/test-connection/:platformId` 是互补关系——前者轻量（文件检查），后者重量（启动浏览器）。admin.html 的「刷新连接状态」可以选择性触发后者进行深度验证。
- **Unchanged invariants:** `.auth/{cleanId}.json` 的 Playwright storageState 格式不变；发布流程中 `BrowserAutomationAdapter.publish()` 不受影响。

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| 新平台登录 URL 不准确（平台更改了登录路径）| 已在 composeUrl 中有 fallback；用户可手动重定向 |
| 5 分钟轮询超时内用户未完成登录 | 超时后按钮恢复，用户可重试；无副作用 |
| URL 正则误判合法页面为登录页（Unit 5）| 用 word boundary 和路径前缀约束，优先保守（false positive 让用户重登，比 false negative 更安全）|
| unzipper API 手动迭代与现有测试不兼容 | Unit 4 需同步更新现有 browser-session 测试中与 ZIP 相关的 mock |

## Documentation / Operational Notes

- 部署后需在 `.env` 确认 `ENABLE_BROWSER_AUTOMATION=true`，否则所有浏览器平台按钮返回 403
- `.auth/` 目录权限：确保服务进程有写权限；建议 chmod 700（session 含明文 cookies）
- 存量 `.auth/.auth/` 嵌套目录需手动清理：`rm -rf .auth/.auth/`

## Sources & References

- **Origin plan:** [2026-05-05-002-feat-streamlined-distribution-channel-binding-plan.md](docs/plans/2026-05-05-002-feat-streamlined-distribution-channel-binding-plan.md)
- Backend routes: `src/routes/admin.ts` L148–249
- Browser session service: `src/services/browser-session.ts`
- Browser adapter: `src/adapters/browser.ts`
- Frontend: `public/admin.html` L577–611
