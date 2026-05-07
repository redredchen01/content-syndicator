---
date: 2026-05-07
topic: open-ideation
focus: open-ended
---

# Ideation: Multi-Channel Syndicator — Open Ideation

## Codebase Context

**Project shape:** TypeScript/Node.js + Express 5.x + SQLite + Alpine.js SPA. 7+ publishing platform adapters (Dev.to, Medium, Telegra.ph, WordPress, Blogger, GitHub Pages, etc.) using OAuth + Playwright browser automation. LLM abstraction: OpenAI + Gemini for 7-parallel variant generation with 5-gram Jaccard <0.4 uniqueness lint. Queue: SQLite-backed job scheduler + circuit-breaker + retry. ROI ranking: DA Tier + survival learning, scored as REAL float priority.

**Key infrastructure already in place:** `link_checks(platform, variant_id, check_type, classification)`, `llm_calls(cost_usd, model, variant_id)`, `publish_jobs(scheduled_at, platform, status, last_error)`, `variant_cache(body_markdown, persona_group)`, `anchor_history(anchor_text, target_url, batch_id)`.

**Known pain points:** 5s frontend polling, no LLM budget enforcement, circuit breaker uses 'default' key (all platforms share one fault domain), addColumnIfMissing manual migrations, no inbound webhook, brand_id='main' single-tenant, Gemini tool_calls silently returns [].

## Ranked Ideas

### 1. Circuit Breaker Hardening — Fix 'default' Key + Persist State
**Description:** Two simultaneous fixes: (1) change `retryOperation()` context default from `'default'` to the adapter name, giving each platform an independent circuit breaker; (2) persist circuit breaker state to a new SQLite table `circuit_breaker_state(key, state, failures, last_failure_time)` so process restarts don't reset learned state.
**Rationale:** Dev.to failing 5× currently trips the breaker for GitHub too — misdiagnosis in production looks like "all platforms failed simultaneously." Process restart also erases the breaker state, making it ineffective in frequent-restart environments. Two low-complexity fixes that make the isolation boundary real.
**Downsides:** SQLite write on every state transition (mitigated by debounce). Slight schema addition.
**Confidence:** 95%
**Complexity:** Low
**Status:** Unexplored

### 2. LLM Budget Gate + Auto Model Downgrade
**Description:** Pre-flight query in `generateVariants()`: `SELECT SUM(cost_usd) FROM llm_calls WHERE created_at > NOW()-24h`. If over daily budget threshold, cascade downgrade: `gpt-4o → gpt-4o-mini → gemini-1.5-flash`. Hard stop at 2× budget with 429 + `Retry-After`. `computeLlmCost()` already exists; this is the missing enforcement layer.
**Rationale:** `LLM_BUDGET` constants exist, `llm_calls.cost_usd` is recorded, but nothing enforces the budget. A bug triggering batch retries can silently burn $20+ before anyone notices. Infrastructure is 90% done — this closes the last mile.
**Downsides:** gpt-4o-mini downgrade may affect variant quality (no quality baseline yet).
**Confidence:** 90%
**Complexity:** Low
**Status:** Unexplored

### 3. Jaccard-Guided Regeneration — Turn Blocker Into Direction Signal
**Description:** When 5-gram Jaccard ≥ 0.4 triggers, extract the top 20 overlapping n-grams and inject them as negative samples into the regeneration prompt: `"avoid these phrases: {overlapping_5grams}"`. Replace random retry with targeted divergence instruction. The current `regenerate-variant` → `generateSingleVariant` call discards this signal entirely.
**Rationale:** For semantically narrow topics (e.g. a single product changelog), all 7 variants draw from the same core and will keep hitting the threshold regardless of random retries. Injecting the failure fingerprint as a negative prompt can resolve in 1-2 retries what currently takes 5-10.
**Downsides:** Longer prompts (+token cost per retry). The n-gram extraction is synchronous O(n²) — must ensure it runs quickly enough for narrow-topic batches.
**Confidence:** 85%
**Complexity:** Low-Medium
**Status:** Unexplored

### 4. Platform Survival Decay Detector — Early Warning for Platform Policy Changes
**Description:** In the ROI scorer, compute `recent_survival = EWMA(last_14d link_checks, λ=0.7)` alongside the existing 90-day average. If recent score diverges from historical by >0.2, emit a `platform_degrading` event to the digest channel and temporarily multiply the DA tier by a penalty factor (0.5), redirecting dispatch to more stable platforms.
**Rationale:** Medium paywall changes, Dev.to nofollow policy updates register in `link_checks` within days, but the 90-day rolling average dilutes the signal. Recency weighting lets the system self-correct traffic allocation within 2 weeks of a platform going bad, not 90 days later.
**Downsides:** EWMA λ needs calibration; cold start (<14 records) falls back to existing logic.
**Confidence:** 85%
**Complexity:** Low
**Status:** Unexplored

### 5. Variant Quality Flywheel — Survival Data as Few-Shot Examples
**Description:** Join `link_checks(t30d=alive/404) → posts.variant_id → variant_cache.body_markdown` to extract high-survival and low-survival examples per `(persona_group × platform)`. Inject 5-10 delta examples as few-shot context into the persona prompt at generation time. Skip silently when <20 data points (cold start).
**Rationale:** The system collects survival ground truth for free on every published batch, but never uses it to improve the next one. The join chain exists in the schema today with no changes required. After ~50 batches, prompts are self-improving on real-world data. This is the core compounding asset.
**Downsides:** Requires 50+ batches for statistical meaning. Few-shot quality depends on link_checks accuracy. Prompt length increases per batch.
**Confidence:** 75%
**Complexity:** Medium
**Status:** Unexplored

### 6. Inbound Webhook Trigger — Zero-Touch CMS-to-Syndication Pipeline
**Description:** New `POST /api/webhooks/trigger` endpoint with HMAC-SHA256 signature verification. Body: `{draft, title, target_url, platforms?}`. On valid signature, enters existing `v2-dispatch.ts → bulk-queue` pipeline. Supports `?dry_run=1` for preview. `bulk-queue.ts` entry point is already modular — the handler is a thin wrapper.
**Rationale:** Currently the only entry point is the manual SPA. Ghost publishing, Obsidian vault saves, GitHub Actions can all trigger syndication, but require manual copy-paste to the UI. A webhook unlocks "CMS publish → automatic multi-platform backlink sync" with zero operator intervention.
**Downsides:** HMAC key management needed. No built-in webhook retry (sender must handle). No webhook event log by default.
**Confidence:** 80%
**Complexity:** Low
**Status:** Unexplored

### 7. Compound Backlink Graph — Self-Amplifying Authority Network
**Description:** Scan `posts.published_url + link_checks.classification='alive'` to build a live graph of surviving published URLs. When generating a new batch for target_url B, inject one surviving published URL (on a related topic) as an anchor target in one variant — creating a tiered structure: new post → existing published post → money page. `variant_target_override` per variant already exists in the generator.
**Rationale:** Every other link-building tool only points at money pages. This system uniquely has the historical published URL graph to build tiered authority. Each new batch strengthens older batches — value compounds with every publish run. The join: `posts.published_url + anchor_history.target_url + link_checks.classification='alive'` requires no schema changes.
**Downsides:** Early value is low when the published URL pool is small. Requires content relevance matching to avoid nonsensical cross-linking. Target URL injection needs careful scoping to avoid circular graphs.
**Confidence:** 70%
**Complexity:** Medium
**Status:** Explored — brainstorm started 2026-05-07

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | Multi-Brand Workspace | Explicitly deferred MVP decision; requires product-level buy-in |
| 2 | Browser Session Autopilot | Requires Electron/webview — completely different tech stack |
| 3 | Migration Framework Drop-In | Pure technical debt; no user-visible value |
| 4 | Variant Diff View | UI sugar; low strategic impact |
| 5 | Job = Narrative Arc Series | Breaks existing job model; better as brainstorm topic |
| 6 | LLM Variant Tournament | Adds one LLM call per batch; static persona mapping is intentional |
| 7 | API Rate Limiting | Infrastructure/security hygiene, not a product improvement |
| 8 | OAuth Token Refresh Race Condition Fix | Implementation-level bug fix, not a product idea |
| 9 | Publish Timing Intelligence | Superseded by Platform Survival Decay Detector |
| 10 | Google Sheets Singleton Enforcer | Simple patch; doesn't warrant dedicated ideation slot |
| 11 | Cross-Adapter Integration Harness | Test infrastructure, not a product feature |
| 12 | Redefine Success as Survival KPI | Strategy discussion; operationally covered by Decay Detector |
| 13 | Platform canAccept() Self-Qualification | Implementation complexity disproportionate to expected gain |
| 14 | SQLite Table TTL Cleanup | Ops maintenance; not a product improvement |
| 15 | Adapter Latency Percentile Tracking | Covered by Decay Detector + Circuit Breaker combo |
| 16 | SSE Real-Time Job Status | Good UX win but lower priority than compounding/correctness fixes |
| 17 | Variant Cache Batch Consistency Lock | Rare edge case; fix complexity high relative to frequency |

## Session Log
- 2026-05-07: Initial open ideation — 48 raw candidates generated across 6 frames, deduped to 26, 7 survivors after adversarial filtering
- 2026-05-07: Selected #7 Compound Backlink Graph for brainstorm
