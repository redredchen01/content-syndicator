# Multi-Platform Content Syndicator Agent (v0.2)

**第三方口吻外鏈分發工具** — 編輯粘貼草稿，系統生成 7 個平台差異化變體，自動 lint 審查，一鍵批量發布，T+24h/T+7d/T+30d 存活監控。

> v0.1 描述：A local-first Node.js CLI MVP designed to extract content from a URL, use LLM (OpenAI) to generate an engaging Markdown article, and syndicate it to multiple blogging platforms (Dev.to, Telegra.ph, Medium) after manual approval, then logging the results to Google Sheets.

## Features

- **Web Scraping:** Uses Playwright and Mozilla Readability to extract clean article content and images from any URL.
- **LLM Re-writing:** Re-writes and formats the extracted content into publish-ready Markdown using OpenAI.
- **Human-in-the-Loop (HITL):** Pauses execution to preview the generated title and content. Requires manual confirmation before publishing.
- **Damping/Brake (Rate Limiting):** Applies 5-15s random sleep between API requests to mitigate spam-flagging risks.
- **Google Sheets Sync:** Automatically logs timestamp, original URL, generated title, and published URLs to your Google Sheet.

## Setup Instructions

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Copy the `.env.example` to `.env`:

```bash
cp .env.example .env
```

Fill in the `.env` values:

- `OPENAI_API_KEY`: Get from [OpenAI Dashboard](https://platform.openai.com/api-keys).
- `DEVTO_API_KEY`: Generate an API key from your Dev.to Settings -> Extensions.
- `MEDIUM_INTEGRATION_TOKEN`: Generate from Medium Settings -> Security and Apps -> Integration Tokens.
- `GOOGLE_APPLICATION_CREDENTIALS_JSON`: Create a Google Cloud Project, enable Google Sheets API, create a Service Account, generate a JSON key, and minify it (or pass the path to the file if modified in code). Provide the raw JSON string here.
- `GOOGLE_SHEET_ID`: The ID of your Google Sheet (found in the URL: `https://docs.google.com/spreadsheets/d/<THIS_IS_THE_ID>/edit`). *Don't forget to share your Sheet with the email address of the Service Account (e.g., `xxx@your-project.iam.gserviceaccount.com`).*

**Note on Telegra.ph:** Telegra.ph adapter handles its own anonymous account creation. No token is needed in `.env`.

### 3. Run the Agent

```bash
npm start
```

## Example Usage

1. **Input:** `https://example.com/some-great-article`
2. **LLM Output:** "A highly engaging title based on the original" and generated markdown.
3. **Approve:** Type `y` or `N`.
4. **Publishing:** 
   - Publishes to Telegra.ph... sleeps for 8s.
   - Publishes to Dev.to... sleeps for 12s.
   - Publishes to Medium...
5. **Google Sheets Sync:** Appends a row with the generated links.

## Limitations / Out of Scope (MVP v0.1)

- Supports 3 MVP platforms only. WordPress, Tumblr, etc. are deferred to future iterations.
- Playwright is used for scraping, but publishing relies entirely on APIs.
- Captcha bypass and automated browser publishing are not handled in this version.
- Ensure your Google Service Account has `Editor` access to the target Google Sheet.

---

## v0.2 項目結構

```
src/
├── routes/          # Express 路由（publish, config, history, admin）
├── services/
│   ├── variant-generator.ts  # Unit 5: 7 平台並發 LLM 生成
│   ├── anchor-generator.ts   # Unit 6: 錨詞 mini-prompt + 禁用詞校驗
│   ├── lint/                 # Unit 7: Jaccard + regex lint 管道
│   ├── brand-profile.ts      # Unit 3: 品牌資料庫校驗
│   ├── anchor-monitor.ts     # Unit 11: 錨詞集中度 + 周上限
│   └── queue/
│       ├── scheduler.ts       # Unit 9: SQLite polling 調度器
│       ├── publish-worker.ts  # Unit 10: 發布 handler
│       ├── liveness-worker.ts # Unit 13: 存活檢查 handler
│       ├── digest-job.ts      # Unit 13: 日終 digest
│       └── sheets-jobs.ts     # Unit 12b: Sheets 維護作業
├── llm/
│   ├── client.ts      # OpenAI/Gemini 客戶端單例
│   ├── index.ts       # invokeLLM (內容生成)
│   └── agent-llm.ts   # invokeLLMWithTools (Agent 工具調用)
├── sheets/index.ts    # GoogleSheetsClient (12 欄 Posts + Aggregates)
├── db/
│   ├── schema.ts      # 8 張表 DDL
│   └── repositories.ts # publishJobs / anchorHistory / linkChecks / ...
├── prompts/
│   ├── personas/       # tech_blogger.md / personal_essay.md / reviewer.md
│   └── anchor-generator.md
└── utils/
    ├── browserManager.ts # Playwright 單例 + semaphore
    ├── parallel.ts        # 並發執行器（fail-safe）
    └── smartRetry.ts      # 錯誤分類 + 斷路器
public/index.html          # Alpine.js SPA 前端
```

## v0.2 日常操作 SOP

### 啟動

```bash
npm start          # 前台運行（開發）
./start.sh         # 後台運行 + 日誌輸出到 server.nohup.log
```

### 首次配置

1. 配置 `.env`（LLM key、平台 API tokens、Google Sheets）
2. 打開 `http://localhost:3000` → 品牌資料庫 → 填寫品牌資訊
3. 確認頂部顯示「✓ 品牌資料已就緒」

### 日常發布流程

1. **文章發佈** 頁面 → 粘貼草稿（≥ 600 字符）
2. 點「生成 7 個平台變體」（約 60-90 秒）
3. 逐 tab 預覽，確認 lint 無警告
4. 可跳過不需要的 tab，或點「重新生成本 tab」
5. 點「一鍵發佈」→ 任務進入佇列
6. **佇列狀態** 頁查看發布進度（5 秒自動刷新）

### 存活監控

- 每篇發布後自動入隊 T+24h / T+7d / T+30d 存活檢查
- 結果回寫 `link_checks` 表 + Sheets `t24h_alive` 欄
- 每月 1 號查 T+30d 存活率 < 70% 時觸發 `logger.error` 告警

### 每日自動任務（scheduler 負責）

| 時間 | 任務 | 說明 |
|------|------|------|
| 整日  | publish / health_check_t* | 按 scheduled_at 自動執行 |
| 04:00 | aggregate_sheets | 刷新 Sheets Aggregates 匯總 |
| 04:30 | reconciliation | SQLite → Sheets 偏差補行 |
| 18:00 | daily_digest | 發送日報（Telegram / Email / none）|

### 故障排查

```bash
# 查看殭屍作業
sqlite3 .data/syndicator.db "SELECT * FROM publish_jobs WHERE status='running' AND updated_at < datetime('now','-10 minutes');"

# 重置殭屍作業（scheduler 每分鐘自動執行，也可手動）
sqlite3 .data/syndicator.db "UPDATE publish_jobs SET status='failed_retryable' WHERE status='running' AND updated_at < datetime('now','-10 minutes');"

# 查看存活率
sqlite3 .data/syndicator.db "SELECT check_type, COUNT(*) total, SUM(CASE WHEN classification IN ('alive','redirect_alive') THEN 1 ELSE 0 END) alive FROM link_checks GROUP BY check_type;"

# 查看 LLM 花費
sqlite3 .data/syndicator.db "SELECT DATE(created_at) as day, ROUND(SUM(cost_usd),4) as usd FROM llm_calls GROUP BY day ORDER BY day DESC LIMIT 7;"
```

### 重跑 preflight 平台健康檢查

```bash
npx tsx scripts/preflight-check.ts
```

輸出各平台 API 可達性矩陣，結果影響 `PLATFORM_HEAD_SUPPORTED` 常量（`src/constants.ts`）。
