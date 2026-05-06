# Changelog

## v0.2.1 — 2026-05-05 (渠道綁定串接 + 主入口設置可交互)

### Added — 主入口「系統設置」可交互（plan 003）
- `index.html` 的 settings view 從只讀 grid 改為 4-section 折疊面板：
  - **LLM 與基礎**：Gemini/OpenAI key 即時驗證 + 模型動態下拉
  - **分發平台 (7)**：inline key 配置 + 單測試 + 全部測試 + 連接狀態徽章（含 last_test_error / test_timestamp）
  - **瀏覽器自動化**：開關 + 3 種模式（chromium / chrome-isolated / chrome-profile）+ ZIP 批量導入 + 逐個登入/測試
  - **Google Sheets**：Sheet ID + Service Account JSON 配置
- 側欄 footer 新增「⚙ 高級管理 ↗」深鏈到 `/admin.html`，保留進階管理頁面
- 任一保存動作自動刷新「品牌資料就緒」徽章（plan R5）
- 切換離開 settings view 時清除殘留 toast，避免返回看到過期訊息

### Added — 流程化多渠道綁定向導（plan 002 後續）
- `feat(adapters)`: testConnection() 統一接口（7 個 API + 浏览器平台）
- `feat(auth)`: `POST /api/auth/import-sessions` ZIP 批量會話導入
- `feat(admin)`: `PATCH /api/platforms/:id/api-key` 加密入庫 + 即時驗證
- `feat(onboarding)`: 新用戶 4 步引導（品牌 → API → 瀏覽器 → 首選）
- `feat`: 24h 後台 credential validator
- `feat`: 渠道診斷 + 失敗批次列表 + 一鍵修復入口

### Fixed
- `publish-worker` 在冪等跳過和 MVP_PLATFORMS 跳過路徑沒有調用 `markSucceededWithUrl/markSkipped`
  → 任務卡在 `running`，現補上終態標記
- `syncSideEffects` 補上 `posts.platform` / `posts.published_url` 兩列，配合 `idx_posts_batch_variant_platform` 唯一索引正確 ON CONFLICT
- `handleReconciliation` 之前把 `p.original_url` 當 published_url
  → Sheets 收到品牌目標 URL 而非實際發布 URL，現改 select `published_url` 並按 (batch_id, platform) join

### Changed — 代碼質量
- `TestConnectionResult` 移到 `src/types/index.ts` 集中聲明
- `BaseAdapter.testConnection()` 從 abstract 改為可選；所有調用點用 `adapter.testConnection?.()`
- 全項目 sqlite `db.prepare(...).get()` 加 `as { ... } | undefined` 類型斷言
- `unzipper` 從 ESM import 改為 `require()` cast，消除 CJS interop 構建錯誤
- 10 項性能優化（詳見 `OPTIMIZATION_SUMMARY.md`）

### Docs
- `CHANNEL_SETUP_GUIDE.md` — 完整渠道配置與診斷指南
- `OPTIMIZATION_SUMMARY.md` — 10 項優化說明 + 基準腳本
- `docs/plans/2026-05-05-002-feat-streamlined-distribution-channel-binding-plan.md`
- `docs/plans/2026-05-05-003-fix-settings-config-ui-clickable-plan.md`

### Tests
- 280/280 vitest 通過（新增 `auth.test.ts`, `admin-platforms.test.ts`, `credential-validator.test.ts` 等覆蓋）

---

## v0.2.0 — 2026-05-05 (第三方口吻外鏈分發工具)

### 全新功能

**核心發布流水線**
- `POST /api/v2/generate` — 一次草稿輸入，並發生成 7 個平台變體（tech_blogger / personal_essay / reviewer 人設組，concurrency=3）
- `POST /api/v2/dispatch` — 將通過 lint 的變體批量加入 publish_jobs 隊列
- `POST /api/v2/regenerate-variant` — 單 tab 重新生成（預覽頁重生按鈕）
- `GET /api/v2/queue` — 隊列狀態查詢（前端每 5 秒輪詢）

**品牌資料庫**
- `GET/PUT /api/v2/brand-profile` — 品牌名、目標 URL、身份暴露禁用詞、錨詞黑名單
- R3 前置閘：品牌資料不完整時阻斷發布流程

**內容生成引擎**
- 變體生成器（Unit 5）：7 平台並發，`runParallel(concurrency=3)`，單平台失敗不中斷整批
- 錨詞生成器（Unit 6）：每變體獨立 mini-prompt，禁用詞校驗，3 次重試，`__naked_url__` fallback
- Lint 管道（Unit 7）：5-gram Jaccard 雙變體相似度閘（threshold=0.5）+ 身份暴露詞 regex 閘

**作業調度與執行**
- SQLite 隊列調度器（Unit 9）：2 秒 tick，殭屍清理，`registerHandler` 插件架構
- 發布 Worker（Unit 10）：冪等保護、平台白名單、單次調用不重試、成功後入隊 3 條存活檢查作業
- 錨詞分布監控（Unit 11）：30% 集中度告警、滑動 7 天周上限

**存活追踪**
- 存活 Worker（Unit 13）：T+24h / T+7d / T+30d HEAD/GET 存活分類（alive / redirect_alive / 404 / 410 / timeout / unknown）
- 日終 Digest 推送（Unit 13）：每日 18:00，支援 Telegram / Email / none 通道
- Google Sheets 存活欄回填：`updateLiveness(batchId, platform, column, value)`

**Sheets 視圖**
- Posts sheet 12 欄標準格式（Unit 12）
- Aggregates sheet 每日 04:00 刷新
- Reconciliation drift 補行 04:30

**前端 UI（Unit 8）**
- Alpine.js SPA，零構建步驟
- 草稿輸入頁：字數計數（最少 600 非空白字元）、目標 URL 下拉
- 7-tab 變體預覽：persona 色塊標識、markdown 渲染、lint 警告橫幅
- 一鍵發布：batchViolation 時禁用、跳過 tab 自動移除
- 佇列狀態頁：即時狀態顏色、5 秒輪詢

### 代碼品質改進（v0.2 同期重構）
- Server.ts 從 893 行拆分為 5 個路由模塊（≤23 行主文件）
- LLM 客戶端單例化（`getOpenAIClient()` / `getGeminiClient()`）+ settings 更新時自動失效
- `parallel.ts` fail-fast 修復：返回 `{ok, value, error}[]`，單失敗不中斷整批
- Browser semaphore：`acquirePage()` 攔截全部 4 個 `context.newPage()` 調用
- Sheets TokenBucket 單例（避免多路由各自計限流）
- `markitdown` 改用 `execFile`（消除 shell 注入風險），加 30s 超時保護
- 類型統一：`src/types/index.ts` 為唯一聲明來源

### 測試
- 從 136 → 210 個測試用例（+74 個）
- 覆蓋：variant-generator、anchor-generator、publish-worker、liveness-worker、digest-job、parallel.ts、smartRetry、LLM 模塊

---

## v0.1.0 — 2026-04-01 (初始 MVP)

- URL 爬取 → LLM 重寫 → 順序發布（Dev.to / Telegra.ph / Medium）
- Google Sheets 日誌（3 欄）
- Playwright + Readability 抓取
- 基礎 Express 服務器

---

_詳細提交歷史見 `git log --oneline`_
