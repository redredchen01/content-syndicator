---
title: "refactor: admin.ts / publish.ts 薄 controller + per-domain service"
type: refactor
status: active
date: 2026-05-07
origin: docs/brainstorms/2026-05-07-route-refactor-thin-controller-requirements.md
---

# admin.ts / publish.ts 薄 controller + per-domain service

## Overview

把 `src/routes/admin.ts` (662 行) 與 `src/routes/publish.ts` (451 行) 拆成「薄 controller (< 80 行) + per-domain service」結構。新增 5 個 admin service + 4 個 publish service，連同合併 `credential-validator.ts` 共用的 envKeyMap snapshot/restore 邏輯。API 契約凍結，758 既有測試不修改、必須全部通過。分兩個獨立 PR：先 admin、再 publish。

## Problem Frame

連續 5 個 PR 都在加 OAuth 與安全修補，兩個路由文件已塞 5 個關注點各自混雜：路由層直接讀 db、操作 fs、做加密、跑 setInterval 清理、呼叫 adapter testConnection。下一波加平台或加功能會繼續膨脹（admin 預期破 800 行），業務邏輯與 HTTP 解析交織導致 service 級單測無法寫，新人改一個端點要讀 600+ 行。本次重構在膨脹失控之前畫清分層邊界。（origin: `docs/brainstorms/2026-05-07-route-refactor-thin-controller-requirements.md`）

## Requirements Trace

**Controller 結構**
- **R1** controller < 80 行（admin.ts / publish.ts），每 endpoint handler ≤ 5 行（parse → 委派 service → 解 tagged result → res.json）
- **R2** controller 不直接 import `db`、`fs`、`logger` 業務細節

**API 契約**
- **R3** URL / method / JSON shape / status code 完全不變

**Service 架構**
- **R4** admin 拆 5 個 service：`platforms / brand / browser-auth / credential-store / roi-config`（Unit 1: platforms+brand+roi-config；Unit 2: browser-auth；Unit 3: credential-store）
- **R5** publish 拆 4 個 service：`generation / dispatch / v2-dispatch / batch-status`（Unit 5: v2-dispatch+batch-status；Unit 6: generation+dispatch+bulk-queue）
- **R6** 每個 service < 300 行；`dispatch.ts` 因含 v1 publish + auto + bulk 三端點 **預先**拆出 `bulk-queue.ts` 子模組
- **R7** service 用 plain `export function`（非 class、非 DI）

**測試**
- **R8** 758 個既有測試 0 修改、全通過（59 個 test 文件，supertest + service 級 unit）
- **R9** 每個 service 至少 1 個 happy path + 1 個錯誤路徑單測；`credential-store.ts` 因觸及 secrets / env mutation 額外加上負向安全斷言（見 Unit 3）

**發布節奏**
- **R10** 兩個 PR 獨立合併，不混入功能新增

## Scope Boundaries

- 不動 `db/repositories.ts` (643 行) 拆分（已送 brainstorm queue，本 plan 兩 PR 合併後立即啟動 — 見 Future Considerations）
- 不動其餘 5 個路由（`auth.ts / config.ts / history.ts / metrics.ts / onboarding.ts`）
- 不動 adapter / OAuth 抽象、配置中心化、utils 重組
- 不引入 DI 容器、IoC、command/use-case
- 不引入 typed error class hierarchy（沿用現有 tagged result + `throw new Error`）
- 不重寫既有測試
- 不變更 API URL / JSON shape / HTTP status

## Context & Research

### Relevant Code and Patterns

**Service-layer convention（plain function exports）**
- `src/services/brand-profile.ts:192-228` — `getProfile(db)`, `saveProfile(db, input)`, `isReadyForDispatch(db)`：模板 service 形態
- `src/services/anchor-monitor.ts:1-16` — top-of-file JSDoc 名其關注點與權衡
- `src/services/roi-scorer.ts:75` — `getDaTierConfig(db)`：第一參數 `db: Database.Database`
- `src/services/credential-validator.ts:23-31` — **既存 envKeyMap，本次重構合併目標**
- `src/services/lint/index.ts` — sub-directory barrel 模板，admin/publish 子目錄沿用
- `src/services/queue/` — flat sub-directory（無 index.ts）也是合法選項

**現存薄 controller 模板（admin.ts 已有部分端點是好範例）**
- `src/routes/admin.ts:160-176` — GET/PUT `/api/v2/brand-profile`：3 行 handler 委派 service，遇 `{ ok: false, errors }` 轉 422
- `src/routes/admin.ts:178-186` — POST `/api/v2/precheck`：parse body → 驗 type → call service → res.json
- `src/routes/admin.ts:460-483` — GET `/api/v2/platform-health`：try/catch fail-soft fallback
- `src/routes/admin.ts:538-565` — PATCH `/api/v2/brand-profile/preferred-platforms`
- `src/routes/publish.ts:321-339` — POST `/api/v2/generate`：3 個 service call 編排

**待拆肥大 handler**
- `src/routes/admin.ts:188-257` — POST `/api/auth/browser` 70 行：含 `loginUrlMap`、檔案路徑構造、`setInterval` 清理、`context.on('close', ...)` 監聽
- `src/routes/admin.ts:333-457` — PATCH `/api/platforms/:platformId/api-key` 124 行：env 快照/還原 + 加密 + 直接 SQL UPDATE + adapter.testConnection
- `src/routes/admin.ts:582-661` — POST `/api/platforms/batch-validate` 78 行：與上一個 endpoint **重複** envKeyMap + 快照/還原邏輯
- `src/routes/publish.ts:23-70` — `runPublishingTask`：route 文件中的 module-level async function，操作 db.prepare + adapter.publish + appendToSheet
- `src/routes/publish.ts:72-108` — `processBulkQueue`：route 文件中的 module-level async function，跑 scrape → llm → publishService 串聯

**錯誤映射（不引入 typed errors）**
- `src/routes/_helpers.ts:7-27` — `asyncRoute` / `syncRoute` 將拋出的 Error 轉 500 + `{ error: error.message }`
- 既有路由的 status code 映射：400（body 缺 / 形狀錯）、403（browser automation 關閉）、404（adapter 不存在）、412（precondition：品牌資料未配）、422（驗證錯誤含 field list）、500（service 拋出未捕）
- `src/utils/errorHandler.ts` 存在但路由層沒在用，**本次重構也不啟用**

**測試模板**
- `src/services/__tests__/brand-profile.test.ts:1-18` — `freshDb()` helper + `applyV2Schema(db)`：service 級測試模板
- `src/services/__tests__/publish-service.test.ts:9-37` — `vi.mock('../../adapters', ...)` 模板
- `src/routes/__tests__/admin-platforms.test.ts:1-4` — supertest 整合測試，**280 個既存測試應原封不動通過**
- `vitest.config.ts:7-9` — include glob `src/**/__tests__/**/*.test.ts` 已涵蓋新建子目錄

**跨檔耦合須處理**
- `src/routes/publish.ts:14` `import { resolveTargetPlatforms } from './admin'` — 路由互相 import
- `src/routes/admin.ts:35` `export { getAdapterId, hasSavedBrowserSession }` — re-export
- 解法：把 `resolveTargetPlatforms` / `getDefaultPublishingPlatforms` / `isAdapterConnected` / `isDefaultPublishTarget` / `getPlatformStatus` 都搬到 `services/admin/platforms.ts`，由 `routes/admin.ts` 與 `routes/publish.ts` 同時引用此 service，**禁止 routes ↔ routes**

### Institutional Learnings

- `docs/plans/2026-05-05-001-refactor-code-quality-optimization-plan.md` Unit 9 — `_helpers.ts` 已抽好，**沿用不重做**
- 同 plan 載明 dependency rule：`routes → services → db → types`，禁反向
- 同 plan Unit 9 已記錄：每次拆檔後跑 `tsc --noEmit` 抓 cycle
- 同 plan Unit 9 提示：`vitest.config.ts` 的 coverage exclude 引用 `server.ts`，新加路徑要同步
- **無** `docs/solutions/` 目錄、無歷史路由重構回顧，本次不能依賴過往痛點記錄

### External References

未做外部研究 — 既有 codebase 模式充分（5+ 個薄 controller 範例、9+ 個 plain-function service、完整測試模板），不需 framework docs / best practices。

## Key Technical Decisions

- **Plain `export function` + tagged result**：與既有 9 個 service 一致；不引入 class、DI、typed error class（理由：既有模式覆蓋率高，新模式會造成兩套規範並存）
- **錯誤處理三層**：service 對「預期業務失敗」回 `{ ok: false, errors }`、對「設定/編程錯」`throw new Error(...)`；controller 解 tagged result 設 status code；`asyncRoute` 兜底 500（理由：既有 `brand-profile.ts` / `credential-validator.ts` / `publish-service.ts` 都這麼做）
- **service 內部 `db: Database.Database` 為第一參數**：與 `brand-profile.getProfile(db)`、`roi-scorer.getDaTierConfig(db)` 一致（理由：便於測試注入 `:memory:` DB）
- **每個 service 子目錄帶 `index.ts` barrel**：admin/index.ts 與 publish/index.ts 重新匯出主要函式（理由：mirror `services/lint/index.ts`，同時允許 routes 用 `import { ... } from '../services/admin'` 而不顯式知道內部結構）
- **`services/admin/platforms.ts` 為跨路由共用 hub**：`resolveTargetPlatforms` / `isAdapterConnected` / `getPlatformStatus` / `getDefaultPublishingPlatforms` 全搬入此檔，由 admin 與 publish routes 共用，消除 `routes/publish.ts → routes/admin.ts` 違規
- **`credential-store.ts` 合併 envKeyMap snapshot/restore**：把 `admin.ts:333-457`、`admin.ts:582-661` 與 `services/credential-validator.ts:15-48` 三處重複邏輯收進新 service 一個 helper，credential-validator.ts 改為依賴此 helper
- **service 測試用 `:memory:` SQLite + `applyV2Schema(db)`**：與既有 service 測試模板一致；只 mock adapter network calls (`vi.mock('../../adapters', ...)`)
- **v1 publish endpoints 保留不 deprecate**：`/api/publish`、`/api/auto-publish`、`/api/bulk-publish` 全部原樣搬進 `services/publish/dispatch.ts`，凍結契約；deprecate 策略留待後續 brainstorm
- **兩 PR 結構**：admin PR 引入 `services/admin/`，publish PR 引入 `services/publish/`；目錄獨立、互不干涉，但 admin PR 必須先合（因 publish service 依賴 `services/admin/platforms.ts` 做共用 hub）
- **不重寫測試**：既有 758 測試是契約一致性的 regression 護網；新增測試只在 service 層，不動既有

## Open Questions

### Resolved During Planning

- **Q（origin R2 衍生）：service 拋 typed error class 還是 `Result<T, E>`？** → 沿用 codebase 既有模式：tagged result（`{ ok: true, ... } | { ok: false, errors }`）對預期失敗、`throw new Error` 對設定錯。controller 解 tag 設 status code。
- **Q（origin R4-5 衍生）：service 跨域引用如何處理？** → 同域內（`admin/* → admin/*`）允許 sibling import。跨域共用搬到 flat `services/<shared>.ts`（如 `services/admin/platforms.ts` 為 admin 與 publish 共用 hub）。不引入事件 bus。
- **Q（origin R8-9 衍生）：service 單測 mock db 還是 `:memory:`？** → 一律 `:memory:` + `applyV2Schema(db)`，比照 `brand-profile.test.ts:14` 的 `freshDb()` helper。只 mock adapter network calls。
- **Q（origin R3 衍生）：v1 publish 端點是否仍被前端引用？** → 假設仍有引用、本次重構不 deprecate。所有 v1 邏輯原樣搬入 `services/publish/dispatch.ts`，HTTP shape 100% 凍結。
- **Q（origin R10 衍生）：兩 PR 之間 services/ 結構衝突？** → admin PR 引入 `services/admin/`、publish PR 引入 `services/publish/`，目錄獨立。**admin PR 必須先合**，因 `services/admin/platforms.ts` 是 publish service 的依賴。

### Deferred to Implementation

- 每個 service 內部 helper 函式的精確簽名：在實作時依使用點決定 export 形態
- routes 層 input validation（如 `body.name` 字串長度）放 controller 還是 service：以 service 為準（既有 `saveProfile` 在 service 內驗欄位）；controller 只擋型別/形狀不對
- `vitest.config.coverage.exclude` 是否需要同步更新：實作時跑一次 coverage 檢查 report 是否有空洞

## High-Level Technical Design

> *本節以結構樹示意拆分後的目錄與依賴流向，僅為審閱方向提示，不是實作規範。實作以 Implementation Units 為準。*

```
src/
├── routes/
│   ├── admin.ts          ← 重構後 < 80 行，純委派
│   └── publish.ts        ← 重構後 < 80 行，純委派
└── services/
    ├── admin/
    │   ├── index.ts          ← barrel 重新匯出公開 API
    │   ├── platforms.ts      ← /api/platforms + 共用 helpers（被 publish 引用）
    │   ├── brand.ts          ← /api/v2/brand-profile* + /precheck
    │   ├── browser-auth.ts   ← /api/auth/browser*
    │   ├── credential-store.ts  ← /platforms/:id/api-key + /batch-validate（合併 envKeyMap）
    │   └── roi-config.ts     ← /platform-health + /roi-config
    └── publish/
        ├── index.ts
        ├── generation.ts     ← v1 generate / generate-manual / generate-promo
        ├── dispatch.ts       ← v1 publish / auto-publish + runPublishingTask
        ├── bulk-queue.ts     ← bulk-publish + processBulkQueue（預先拆出，避免 dispatch.ts > 300 行）
        ├── v2-dispatch.ts    ← v2 generate / dispatch / dispatch-override / regenerate-variant
        └── batch-status.ts   ← batch-status + v2/queue


依賴流向（嚴格單向，禁止反向或環）

  routes/admin.ts ─┐                       ┌── services/admin/* ─┐
                  ├── services/admin/* ────┤                     │
  routes/publish.ts                        │                     ├── db / adapters / utils
                  └── services/publish/* ──┴── services/admin/platforms.ts
                                                   (跨域共用 hub)

  禁止：routes/publish.ts → routes/admin.ts（消除既有耦合）
  禁止：services/publish/* → services/admin/(非 platforms)
```

## Implementation Units ROI Ranking

實作前讀此區。如預算受限，按 ROI 由低往高砍，**Unit 3 為硬底線必做**。

| Unit | 內容 | ROI | 必做？ | 備註 |
|---|---|---|---|---|
| **Unit 3** | credential-store + envKeyMap dedup | **★★★★★** | **必做** | 唯一真正消除重複的單元。3 處 envKeyMap → 1 處，含安全強化 |
| Unit 4 | slim admin.ts | ★★★★ | 必做 | 完成 Unit 3 後 admin.ts 自然要收尾，否則 inline 程式碼與 service 並存 |
| Unit 7 | slim publish.ts | ★★★ | 高度建議 | 與 Unit 4 對稱；如 publish PR 預算緊可單獨延後 |
| Unit 6 | publish/dispatch + bulk-queue | ★★★ | 高度建議 | runPublishingTask + processBulkQueue characterization 提供額外安全網 |
| Unit 2 | services/admin/browser-auth | ★★ | 中等 | setInterval cleanup test 有實際價值；handler 70 行抽出值得 |
| Unit 5 | publish/v2-dispatch + batch-status | ★★ | 中等 | 既有 handler 已薄，純粹搬家 |
| Unit 1 | platforms / brand / roi-config | ★★ | 中等 | 既有 handler 已薄；platforms.ts 是 Unit 5/6 的依賴前提，至少要做 platforms 部分 |

**最小可行 PR 組合**：Unit 3 + Unit 4。如 publish PR 暫時擱置，admin PR 仍交付高 ROI 改進。

**最大覆蓋 PR 組合**：Unit 1-7 全做（plan 預設）。

## Implementation Units

- [ ] **Unit 1: Scaffold `services/admin/` + extract platforms / brand / roi-config services**

**Goal:** 建立 admin 子目錄與 barrel；先抽出三個低風險 service（既有 controller 已是薄形態），同時把跨路由共用的 platform helpers 集中到 `platforms.ts`，為後續 publish PR 鋪路。

**Requirements:** R4, R6, R7, R9

**Dependencies:** None

**Files:**
- Create: `src/services/admin/index.ts`
- Create: `src/services/admin/platforms.ts`（吸收 `routes/admin.ts:40-128` 所有 helpers + `getPlatformStatus` SQL 讀取邏輯）
- Create: `src/services/admin/brand.ts`（封裝 `routes/admin.ts:160-186` + 538-580 五個 endpoint 的業務邏輯，含 body 形狀驗證）
- Create: `src/services/admin/roi-config.ts`（封裝 `routes/admin.ts:460-535` 三個 endpoint 的業務邏輯，含 `VALID_TIER_SCORES` 常量驗證）
- Test: `src/services/admin/__tests__/platforms.test.ts`
- Test: `src/services/admin/__tests__/brand.test.ts`
- Test: `src/services/admin/__tests__/roi-config.test.ts`

**Approach:**
- 把 `API_CONNECTED` map、`hasStoredApiKey`、`isAdapterConnected`、`isDefaultPublishTarget`、`getPlatformStatus`、`getDefaultPublishingPlatforms`、`resolveTargetPlatforms` 全搬入 `platforms.ts`
- `routes/admin.ts:35` 的 `export { getAdapterId, hasSavedBrowserSession }` 改為從 `services/admin/index.ts` re-export，使 publish PR 能直接從 services 引用
- service 內部 `db: Database.Database` 一律作第一參數，對外維持既有回傳形狀（careful：`/api/platforms` 回應的每個 platform 物件 14 個欄位必須完全一致）

**Patterns to follow:**
- Service 形態 mirror `src/services/brand-profile.ts:192-228`
- JSDoc top block mirror `src/services/anchor-monitor.ts:1-16`
- Barrel mirror `src/services/lint/index.ts`
- Test 形態 mirror `src/services/__tests__/brand-profile.test.ts:1-18`（`freshDb()` + `applyV2Schema`）

**Test scenarios:**
- Happy path（platforms.ts）：`:memory:` DB 寫一筆 brand_profiles，呼叫 `getPlatformStatuses(db)` 返回每平台 14 個欄位都齊全且 type 正確
- Edge case（platforms.ts）：`api_keys_encrypted` 欄位為 null/空字串時，`hasStoredApiKey` 回 false 不拋錯
- Error path（brand.ts）：`saveBrandProfileFromInput(db, { name: '' })` 回 `{ ok: false, errors: [{ field: 'name', ... }] }`
- Happy path（brand.ts）：完整 profile 寫入後 `isReadyForDispatch(db).ready` 為 true
- Edge case（roi-config.ts）：tier_scores 含 0.5（非 `VALID_TIER_SCORES` 之一）時，`updateRoiConfig` 回 `{ ok: false, errors: [...] }`
- Happy path（roi-config.ts）：合法 tier scores 寫入後 `getDaTierConfig(db)` 反映新值

**Verification:**
- `tsc --noEmit` 無錯
- 三個新 service 的 sibling test file 全綠
- 758 既有測試 0 修改、全綠
- `routes/admin.ts` 暫時同時 import 新 service 並保留舊 inline 程式碼（待 Unit 4 切換）— 此單元仍未動 routes，只是新增 service 與測試

---

- [ ] **Unit 2: Extract `services/admin/browser-auth.ts`**

**Goal:** 把 `routes/admin.ts:188-331` 三個 browser-auth endpoint（70+ 行 handler）的業務邏輯搬入 service，含 setInterval 清理 / context.on('close') 監聽 / loginUrlMap / 檔案路徑構造。

**Requirements:** R1, R2, R4, R6, R7, R9

**Dependencies:** Unit 1（共用 `getAdapterId` re-export 路徑）

**Files:**
- Create: `src/services/admin/browser-auth.ts`
- Modify: `src/services/admin/index.ts`（加入 re-export）
- Test: `src/services/admin/__tests__/browser-auth.test.ts`

**Approach:**
- 把 `loginUrlMap` 與 `MIN_AUTH_COOKIES` 常量搬進 service
- service 暴露三個函式：`startBrowserLogin(adapter, loginUrl)`、`testBrowserSession(adapter)`、`getBrowserSessionStatus(adapter)`
- `setInterval` cookie 數監視器與 `context.on('close')` 事件留在 service（這是業務邏輯不是 HTTP 細節）
- 路由層只負責：解 body / 找 adapter / 委派 service / `res.json` 結果
- **安全閘門 invariant**：browser automation gating（`ENABLE_BROWSER_AUTOMATION !== 'true'` 時回 403）必須留在 controller 層，**且必須在任何 service 呼叫之前**。這是不可省略的前置條件，slim 過程中**不可移到 service** — 因為 service 是公開 export 可被任何 caller 觸達的；gate 必須擋在 HTTP 層

**Patterns to follow:**
- Tagged result mirror `src/services/credential-validator.ts:7-13` 的 `CredentialValidationResult`
- 對 `acquirePage` / `releasePage` 的呼叫保持原樣（`src/utils/browserManager.ts`）

**Test scenarios:**
- Happy path：`getBrowserSessionStatus(adapter)` 在 cookie ≥ 5 時回 `{ ok: true, cookieCount: N }`
- Edge case：cookie 不足 `MIN_AUTH_COOKIES` 時回 `{ ok: false, error: 'Insufficient cookies' }`
- Error path：`startBrowserLogin` 對未知 platform 回 `{ ok: false, error: 'Adapter not found' }`
- Integration scenario（resource cleanup）：mock `acquirePage` 拋錯時 service 應 catch 並回 tagged failure（不能讓 setInterval 殭屍存在）
- Integration scenario（setInterval cleanup）：`startBrowserLogin` 流程中 page close 後，內部 setInterval 必須被 clear（驗證方式：spy `clearInterval` 被呼叫）
- Contract regression（**不在此 unit 寫，依賴既有 supertest**）：`POST /api/auth/browser` 在 `ENABLE_BROWSER_AUTOMATION=false` 下必須回 403，**Unit 4 不准移除此 controller-level gate**

**Verification:**
- service 級單測全綠
- `tsc --noEmit` 無錯
- 既有 `routes/__tests__/admin-*.test.ts` 中觸及 `/api/auth/browser*` 的測試保持原樣通過（**未** 在此 Unit 修改 routes/admin.ts，service 暫時並存）

---

- [ ] **Unit 3: Extract `services/admin/credential-store.ts` + 合併 envKeyMap**

**Goal:** 把 `routes/admin.ts:333-457`（PATCH api-key, 124 行）+ `routes/admin.ts:582-661`（batch-validate, 78 行）+ `services/credential-validator.ts:15-48`（envKeyMap snapshot/restore）三處重複邏輯收斂。**本 plan 最高 ROI 的單一動作。**

**Requirements:** R1, R2, R4, R6, R7, R9

**Dependencies:** Unit 1

**Files:**
- Create: `src/services/admin/credential-store.ts`
- Modify: `src/services/credential-validator.ts`（改為呼叫 credential-store 的共用 helper，移除自己的 envKeyMap）
- Modify: `src/services/admin/index.ts`
- Test: `src/services/admin/__tests__/credential-store.test.ts`
- Modify: `src/services/__tests__/credential-validator.test.ts` 只在斷言行為不變的前提下，必要時調整 mock target — 不修改既有 expected outcome

**Approach:**
- 抽出共用 helper：`testCredentialAgainstAdapter(adapter, decryptedKey)` 內部做 env 快照 / 注入 / `adapter.testConnection()` / 還原（**try/finally 保證例外路徑也還原**）
- 暴露 service 函式：`updateApiKey(db, platformId, apiKey)`、`batchValidateApiKeys(db, keyMap)`
- 加密 / 解密呼叫 `src/utils/encryption.ts` 既有函式；解密後的 plaintext key 僅存在於該次 `testCredentialAgainstAdapter` 呼叫 scope，**不寫入任何 logger / Error.message / tagged result 物件**
- SQL `UPDATE brand_profiles SET api_keys_encrypted = ?` 從 controller 搬入 service
- `credential-validator.ts` 的 24h 後台任務改為 `import { testCredentialAgainstAdapter } from '../admin/credential-store'`

**Execution note:** 採 surgical change — 只共用 helper、不把整個 `credential-validator.ts` 吸收進 credential-store。如果實作時發現耦合過深需擴大範圍，停下來與 caller 對齊再繼續。

**Patterns to follow:**
- Tagged result（`{ ok, error?, tested_at }`）mirror `src/services/credential-validator.ts:7-13`
- Mock adapter mirror `src/services/__tests__/publish-service.test.ts:9-37`

**Test scenarios:**
- Happy path：`updateApiKey(db, 'devto', '<key>')` mock adapter.testConnection 回 ok 時，`brand_profiles.api_keys_encrypted` JSON 內含加密後的 devto key，回應含 `tested_at`
- Edge case：`batchValidateApiKeys` 同時驗 5 個 key，其中 2 個失敗，回應分別反映成敗、`platform_test_status` JSON 五個 key 都 update（並發行為一致）
- Error path：`testCredentialAgainstAdapter` 在 adapter 不存在於 envKeyMap 時回 `{ ok: false, error: 'Platform not supported for validation' }`
- Integration scenario（順序）：env 快照/還原 — 先後跑 devto + medium 後 `process.env.DEVTO_API_KEY` 應回到原值
- Security negative（plaintext leakage A）：`updateApiKey(db, 'devto', 'PLAIN_KEY_xyz')` 回應 JSON serialize 後不含 `'PLAIN_KEY_xyz'` 子字串
- Security negative（plaintext leakage B）：spy logger.info / warn / error，`updateApiKey` 全程 logger 呼叫參數 join 後不含 plaintext 子字串
- Security negative（DB plaintext）：寫入後讀 `brand_profiles.api_keys_encrypted` raw 字串不含 plaintext 子字串
- Security negative（throw still restores）：mock `adapter.testConnection` throw error，`testCredentialAgainstAdapter` 後 `process.env.DEVTO_API_KEY` 仍回到原值（try/finally 行為）
- Security negative（throw not leaking key）：mock adapter throw，回傳的 `{ ok: false, error }` 中 error.message 不含 plaintext 子字串

**Verification:**
- 三檔重複的 envKeyMap 縮減為一份
- `grep -n 'envKeyMap' src/routes/admin.ts` 無輸出（admin.ts 不再保留 envKeyMap inline）
- `grep -n 'envKeyMap' src/services/admin/credential-store.ts` 為唯一處（credential-validator.ts 從此 import）
- `tsc --noEmit` 無錯
- 既有 `credential-validator.test.ts` 0 修改通過
- service 新測試全綠（含 5 條 security-negative 斷言）

---

- [ ] **Unit 4: Slim `routes/admin.ts` to < 80 行 + 完成 admin PR**

**Goal:** 將 admin.ts 改為純薄 controller。每個 endpoint 變成「parse → 委派 → 映射」3-5 行，總行數 < 80。

**Requirements:** R1, R2, R3, R8, R10

**Dependencies:** Unit 1, 2, 3

**Files:**
- Modify: `src/routes/admin.ts`（662 行 → < 80 行）

**Approach:**
- 移除所有 helper function、SQL 直接呼叫、env 操作、setInterval、加密呼叫 — 全部已在 service 中
- 移除 8 行 import（從 `db / fs / browserManager / encryption / oauth-tokens / brand-profile / roi-scorer / browser-session / google-oauth / twitter-oauth / auth-strategy`）改為從 `../services/admin` barrel 一次取
- **`import '../services/twitter-oauth'` 副作用 import 處理**：經 grep 確認 `routes/auth.ts:14` 已有同一 side-effect import + `auth-strategy.ts:67-70` 對 double-register **會 throw**，故 `routes/admin.ts:27` 的此 import 是冗餘且潛在風險。Unit 4 **移除此 import**，並驗證 server 啟動順序仍能正常 register strategy（跑 `npm start` confirm 無 'AuthStrategy already registered' throw）。其他 OAuth strategy（google-oauth / wordpress-oauth / github-oauth）保留 — 它們只在 auth.ts 註冊
- **`routes/admin.ts:35` re-export 處理**：本 PR **暫時保留** `export { getAdapterId, hasSavedBrowserSession, resolveTargetPlatforms }` 一行作為 publish.ts 的相容墊片，避免 admin PR 合併瞬間打破 publish.ts:14 編譯。此墊片在 Unit 7 開始後的 publish PR 中清掉。**這不違反 R2** 因為 controller 只是 re-export，不直 import 業務 module
- 控制 `< 80 行` 目標：總行數 = 13 個 router 註冊 + 13 個閉合 + import block + side-effect comment + re-export 墊片 + handler 內容。每 endpoint handler 嚴守 ≤ 5 行（R1 細則）。實測若 ≥ 80 行則檢查 handler 是否藏業務邏輯，往 service 補齊
- 全部 endpoint controller 寫成統一形狀：
  ```
  router.<verb>('/path', wrapper(async (req, res) => {
    // 1. parse + early-return type errors with res.status(400/403)
    // 2. const result = await serviceFn(db, args)
    // 3. if (!result.ok) return res.status(<422|404|412>).json({ ... })
    // 4. res.json(...)
  }))
  ```
- 保留所有 13 個 router.* 註冊行、保留所有 status code（400/403/404/412/422/500）

**Execution note:** Run full vitest suite after each endpoint migration — fail fast on contract regressions.

**Patterns to follow:**
- 已是薄 controller 的 `routes/admin.ts:160-176` (brand-profile)、178-186 (precheck)、460-483 (platform-health)
- 整個檔案 mirror `src/routes/history.ts`（10 行）的精神

**Test scenarios:**
- N/A — 不新增測試。**Test expectation: 758 既有測試 0 修改全綠**（這是 R3/R8 的 regression 驗證，無新斷言要寫）

**Verification:**
- `wc -l src/routes/admin.ts` < 80
- `npm run test` 全部 758 測試通過
- `tsc --noEmit` 無錯
- `grep -E "import.*from.*'(\.\./db|\.\./utils|\.\./adapters)'" src/routes/admin.ts` 無輸出（除 logger 與 _helpers 外不直 import 業務 module）
- PR 可合併到 main

---

- [ ] **Unit 5: Scaffold `services/publish/` + extract v2-dispatch / batch-status**

**Goal:** 建立 publish 子目錄；先抽出兩個低風險 v2 service（current handler 已是薄形態，主要是搬移）。

**Requirements:** R5, R6, R7, R9

**Dependencies:** Unit 4（admin PR 已合，`services/admin/platforms.ts` 為 publish 可用）

**Files:**
- Create: `src/services/publish/index.ts`
- Create: `src/services/publish/v2-dispatch.ts`（封裝 `routes/publish.ts:321-450` 四個 endpoint：v2/generate, v2/dispatch, v2/dispatch/override, v2/regenerate-variant）
- Create: `src/services/publish/batch-status.ts`（封裝 `routes/publish.ts:144-159` + 407-424：batch-status 與 v2/queue）
- Test: `src/services/publish/__tests__/v2-dispatch.test.ts`
- Test: `src/services/publish/__tests__/batch-status.test.ts`

**Approach:**
- v2 endpoints 已大量委派 `services/variant-generator`、`services/anchor-generator`、`services/lint`、`services/queue/scheduler`，service 主要負責編排
- `regenerate-variant` 端點原 inline merge 邏輯（`routes/publish.ts:425-451`）搬入 service
- 跨域共用 hub：`resolveTargetPlatforms` 等共用 helper 已在 admin PR 移到 `services/admin/platforms.ts`。**publish service 一律 `import { ... } from '../admin/platforms'`**，建立 `services/publish → services/admin/platforms` 單向依賴；同時 Unit 7 移除 `routes/publish.ts:14 → routes/admin` 這條 routes ↔ routes 違規路徑

**Patterns to follow:**
- Orchestration service mirror `src/services/publish-service.ts:39`（multi-adapter loop）
- Test scaffolding mirror `src/services/__tests__/publish-service.test.ts:9-37`

**Test scenarios:**
- Happy path（v2-dispatch）：mock variant generator + scheduler，`runV2Generate(db, ...)` 入隊預期數量的 jobs
- Edge case（v2-dispatch）：所有 variant 都被 ROI 篩除時回 `{ ok: false, error: ... }` 而非 throw
- Happy path（batch-status）：寫入 `publish_jobs` 5 行不同 status，`getBatchStatus(db, batchId)` 統計正確
- Edge case（batch-status）：未知 batchId 回 `{ jobs: [], totals: {...0} }` 而非 404

**Verification:**
- `tsc --noEmit` 無錯
- service 新測試全綠
- 758 既有測試 0 修改、全綠（routes 暫時同時 import 新 service + 保留舊 inline，待 Unit 7 切換）

---

- [ ] **Unit 6: Extract `services/publish/generation.ts` + `services/publish/dispatch.ts`**

**Goal:** 把 v1 端點業務邏輯（含 `runPublishingTask` 與 `processBulkQueue` 兩個 module-level async function）搬入 service。

**Requirements:** R5, R6, R7, R9

**Dependencies:** Unit 5

**Files:**
- Create: `src/services/publish/generation.ts`（封裝 `routes/publish.ts:110-142` 三個 generate endpoint 的業務邏輯）
- Create: `src/services/publish/dispatch.ts`（封裝 `routes/publish.ts:23-70` `runPublishingTask`，以及 161-258 兩個 endpoint：v1 publish + auto-publish）
- Create: `src/services/publish/bulk-queue.ts`（封裝 `routes/publish.ts:72-108` `processBulkQueue`，以及 260-319 一個 endpoint：bulk-publish；**預先拆分**避免 dispatch.ts > 300 行）
- Test: `src/services/publish/__tests__/generation.test.ts`
- Test: `src/services/publish/__tests__/dispatch.test.ts`
- Test: `src/services/publish/__tests__/bulk-queue.test.ts`

**Approach:**
- `dispatch.ts` 暴露：`startSinglePublish(db, options)`、`startAutoPublish(db, options)`，內部共用 `runPublishingTask(batchId, options, db)` helper（從 routes 搬移）
- `bulk-queue.ts` 暴露：`startBulkPublish(db, urls, platforms, status)`，內部用 `processBulkQueue` helper（從 routes 搬移）
- `dispatch.ts` 與 `bulk-queue.ts` 都從 `services/publish/dispatch.ts` 共用 `runPublishingTask`（bulk-queue.ts → dispatch.ts 單向引用，不互引）
- `appendToSheet` 與 `savePost` 呼叫保持原樣
- generation.ts 委派至 `src/scraper`、`src/llm` 與既有 `generateMarkdown` / `generatePromoMarkdown`

**Execution note:** Add characterization tests around `runPublishingTask` happy path before moving — this is async multi-step logic with sleeps and DB mutations, easy to break silently.

**Patterns to follow:**
- Async background task mirror `src/services/queue/publish-worker.ts:1-50`
- Mock adapters + db mirror `src/services/__tests__/publish-service.test.ts`

**Test scenarios:**
- Happy path（generation）：mock LLM 回 `{ title, content, tags }`，`runGenerate(scrapedData)` 回 markdown 結構正確
- Error path（generation）：scrapedData 缺 `title` 時回 `{ ok: false, error }`
- **Characterization（dispatch）— job state machine**：mock 2 個 adapter 都成功，`runPublishingTask(batchId, opts, db)` 完成後 `publish_jobs` 兩行 status 為 `succeeded`，且狀態變遷順序為 `scheduled → running → succeeded`（spy `markRunning` / `markSucceededWithUrl` 呼叫順序）
- **Characterization（dispatch）— partial failure isolation**：mock adapter[0] throw，adapter[1] 成功；run 完後 job[0] = `failed`、job[1] = `succeeded`，**且 loop 沒有 abort**
- **Characterization（dispatch）— sheet side-effect once**：成功路徑 `appendToSheet` 恰被呼叫 1 次，含正確的 formattedResults 結構
- **Characterization（dispatch）— sheet failure not blocking**：mock `appendToSheet` reject，後續 `savePost` 仍應執行（fire-and-forget 契約）
- Edge case（dispatch）：0 jobs in batch 時 `runPublishingTask` 直接返回，不嘗試任何 adapter / sheet 呼叫
- **Characterization（bulk-queue）— inter-step error isolation**：`processBulkQueue` 跑 3 個 url，第 2 個 scrape throw 時 url 1 與 url 3 仍正常 publish，logger.error 被呼叫 1 次
- Edge case（bulk-queue）：`startBulkPublish` 上傳空 url 列表時回 `{ ok: false, error: 'No URLs provided' }`

**Verification:**
- `tsc --noEmit` 無錯
- service 新測試全綠（含 generation / dispatch / bulk-queue 三組）
- 758 既有測試 0 修改、全綠
- `wc -l src/services/publish/*.ts` 每檔 < 300 行

---

- [ ] **Unit 7: Slim `routes/publish.ts` to < 80 行 + 完成 publish PR**

**Goal:** publish.ts 改為純薄 controller，總行數 < 80，每個 endpoint 3-5 行。

**Requirements:** R1, R2, R3, R5, R8, R10

**Dependencies:** Unit 5, 6

**Files:**
- Modify: `src/routes/publish.ts`（451 行 → < 80 行）

**Approach:**
- 移除 `runPublishingTask`、`processBulkQueue` 兩個 module-level function
- 移除 `import { resolveTargetPlatforms } from './admin'`，改為 `from '../services/admin'`（barrel）
- 12 個 endpoint 全改為「parse → 委派 → 映射」3-5 行
- 保留 multer upload middleware 註冊行（這是 HTTP 層合理）
- 保留所有 status code 與 JSON shape

**Execution note:** Run full vitest after migrating each endpoint — particularly v1 publish/auto-publish/bulk-publish are the largest behavioral surfaces.

**Patterns to follow:**
- 已是薄 controller 的 `routes/publish.ts:321-339` (v2/generate)、341-380 (v2/dispatch)
- Same shape as `routes/admin.ts` 重構後形態（Unit 4）

**Test scenarios:**
- N/A — **Test expectation: 758 既有測試 0 修改全綠**

**Verification:**
- `wc -l src/routes/publish.ts` < 80
- `npm run test` 758 測試全綠
- `tsc --noEmit` 無錯
- `grep -E "import.*from.*'(\.\./db|\.\./scraper|\.\./llm|\.\./adapters|\.\./sheets)'" src/routes/publish.ts` 無輸出
- `grep "from './admin'" src/routes/publish.ts` 無輸出（routes ↔ routes 耦合已消）
- PR 可合併到 main

## System-Wide Impact

- **Interaction graph：**
  - `routes/admin.ts` 失去對 `db / fs / encryption / browserManager / oauth-tokens` 的直接 import（皆透過 service 中介）
  - `routes/publish.ts` 失去對 `db / scraper / llm / adapters / sheets / db/repositories` 的直接 import
  - `routes/publish.ts → routes/admin.ts` 跨路由 import 消除（改 → `services/admin/platforms.ts`）
  - `services/credential-validator.ts` 改為依賴 `services/admin/credential-store.ts` 共用 helper
  - 路由層 side-effect import `import '../services/twitter-oauth'` 保留 — strategy registry 不變

- **Error propagation：** service 內部維持 tagged result + plain throw 模式；所有未捕例外仍由 `_helpers.ts` 兜底為 HTTP 500，status code 映射規則不變

- **State lifecycle risks：**
  - `services/admin/browser-auth.ts` 內的 setInterval / context.on('close') 須 ensure cleanup 路徑與原 controller 等價（不引入殭屍 interval）
  - `services/admin/credential-store.ts` 的 env 快照/還原仍是 process.env mutate；並發呼叫的順序語義不變
  - `services/publish/dispatch.ts` 的 `runPublishingTask` async loop 對 `publish_jobs` 表的 markRunning/markFailed/markSucceededWithUrl 保留原順序，避免出現殭屍 'running' 行

- **API surface parity：** API URL / method / JSON shape / status code 完全不變。所有現有 supertest integration test 是 contract regression 護網。**前端 / SDK / 文件不需更新**

- **Integration coverage：** 758 既有測試覆蓋 routes 整合層；service 級新測 ~25-30 個 happy + 錯誤路徑 + security-negative 單測（credential-store 額外含 5 條負向斷言）。**已知盲區**：supertest 看不到 async 背景行為（runPublishingTask 任務狀態機、processBulkQueue 跨 url 隔離、setInterval cleanup）— 已在 Unit 2 (browser-auth setInterval cleanup)、Unit 3 (try/finally throw path)、Unit 6 (runPublishingTask + processBulkQueue characterization) 顯式補上對應 service 級 test。Cross-layer scenarios（如 PATCH api-key → /api/platforms 反映新狀態）由既存 supertest 測試守護

- **Unchanged invariants：**
  - API 契約凍結（URL / method / JSON shape / status code）
  - `asyncRoute` / `syncRoute` 包裝不動
  - `services/queue/*` scheduler 不動
  - `db/repositories.ts` 不動
  - 其餘 5 個 routes 不動（auth / config / history / metrics / onboarding）
  - `adapters/*` 不動
  - `utils/errorHandler.ts` 不啟用
  - **Security gate：`POST/GET /api/auth/browser*` 在 `ENABLE_BROWSER_AUTOMATION !== 'true'` 時必須回 403，gate 留在 controller 層**
  - **Security invariant：plaintext API key 不出現在 (a) 加密 column 以外的 DB 欄位、(b) HTTP response body、(c) logger.* 任何呼叫參數、(d) Error.message / tagged result error 欄位**
  - **Security invariant：OAuth strategy registry 在 server 啟動完成時必須含 `twitter / google / wordpress / github` 四個 provider（auth.ts 副作用 import 集中註冊）**

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| 重構過程把某 endpoint 的 status code 改錯（如把 412 變 400）導致前端壞 | Unit 4 / 7 完成前必須跑全套 280+ supertest，任一 status assertion fail 視為 P0 不合 |
| `runPublishingTask` 的 async 行為（sleep / job state machine）在搬移時被破壞 | Unit 6 加 characterization test 鎖住 happy path 與 partial-failure 行為，再動程式碼 |
| `services/credential-validator.ts` 與 `services/admin/credential-store.ts` 互引 cycle | service 層約束：credential-validator 單向 import credential-store；後者不引前者；用 `tsc --noEmit` 驗證 |
| `routes/admin.ts:35` re-export 移除導致下游引用 break（publish.ts 既有引用為已知，可能還有其他） | Unit 1 完成後 `grep -rn "from.*routes/admin" src` 全文掃，把所有 caller 都改指向 `services/admin/index.ts` |
| 兩 PR 並行開發出 conflict | 強制 admin PR 先合再開 publish PR；`services/admin/` 與 `services/publish/` 目錄獨立、不共享文件 |
| 拆完每個 service 仍 > 300 行（R6 違反） | Unit 5 / 6 完成後 `wc -l services/admin/* services/publish/*`；超過 300 的拆出 sub-helper（如 `dispatch.ts → bulk-queue.ts`） |
| `vitest.config.ts` coverage exclude 沒同步、coverage 報表出現空洞 | Unit 4 / 7 PR 前跑一次 `npm run test:coverage` 比對 baseline |
| OAuth strategy registry 註冊遺失（admin.ts:27 `import '../services/twitter-oauth'` 與 auth.ts:14 重複） | grep 已確認 auth.ts 是 canonical 註冊點；Unit 4 移除 admin.ts:27 並啟動驗證 strategy registry 仍含 4 provider；加 service 級 test `expect(getStrategyByAdapter('Twitter')).toBeDefined()` 防回歸 |
| credential-store env mutation 在並發 / vitest threads pool 下洩漏 process.env | (1) Unit 3 加 5 條 security-negative 測試含 try/finally 還原；(2) try/finally 強制即使 throw 也還原；(3) 評估 `vitest.config.ts` 為 credential-store 測試加 `sequence.concurrent: false` 避免 worker thread 互踩；(4) 中長期考慮把 helper 改為 `withEnv(envMap, fn)` arg-pass 模式（記錄為 Future Considerations） |
| Unit 4 移除 admin.ts re-export 後 publish.ts:14 編譯壞 | Unit 4 暫時保留 re-export 為相容墊片（admin PR 期間），Unit 7 統一清理；admin PR pre-merge 跑 `tsc --noEmit` 驗證 publish.ts 仍可編譯 |

## Documentation / Operational Notes

- 兩 PR 各自的 PR body 列出 endpoint contract diff（應為空）
- README 不需更新（API 不變）
- 若 `vitest.config.ts` 的 coverage exclude 引用了 `routes/admin.ts` 或 `routes/publish.ts` 的特定 line range，需同步調整（執行時檢查）
- 不需要 monitoring / alerting 變更
- 不需要 migration / rollout flag

## Revert Playbook

如本 refactor 在合併後出現 regression，依下表操作。每個 unit 的回滾範圍與連鎖影響顯式列出。

| 場景 | Revert 動作 | 連鎖影響 / 注意事項 |
|---|---|---|
| admin PR 合併後當天即發現 regression | `git revert <admin PR merge sha>` | 所有 admin/* service + admin.ts 改寫 + credential-validator.ts 改 import 全部還原。**publish.ts:14 仍 import from `./admin`，編譯不破**（因為 Unit 4 保留了相容墊片） |
| admin PR 合併後 ≥ 1 天，期間又有其他 commit | `git revert <admin PR merge sha>`，再手動 rebase 後續 commit | 看後續 commit 是否觸動 admin.ts 或新 service；若有，產生 conflict 須手解 |
| publish PR 已合，事後發現 admin PR 有 bug | 不能單純 revert admin PR — publish.ts 已 import 自 `services/admin`。先 `git revert <publish PR>`（恢復 publish.ts:14 → routes/admin），再 `git revert <admin PR>` | 順序很重要。若 publish.ts 已用新 hub，admin.ts re-export 墊片移除過，須先補回 |
| publish PR 合併後發現 dispatch.ts 行為偏差 | `git revert <publish PR merge sha>` | 只回滾 publish 範圍。admin/* 不受影響 |
| 只想回滾 Unit 3（credential-store） | 不能單獨 revert：credential-validator.ts 已改為 import credential-store。需同時 revert `services/credential-validator.ts` 對應 commit 並還原舊 envKeyMap | 這是 Unit 3 與 credential-validator 不對稱依賴造成；**短期 tradeoff**，若想徹底消除可在 Unit 3 加 feature flag（增工 2-4h）|
| Unit 6 dispatch.ts/bulk-queue.ts 出現 async race | `git revert <publish PR>`；同時跑 `npm run test -- src/routes/__tests__/dispatch.test.ts` 確認舊 supertest 仍綠 | dispatch.ts 與 bulk-queue.ts 都依賴 `runPublishingTask`，revert 一個會牽動另一個 |
| 想保留新 service 但修一個 endpoint 行為 | 不要 revert PR — 直接在新 service 改一行修 | 這是新架構的長處：bug 應該定位到具體 service，不需要回滾 |

**事前準備**：admin PR 合併前在另一分支跑一次 dry-run revert 驗證 `publish.ts` 仍可編譯（補強 R3）。

## Future Considerations

以下為已知有價值但**不在本 plan 範圍**的後續工作。明確記錄避免「以後再說」變永久延後。

- **`repositories.ts` 拆分** — 643 行 / 8 entity 的 SRP 違反，比 admin.ts 嚴重。**已決定送入 brainstorm queue**：本 plan 兩 PR 合併後，立即跑 `/ce:brainstorm` 啟動 repositories per-entity 拆分討論。觸發條件：admin PR + publish PR 都合
- **`withEnv(envMap, fn)` arg-pass 模式** — credential-store 的 process.env mutation 在並發下不安全。本 plan 用 try/finally + 5 條 security-negative test 緩解，但根本解是改 `adapter.testConnection(opts)` 接受可選 key 參數、由各 adapter 內部讀參數而不讀 env。觸發條件：未來新增的 adapter 不再依賴 env，或現有 envKeyMap 拓展到 9+ 平台時。預估工期 6-10h，9 個 adapter 接口改動
- **服務級錯誤類型化（typed error class）** — 本 plan 沿用 tagged result + plain throw 模式。當 service 數量再增（例如 routes 全面拆分後），驗證控制器層 `if (!result.ok)` 樣板可能達 30+ 行，屆時 `class ServiceError { status, code, message, fields }` + `asyncRoute` 自動映射可能值得引入。觸發條件：服務級 tagged-result 處理樣板總計 > 30 行，且加新 service 重複此樣板
- **OAuth strategy registry 自動註冊測試** — 本 plan 用 invariant + 啟動驗證 + service 級 test 緩解 side-effect import 漂移風險。理想是寫一個 build-time / startup-time assertion 列出所有 strategy provider 並驗證齊全。觸發條件：第 5 個 OAuth provider 加入時

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-07-route-refactor-thin-controller-requirements.md](../brainstorms/2026-05-07-route-refactor-thin-controller-requirements.md)
- Related plan: [docs/plans/2026-05-05-001-refactor-code-quality-optimization-plan.md](2026-05-05-001-refactor-code-quality-optimization-plan.md) Unit 9（asyncRoute/syncRoute 抽出來源、coverage exclude 注意事項、dependency rule）
- Existing thin-controller examples: `src/routes/admin.ts:160-186, 460-483, 538-565`、`src/routes/publish.ts:321-339`
- Service template: `src/services/brand-profile.ts:192-228`
- Test template: `src/services/__tests__/brand-profile.test.ts:1-18`
- Highest-value dedup target: `src/services/credential-validator.ts:23-31` + `src/routes/admin.ts:333-457, 582-661`
