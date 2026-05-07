---
title: "feat: Compound Backlink Graph — Tier-2 Authority Network"
type: feat
status: completed
date: 2026-05-07
deepened: 2026-05-07
origin: docs/brainstorms/2026-05-07-compound-backlink-graph-requirements.md
---

# feat: Compound Backlink Graph — Tier-2 Authority Network

## Overview

Instead of every published variant linking directly to the brand's money page, the WordPress (slot-7) variant in each batch will link to an existing high-DA alive published URL (tier-2 target). That tier-2 page already links to the money page, forming a compounding three-tier chain: `new post → alive published post → money page`. Each batch run can add authority weight to a different tier-2 page; the longer the system runs, the denser and stronger the backlink graph becomes.

## Problem Frame

The system accumulates a growing pool of indexed, alive published URLs across high-DA platforms (Dev.to, Medium, etc.) but never leverages them after initial publication. Each batch batch links exclusively to the money page, producing a flat link graph. By routing the WordPress variant through an alive intermediate page, each new batch compounds the authority of that page — and that page in turn passes stronger equity to the money page. (see origin: `docs/brainstorms/2026-05-07-compound-backlink-graph-requirements.md`)

## Requirements Trace

- R1. Query `link_checks` alive URL pool before each generate, ordered by platform DA tier
- R2. Apply 7-day cooldown per tier-2 target URL
- R3. Exclude URLs published as tier-2 variants (anti-tier-3 guard)
- R4. Skip if pool < 10 distinct URLs (post R3), or no URLs survive cooldown
- R5. Select highest-DA URL as tier-2 target
- R6. Assign exactly 1 variant (slot 7 = WordPress) to tier-2; count is hardcoded for v1
- R7. Slot 7 unconditionally (no persona-topic matching in v1)
- R8. Other 6 variants unchanged
- R9. Set `target_url_override` on WordPress variant to tier-2 URL
- R10. Anchor text describes the intermediate page's topic, not money page
- R11. Tier-2 variant body has single anchor pointing to tier-2 URL
- R12. Tier-2 variant goes through full pipeline (Jaccard lint, anchor gen, publish queue)
- R13. Record `is_tier2=true` in `anchor_history` on successful publish
- R14. Log `[CompoundGraph] tier-2 assigned: {platform} {url}` or skip reason

## Scope Boundaries

- No dispatch-time re-validation of tier-2 URL liveness; snapshot taken at generate time
- Regenerating the WordPress variant via `regenerate-variant` endpoint clears the tier-2 target (limitation accepted for v1 — no tier-2 context passed to single-variant regeneration)
- `naked_url` fallback still blocks tier-2 WordPress variant from dispatch (existing guard unchanged)
- No Sheets sync column for `is_tier2` visibility in this iteration
- No per-batch operator configurability — hardcoded 1 tier-2 variant
- No persona-topic matching for slot assignment — slot 7 (WordPress) unconditionally
- ROI filter removing WordPress does not pre-occupy the cooldown window — cooldown activates only on successful publish
- `brand_id='main'` single-brand scope preserved; multi-brand expansion is out of scope

## Context & Research

### Relevant Code and Patterns

- **Batch generate flow**: `src/services/publish/v2-dispatch.ts` → `runV2Generate()` → `generateVariants()` → `attachAnchors()` — tier-2 injection goes between these two calls
- **Dispatch flow**: `runV2Dispatch()` → `filterByRoi()` → `dispatchVariantJobs()`
- **Slot 7 = WordPress**: `src/constants.ts` `MVP_PLATFORMS[6]`; maps to `reviewer` persona group
- **`target_url_override`**: currently batch-level only (`GenerateVariantsInput.target_url_override` → `resolveTargetUrl()` in `variant-generator.ts:161`); no per-variant override today — must mutate after `generateVariants()` returns
- **`anchor_words` in variant cache**: `variant-generator.ts:189` returns `cached.anchor_words` on cache hit — must clear `variant.anchor_words = []` on the tier-2 variant before `attachAnchors()` to force fresh anchor generation
- **`callAnchorLLM` context**: `src/services/anchor-generator.ts:116` — accepts `ctx.targetUrl` (string) and `ctx.summary` (string used as `{{article_summary}}` in prompt); both swappable without signature change
- **DA tier data**: `src/services/roi-scorer.ts` exposes `getDaTierConfig(db)` and `DEFAULT_DA_TIERS`; already called in `runV2Dispatch` via `filterByRoi` — no circular dependency for the selector to reuse
- **`addColumnIfMissing` pattern**: `src/db/schema.ts:19–28` — `addColumnIfMissing(db, table, column, 'INTEGER NOT NULL DEFAULT 0')` appended at end of `applyV2Schema()`
- **`anchorHistory.weeklyCountForUrl()`**: already queries 7-day window by `anchor_text`, not `target_url` — new query function needed
- **`anchor_history` write guard**: `publish-worker.ts:158` — writes only when `job.attempts === 0`; `is_tier2` write must respect this same guard
- **`AnchorHistoryRow` type**: `src/db/repositories/index.ts` — must extend with `is_tier2` to carry flag from dispatch to write

### Institutional Learnings

- `brand_id` must be `'main'`, never `'default'` — historical bug in `updatePreferredPlatforms()` used `'default'` and silently missed all writes (see `docs/plans/2026-05-06-001-fix-stability-hardening-plan.md`)
- `addColumnIfMissing` with `INTEGER NOT NULL DEFAULT 0` is the established pattern for boolean-like columns (see `priority REAL NOT NULL DEFAULT 0.0` in ROI plan)
- `anchor_history` writes are idempotent: `attempts === 0` guard prevents double-counting on retry
- Gemini `tool_calls` silently returns `[]` — anchor generation LLM calls via Gemini fallback need result validation
- Circuit breaker uses shared `'default'` key (known bug) — a tier-2 variant failure will affect the shared breaker; not a blocker for this plan but a known risk

## Key Technical Decisions

- **Injection at generate time, not dispatch time**: Tier-2 selection runs inside `runV2Generate()`, between `generateVariants()` and `attachAnchors()`. This ensures the tier-2 anchor is visible in the user preview before dispatch confirmation. Trade-off: alive URL pool snapshot is taken at generate time; if a URL dies between generate and dispatch, it will not be re-detected. Accepted — the pool changes slowly (link_checks runs at T+7d/T+30d).

- **Mutate WordPress variant in-place**: Rather than modifying `generateVariants()` to accept tier-2 config, the selector runs after `generateVariants()` returns and directly mutates `variant.target_url`, `variant.is_tier2`, and `variant.tier2_platform` on the WordPress element. This minimizes changes to the core generation pipeline.

- **Clear `anchor_words` before `attachAnchors()`**: The variant cache may have stored anchor_words generated for the money page. To guarantee fresh anchor generation for the tier-2 target, explicitly set `variant.anchor_words = []` on the WordPress variant immediately after mutating `target_url`. This forces `attachAnchors()` to regenerate regardless of cache state.

- **Anchor context via `ctx.summary` + `contextTag` swap**: When `variant.is_tier2 === true`, the `generateAnchorsForVariant` function sets: (a) `ctx.summary = "published article on ${variant.tier2_platform ?? 'external platform'}"` and (b) `contextTag = variant.tier2_platform ?? 'external'`. The second override is necessary because without it `contextTag` resolves via `brand.target_urls.find(t => t.url === variant.target_url)?.context_tag ?? 'home'` — a tier-2 URL will never appear in `brand.target_urls`, so it falls back to `'home'`, sending a misleading context signal to the anchor LLM. No prompt template changes or new function signatures required.

- **Selector as private helper in `v2-dispatch.ts`**: The tier-2 pool selection logic is a private function in `v2-dispatch.ts`, not a separate service file. It is small (~40 lines), called only from `runV2Generate`, and all dispatch-phase orchestration already lives there.

- **DA tier from `getDaTierConfig(db)`**: The selector imports `getDaTierConfig` from `roi-scorer.ts` for platform → DA tier mapping. No circular dependency: roi-scorer imports repositories, not v2-dispatch.

- **Anti-tier-3 guard via platform exclusion**: The pool query excludes `platform='WordPress'` URLs entirely. Reasoning: v1 always assigns tier-2 to the WordPress slot. WordPress posts in the pool are therefore either (a) old money-page variants — low DA 0.6, never selected over Tier1 platforms anyway — or (b) tier-2 variants published as part of this feature, whose content links to an intermediate page rather than directly to the money page. Including them as tier-2 targets would create a tier-3 chain. Excluding all WordPress platform URLs from the pool eliminates both cases with a single SQL clause, removing the need for a separate `tier2PublishedUrls()` function.

- **Cooldown activates only on publish success**: When WordPress is filtered by ROI or fails to publish, `anchor_history` is never written and the cooldown is not triggered. The same high-DA URL may be selected on the next generate. This is acceptable — the cooldown exists to prevent over-linking to successfully published pages, not to pre-occupy candidates.

## Open Questions

### Resolved During Planning

- **`anchor_history.target_url` write path**: Confirmed `publish-worker.ts:166` uses `variant.target_url`, which is the fully resolved URL post-`target_url_override`. Cooldown and anti-tier-3 guard queries against `anchor_history.target_url` will correctly find tier-2 URLs.
- **DA tier access at dispatch time**: `getDaTierConfig(db)` and `DEFAULT_DA_TIERS` in `roi-scorer.ts` are already called within `runV2Dispatch` via `filterByRoi`. No circular dependency for the selector to import from `roi-scorer`.
- **`naked_url` in tier-2 context**: Existing dispatch guard blocks naked_url variants. This applies equally to tier-2 WordPress variants. Acceptable — a raw URL anchor to a tier-2 page has zero SEO value and looks spammy.

### Deferred to Implementation

- **`attachAnchors()` handling of non-empty `anchor_words`**: Verify whether `attachAnchors` skips variants with existing non-empty `anchor_words` or overwrites them unconditionally. If the former, clearing `variant.anchor_words = []` before `attachAnchors()` is required for correctness; if the latter, it is a no-op safety measure.
- **`callAnchorLLM` `ctx.summary` substitution path**: Confirm which internal function in `anchor-generator.ts` constructs `ctx.summary` from the variant, and where to insert the `is_tier2` branch (`generateAnchorsForVariant` or the outer `attachAnchors` loop).
- **Link_checks `t30d` vs `t7d` preference**: The selector should prefer `t30d`-confirmed alive URLs and fall back to `t7d`. Implement the SQL accordingly — one query joining on `MAX(check_type)` by priority or two queries with union fallback.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
runV2Generate(db, body)
  │
  ├─ generateVariants(input)
  │    └─ returns 7 variants (slot 6 = WordPress, target_url = money page)
  │
  ├─ selectTier2Target(db, getDaTierConfig(db))
  │    ├─ aliveUrlsPool(db) → ordered by DA tier
  │    ├─ subtract tier2PublishedUrls(db) → anti-tier-3 guard
  │    ├─ pool < 10? → return null + log skip
  │    ├─ apply 7-day cooldown filter (usedAsTier2InWindow)
  │    ├─ no survivors? → return null + log skip
  │    └─ return { url, platform } (highest DA)
  │
  ├─ if tier2Target !== null:
  │    wordpressVariant.target_url = tier2Target.url
  │    wordpressVariant.is_tier2 = true
  │    wordpressVariant.tier2_platform = tier2Target.platform
  │    wordpressVariant.anchor_words = []   ← force fresh anchor gen
  │    log "[CompoundGraph] tier-2 assigned: {platform} {url}"
  │
  └─ attachAnchors(variants, brand, recentTopAnchors, db)
       └─ for each variant via generateAnchorsForVariant():
            if variant.is_tier2:
              ctx.summary = "published article on {variant.tier2_platform}"
              contextTag = variant.tier2_platform ?? 'external'
              ctx.targetUrl = variant.target_url  ← tier-2 URL
            else:
              ctx.summary = extractSummary(variant.body_markdown)  ← existing
              contextTag = brand.target_urls.find(...)?.context_tag ?? 'home'  ← existing
              ctx.targetUrl = variant.target_url  ← money page (unchanged)
            → callAnchorLLM(prompt, ctx, variant, db)

publish-worker (on successful first-attempt publish):
  anchorHistory.insert(db, {
    ..., target_url: variant.target_url, is_tier2: variant.is_tier2 ?? false
  })
```

## Implementation Units

```mermaid
TB
  U1[Unit 1\nSchema + Repository] --> U2[Unit 2\nVariant Type]
  U2 --> U3[Unit 3\nTier-2 Selector]
  U3 --> U4[Unit 4\nGenerate Flow\nInjection]
  U4 --> U5[Unit 5\nPublish Worker\nWrite-back]
```

- [x] **Unit 1: Schema Migration + Repository Extensions**

**Goal:** Add `is_tier2` column to `anchor_history`, extend `AnchorHistoryRow` type, and add the three repository query functions the selector and write-back require.

**Requirements:** R2, R3, R4, R5, R13

**Dependencies:** None

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/repositories/index.ts`
- Test: `src/db/__tests__/repositories.test.ts`

**Approach:**
- In `applyV2Schema()`, append: `addColumnIfMissing(db, 'anchor_history', 'is_tier2', 'INTEGER NOT NULL DEFAULT 0')`
- Add index: `CREATE INDEX IF NOT EXISTS idx_anchor_history_tier2 ON anchor_history(is_tier2, target_url, used_at)`
- Extend `AnchorHistoryRow` interface with `is_tier2?: boolean`
- Extend the `anchor_history INSERT` statement to include the `is_tier2` column (default 0 when not set)
- Add to `linkChecks` namespace: `aliveUrlsPool(db)` returning `Array<{platform: string, published_url: string}>` — select distinct `(platform, published_url)` where `classification IN ('alive','redirect_alive')` AND `platform != 'WordPress'` (anti-tier-3 guard). No `checked_at` time filter — `link_checks` rows are written once at T+7d/T+30d after publication; a time filter would make the pool near-empty. Caller sorts by DA tier in JS. For deduplication across check types, use `GROUP BY platform, published_url` keeping the most recent row.
- Add to `anchorHistory` namespace: `usedAsTier2InWindow(db, targetUrl, windowIso)` returning `boolean` — `SELECT COUNT(*) > 0 FROM anchor_history WHERE is_tier2=1 AND target_url=? AND used_at >= ?`

**Patterns to follow:**
- `linkChecks.survivalRate()` and `linkChecks.survivalRecordCount()` in `repositories/index.ts` for SQLite query patterns
- `addColumnIfMissing(db, 'publish_jobs', 'priority', 'REAL NOT NULL DEFAULT 0.0')` in `schema.ts` for boolean column migration pattern
- `anchorHistory.weeklyCountForUrl()` for the 7-day window query pattern (model for `usedAsTier2InWindow`)

**Test scenarios:**
- Happy path: `applyV2Schema()` on fresh DB — `anchor_history` gets `is_tier2` column with default 0; calling twice is idempotent (no error)
- Happy path: `aliveUrlsPool()` with 3 alive + 1 dead + 1 WordPress URL in link_checks → returns 2 (alive non-WordPress), correct platform and published_url
- Happy path: `aliveUrlsPool()` deduplicates same URL across `t7d` and `t30d` check records (GROUP BY platform, published_url)
- Edge case: `aliveUrlsPool()` with only WordPress-platform URLs in link_checks → returns empty array (anti-tier-3 guard)
- Edge case: `aliveUrlsPool()` with empty link_checks → returns empty array
- Happy path: `usedAsTier2InWindow()` with a URL used as tier-2 6 days ago → returns true (within 7-day window)
- Edge case: `usedAsTier2InWindow()` with same URL used 8 days ago → returns false (outside window)
- Edge case: `usedAsTier2InWindow()` on a URL that exists in anchor_history but with `is_tier2=0` → returns false

**Verification:**
- All three new query functions have unit tests covering their select and filter behavior
- `addColumnIfMissing` runs cleanly on an existing database that already has prior columns
- `anchor_history INSERT` with `is_tier2=1` round-trips correctly through `SELECT`

---

- [x] **Unit 2: Extend Variant Type**

**Goal:** Add `is_tier2` and `tier2_platform` fields to the `Variant` interface so the flag can be transported from generate time through `publish-worker` without losing context.

**Requirements:** R9, R13

**Dependencies:** None (type-only change, can land before or with Unit 1)

**Files:**
- Modify: `src/types/index.ts`
- Test: `Test expectation: none — type-only change; TypeScript compiler catches misuse at build time`

**Approach:**
- Add `is_tier2?: boolean` and `tier2_platform?: string` as optional fields to the `Variant` interface
- Existing variant construction code produces `is_tier2: undefined` (which coerces to falsy) — no existing callers break

**Patterns to follow:**
- `target_url_override?: string` in `GenerateVariantsInput` (`variant-generator.ts:34`) for optional field precedent

**Verification:**
- `tsc --noEmit` passes with no new errors after adding fields

---

- [x] **Unit 3: Tier-2 Selector**

**Goal:** Implement `selectTier2Target(db, daTierConfig)` as a private helper in `v2-dispatch.ts` that encapsulates pool query, filters, and selection logic.

**Requirements:** R1–R5, R14

**Dependencies:** Unit 1 (repository functions), Unit 2 (Variant type for return type)

**Files:**
- Modify: `src/services/roi-scorer.ts` (export `DaTierConfig` interface)
- Modify: `src/services/publish/v2-dispatch.ts`
- Test: `src/services/publish/__tests__/v2-dispatch.test.ts` (or create if absent)

**Approach:**
- In `roi-scorer.ts`: add `export` to the `DaTierConfig` interface (currently unexported but used as return type of `getDaTierConfig`)
- Private function signature: `selectTier2Target(db, daTierConfig: DaTierConfig): { url: string; platform: string } | null`
- Step 1: call `linkChecks.aliveUrlsPool(db)` → pool (WordPress platform pre-excluded by query; no time filter)
- Step 2: if pool size < 10 → log `[CompoundGraph] skipped: pool too small (n={count})` → return null
- Step 3: apply cooldown — for each URL in pool, call `anchorHistory.usedAsTier2InWindow(db, url, sevenDaysAgoIso)`; collect survivors
- Step 4: if survivors empty → log `[CompoundGraph] skipped: all urls in cooldown` → return null
- Step 5: sort survivors by `daTierConfig.tiers[platform] ?? 0` descending; pick first
- Step 6: log `[CompoundGraph] tier-2 assigned: {platform} {url}` → return `{ url, platform }`
- Import `getDaTierConfig` and export `DaTierConfig` interface from `roi-scorer.ts` (currently unexported — add `export` keyword). Call `getDaTierConfig(db)` at the start of `runV2Generate` and pass result to `selectTier2Target`

**Patterns to follow:**
- `filterByRoi()` in `v2-dispatch.ts` for the pattern of a private helper function doing DB queries and logging

**Test scenarios:**
- Happy path: 15 alive non-WordPress URLs, none in cooldown → returns highest-DA platform URL (Dev.to/Medium at DA 1.0 preferred over Blogger/Telegra.ph)
- Happy path: only 9 alive non-WordPress URLs in link_checks → returns null (pool < 10)
- Happy path: 15 alive URLs, all in 7-day cooldown → returns null (no survivors after cooldown)
- Edge case: 10 URLs exactly in qualified pool (boundary) → proceeds to cooldown filter
- Edge case: 9 URLs exactly in qualified pool (boundary) → returns null immediately
- Edge case: multiple URLs on same highest-DA platform → returns the one with most recent `checked_at`
- Edge case: empty link_checks → returns null (pool too small)
- Integration: verify log line `[CompoundGraph] tier-2 assigned:` appears when a URL is selected
- Integration: verify log line `[CompoundGraph] skipped:` appears with correct reason when skipping

**Verification:**
- Unit tests cover all skip conditions and the happy-path selection
- Selector never returns a URL that is in `tier2PublishedUrls()`
- Selector never returns a URL that was used within the last 7 days

---

- [x] **Unit 4: Tier-2 Injection in Generate Flow + Anchor Context**

**Goal:** Wire the selector into `runV2Generate()` — mutate the WordPress variant between `generateVariants()` and `attachAnchors()` — and modify anchor generation to produce topically appropriate anchors for the tier-2 target.

**Requirements:** R9, R10, R11, R12

**Dependencies:** Unit 2 (Variant type), Unit 3 (selector)

**Files:**
- Modify: `src/services/publish/v2-dispatch.ts`
- Modify: `src/services/anchor-generator.ts`
- Test: `src/services/publish/__tests__/v2-dispatch.test.ts`
- Test: `src/services/__tests__/anchor-generator.test.ts`

**Approach:**

*In `v2-dispatch.ts:runV2Generate()`*:
- After `generateVariants()` returns, find the WordPress variant (`variants.find(v => v.platform === 'WordPress')`)
- Call `selectTier2Target(db, getDaTierConfig(db))`
- If `tier2Target !== null` and WordPress variant exists:
  - `wordpressVariant.target_url = tier2Target.url`
  - `wordpressVariant.is_tier2 = true`
  - `wordpressVariant.tier2_platform = tier2Target.platform`
  - `wordpressVariant.anchor_words = []` — clear to force fresh anchor generation
- Then proceed to `attachAnchors(variants, brand, db)` as normal

*In `anchor-generator.ts` (`generateAnchorsForVariant` function)*:
- Detect `variant.is_tier2 === true` before building the `ctx` object
- If true: set `ctx.summary = "published article on ${variant.tier2_platform ?? 'external platform'}"` AND set `contextTag = variant.tier2_platform ?? 'external'` (overriding the default `brand.target_urls` lookup, which returns `'home'` for non-brand URLs). `ctx.targetUrl = variant.target_url` (already tier-2 URL — no change needed)
- If false: unchanged (existing logic for `extractSummary`, `brand.target_urls.find(...)`, etc.)

**Execution note:** Confirm the `attachAnchors` loop entry point before writing — check whether `anchor_words = []` is sufficient to trigger regeneration or whether there is an explicit "skip if filled" guard that needs to be removed.

**Patterns to follow:**
- `resolveTargetUrl()` in `variant-generator.ts` for the precedent of per-variant URL resolution
- `filterByRoi()` in `v2-dispatch.ts` for mutating variant arrays between pipeline steps

**Test scenarios:**
- Integration: `runV2Generate()` called with 10+ alive URLs in link_checks → WordPress variant has `is_tier2=true`, `target_url = tier-2 URL`, `anchor_words` re-generated (not money-page anchors)
- Integration: `runV2Generate()` called with 0 alive URLs in link_checks → all 7 variants have `target_url = money page`; no `is_tier2` flag set
- Integration: selector returns null (pool too small) → WordPress variant unchanged; money page target preserved
- Integration (anchor-generator): anchor generation for `is_tier2=true` variant uses `ctx.summary = "published article on Dev.to"` (not the draft text)
- Integration (anchor-generator): anchor generation for standard variant (`is_tier2` absent/false) uses existing `ctx.summary` logic unchanged
- Edge case: selector returns null (pool < 10 OR all cooled) → WordPress variant unchanged; money-page target preserved for all 7 variants
- Edge case: `attachAnchors()` receives WordPress variant with `anchor_words = []` but `is_tier2 = true` → anchor LLM generates anchors for tier-2 URL, not money page

**Verification:**
- After a generate call with sufficient pool, the WordPress variant in the returned batch has `target_url` matching a URL from `link_checks.alive` rather than `brand.target_urls[0].url`
- Anchor words for the WordPress tier-2 variant describe the tier-2 platform, not the brand keywords
- All other 6 variants have unchanged `target_url` and anchor words

---

- [x] **Unit 5: Propagate is_tier2 in Publish Worker Write-back**

**Goal:** When the WordPress variant is published successfully, write `is_tier2=1` to `anchor_history` so the cooldown and anti-tier-3 guard can query it in future batches.

**Requirements:** R13

**Dependencies:** Unit 1 (repository + schema), Unit 4 (is_tier2 in Variant payload)

**Files:**
- Modify: `src/services/queue/publish-worker.ts`
- Test: `src/services/queue/__tests__/publish-worker.test.ts`

**Approach:**
- In the `anchorHistory.insert()` call at `publish-worker.ts:161`, pass `is_tier2: variant.is_tier2 ?? false`
- The `AnchorHistoryRow` type (extended in Unit 1) accepts `is_tier2?: boolean`; the repository INSERT maps it to `1` or `0`
- The `job.attempts === 0` guard remains in place — `is_tier2` write is subject to the same idempotency constraint as existing anchor writes

**Patterns to follow:**
- Existing `anchorHistory.insert()` call at `publish-worker.ts:158–169` for the exact insertion pattern

**Test scenarios:**
- Happy path: publish succeeds for WordPress variant with `is_tier2=true` on first attempt (`attempts=0`) → `anchor_history` row has `is_tier2=1` and `target_url = tier-2 URL`
- Happy path: publish succeeds for standard variant (Dev.to, no `is_tier2`) → `anchor_history` row has `is_tier2=0`
- Edge case: publish succeeds for WordPress variant on retry (`attempts=1`) → `anchor_history` NOT written (idempotency guard unchanged)
- Edge case: WordPress variant with `is_tier2=undefined` (pool was too small at generate time) → `anchor_history` has `is_tier2=0` (falsy coercion via `?? false`)
- Integration: after Unit 5 write, `anchorHistory.usedAsTier2InWindow()` returns true for that URL within 7 days; `tier2PublishedUrls()` includes that URL

**Verification:**
- `SELECT is_tier2 FROM anchor_history WHERE platform='WordPress' AND batch_id=?` returns 1 after a successful tier-2 publish
- `usedAsTier2InWindow()` and `tier2PublishedUrls()` correctly reflect the written record in subsequent selector calls

## System-Wide Impact

- **Interaction graph:** `runV2Generate` is the only entry point modified; `attachAnchors` called once per generate as before — only ctx construction changes for is_tier2 variants. `publish-worker` anchorHistory.insert call is the only write-path change.
- **Error propagation:** `selectTier2Target` failure (DB error) should not crash the batch — wrap the selector call in a try/catch; on error, log and skip tier-2 for that batch (all 7 → money page). The batch must not fail because of the tier-2 selector.
- **State lifecycle risks:** `is_tier2` flag rides in `publish_jobs.payload_json` (the variant is serialized as payload). Existing payload deserialization in publish-worker reads the full variant object — new optional fields will be present without schema change to `publish_jobs`. Risk: if publish-worker deserializes payload into a typed interface that does not include `is_tier2`, the flag will be silently dropped. Verify the deserialization path.
- **API surface parity:** No new routes or public API changes. The generate/dispatch endpoints are unchanged in signature. `is_tier2` is internal transport only.
- **Integration coverage:** Unit tests alone will not prove the end-to-end `selectTier2Target → variant mutation → anchor generation → publish-worker write-back` chain. An integration test (or manual verification against a test DB) is recommended for the full happy path.
- **Unchanged invariants:** The 6 non-WordPress variants continue to produce money-page anchors. `filterByRoi` logic is unchanged. `dispatchVariantJobs` signature and behavior are unchanged. Jaccard lint, publish queue, and health_check job scheduling are unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `attachAnchors` skips variants with non-empty `anchor_words` | Clear `anchor_words = []` on the tier-2 variant before calling; confirm during implementation (deferred to impl) |
| `publish_jobs.payload_json` deserialization drops `is_tier2` | Not a risk: `publish-worker.ts:45` uses `JSON.parse as Variant` (type assertion only); dispatch receives variants from client POST body (`v2-dispatch.ts:114`), so `is_tier2` flows through HTTP response → client state → dispatch POST → `payload_json` without cache intermediary |
| Selector DB query errors crash batch generate | Wrap `selectTier2Target` in try/catch; fail-soft to skip tier-2 for that batch |
| Gemini `tool_calls` silent empty — anchor gen for tier-2 variant returns no anchors | Existing `naked_url` fallback handles this; naked_url on tier-2 is blocked by dispatch guard; acceptable |
| Circuit breaker shared `'default'` key — WordPress failure trips breaker for other platforms | Pre-existing known bug; not introduced by this change; noted as ambient risk |
| `tier2PublishedUrls()` query grows unbounded as more batches publish | For current scale (< 10K rows) this is not a concern; future: add `WHERE used_at >= cutoff` to limit scope |

## Documentation / Operational Notes

- No operator-facing configuration changes; the feature is automatic and transparent
- Observable via `anchor_history` table: `SELECT target_url, used_at FROM anchor_history WHERE is_tier2=1 ORDER BY used_at DESC`
- Success metric (from requirements): after 30 batches, `SELECT COUNT(DISTINCT target_url) FROM anchor_history WHERE is_tier2=1` should be ≥ 5

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-07-compound-backlink-graph-requirements.md](docs/brainstorms/2026-05-07-compound-backlink-graph-requirements.md)
- Related code: `src/services/publish/v2-dispatch.ts` (`runV2Generate`, `filterByRoi`)
- Related code: `src/services/anchor-generator.ts` (`attachAnchors`, `callAnchorLLM`)
- Related code: `src/db/repositories/index.ts` (`linkChecks`, `anchorHistory` namespaces)
- Related code: `src/db/schema.ts` (`applyV2Schema`, `addColumnIfMissing`)
- Related code: `src/services/roi-scorer.ts` (`getDaTierConfig`, `DEFAULT_DA_TIERS`)
- Related code: `src/services/queue/publish-worker.ts` (anchor_history write at line 158–169)
- Related plans: `docs/plans/2026-05-06-003-feat-platform-roi-auto-ranking-plan.md` (DA tier patterns)
