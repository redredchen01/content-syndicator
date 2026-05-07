---
date: 2026-05-07
topic: route-refactor-thin-controller
---

# admin.ts / publish.ts 薄 controller 重構

## Problem Frame

連續 5 個 PR 都在加 OAuth 與安全修補，`src/routes/admin.ts` 已到 662 行 / 16 import，`src/routes/publish.ts` 到 451 行 / 23 import。兩個文件各自承擔 5 個關注點：

- **admin.ts**：平台連接狀態、品牌資料、瀏覽器認證、API key 管理、ROI/健康度配置
- **publish.ts**：v1 生成、v1 發布、批量發布、v2 dispatch、queue 查詢

下一波加平台或加功能時這兩個文件會繼續膨脹（admin 預期破 800、publish 破 600）、業務邏輯與 HTTP 解析交織導致無法做 service 級單測，並且新人需要把整個 600+ 行讀完才能改一個端點。

## Architecture

```
┌──────────────────────────────────────────────────┐
│ HTTP layer  (薄 controller, < 80 行)              │
│  routes/admin.ts        routes/publish.ts        │
│   • req parse / res     • req parse / res        │
│   • 委派給 service      • 委派給 service          │
└──────────────┬─────────────────┬─────────────────┘
               │                 │
               ▼                 ▼
┌──────────────────────────────────────────────────┐
│ Service layer  (per-domain, < 300 行)            │
│  services/admin/                                 │
│    platforms.ts      ← /api/platforms            │
│    brand.ts          ← brand-profile / preferred │
│    browser-auth.ts   ← /api/auth/browser*        │
│    api-keys.ts       ← /platforms/:id/api-key    │
│    roi-config.ts     ← /platform-health, /roi-*  │
│  services/publish/                               │
│    generation.ts     ← v1 generate*              │
│    dispatch.ts       ← v1 publish + bulk + auto  │
│    v2-dispatch.ts    ← v2 generate/dispatch/regen│
│    batch-status.ts   ← batch-status, v2/queue    │
└──────────────┬───────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────┐
│ Existing repos / db / adapters  (本期不動)        │
│  db/repositories.ts (643 行 — 留待後續)          │
└──────────────────────────────────────────────────┘
```

## Requirements

**HTTP Layer 形態**
- R1. `routes/admin.ts` 與 `routes/publish.ts` 重構後僅保留 router 註冊、HTTP 解析、委派 service、錯誤映射，每個文件 < 80 行
- R2. controller 不直接 import `db`、`fs`、`logger` 業務細節；只 import 對應 service 與 `_helpers`
- R3. 所有 endpoint 的 URL、HTTP method、request/response JSON shape 完全不變（API 契約凍結）

**Service 模組組織**
- R4. admin.ts 拆為 5 個 service：`services/admin/{platforms,brand,browser-auth,api-keys,roi-config}.ts`，按上方 Architecture 中列出的端點分組
- R5. publish.ts 拆為 4 個 service：`services/publish/{generation,dispatch,v2-dispatch,batch-status}.ts`
- R6. 每個 service 文件 < 300 行；超過則需要在 plan 階段重新切分子模組
- R7. service 用 plain `export function` 組織（非 class、非 DI 容器）

**測試**
- R8. 現有 280+ 測試全部保持通過，且不修改任何測試文件斷言（測試是契約一致性的證據）
- R9. 新增 service 層單測：每個 service 至少覆蓋一個 happy path 與一個錯誤路徑

**節奏與風險控制**
- R10. 一個 PR 拆 admin.ts，獨立合併後再開 publish.ts 的 PR；兩個 PR 都不混入功能新增

## Success Criteria

- 重構後在 `admin.ts` / `publish.ts` 任意端點上加新功能，diff 不會跨域名混進 5 個關注點
- 任一 service 可以脫離 Express 跑單元測試（不需 supertest / app context）
- 新人 onboarding 找到「品牌資料更新邏輯」應 < 30 秒（直接打開 `services/admin/brand.ts`）
- 兩個 PR 各自 diff < 800 行（含新增測試），方便 code review

## Scope Boundaries

- **不動**：`db/repositories.ts` 拆分（643 行 → per-entity 留待下一輪 brainstorm）
- **不動**：其餘 5 個路由檔（auth.ts、config.ts、history.ts、metrics.ts、onboarding.ts）
- **不動**：API URL、JSON shape、HTTP status code（凍結契約）
- **不動**：adapter / OAuth 抽象、配置中心化、utils god-package（並列存在的架構債，本期不處理）
- **不引入**：DI 容器、依賴反轉、IoC、command/use-case 模式
- **不重寫**：現有測試（保持斷言不變）

## Key Decisions

- **拆分粒度按關注點而非 endpoint**：5 個 service 對應 5 個業務域，避免「一個 endpoint 一個 service」變成虛胖
- **薄 controller 而非 sub-router**：sub-router 只解決文件膨脹但業務仍不可單測；薄 controller 一次性把可測性與膨脹都解決
- **plain function 不用 class**：保持 Node 手感、不引入 DI 複雜度，符合現有 codebase 風格
- **API 契約凍結**：避免重構引入功能性回歸；所有現有測試是回歸護網
- **增量兩個 PR**：admin / publish 邏輯耦合度低，分批合併降低衝突與風險

## Dependencies / Assumptions

- 假設現有 `_helpers.ts` 中的 `asyncRoute` / `syncRoute` 包裝可繼續用於控制器層
- 假設 `services/brand-profile.ts`、`services/roi-scorer.ts` 等已存在的 service 與新建的 admin services 命名空間不衝突（admin 子目錄解決）
- 假設 vitest 測試環境支持 service 級單測（不需要新引入測試框架）

## Outstanding Questions

### Resolve Before Planning

無 — 所有產品決策已收斂。

### Deferred to Planning

- [Affects R2][Technical] 錯誤處理規範：service 層拋 typed error class（如 `ValidationError`、`NotFoundError`），controller 統一映射 HTTP status 碼？或是 service 直接返回 `Result<T, E>` 結構？
- [Affects R4-R5][Technical] service 內部跨域引用怎麼處理？例如 `api-keys` service 觸發後可能要刷新 `platforms` 的快取。直接互相 import 還是透過事件 / 顯式 contract？
- [Affects R8-R9][Technical] service 單測要不要 mock `db`，還是用 `:memory:` SQLite？現有測試混合使用，需在 plan 中定基準
- [Affects R3][Needs research] `publish.ts` 的 v1 端點（`/api/publish`、`/api/auto-publish`、`/api/bulk-publish`）是否仍被前端引用，還是 v2 完全替代？影響重構時是否能一次抽乾 v1 邏輯
- [Affects R10][Technical] 兩個 PR 之間 `services/` 資料夾結構需先協調，避免 admin PR 引入的子目錄與 publish PR 衝突

## Next Steps

→ `/ce:plan` 進入結構化實作計畫階段
