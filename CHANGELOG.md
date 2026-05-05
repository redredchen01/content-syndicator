# Changelog

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
