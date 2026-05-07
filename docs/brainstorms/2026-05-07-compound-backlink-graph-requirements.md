---
date: 2026-05-07
topic: compound-backlink-graph
---

# Compound Backlink Graph

## Problem Frame

The system currently generates 7 content variants per batch, all of which link directly to the brand's money page. This means every published article is a terminal leaf in the link graph — it cannot amplify the authority of other published articles.

Meanwhile, the system accumulates a growing pool of indexed, alive published URLs (Dev.to articles, Medium posts, etc.) that are not leveraged after initial publication. These pages already carry domain authority from their host platforms (DA 70–95) and already link to the brand's money page. Each subsequent batch that runs ignores this asset.

The compound backlink graph changes this: 1 variant per batch redirects its anchor to an existing, high-DA alive published page instead of the money page. That intermediate page already links to the money page, creating a three-tier chain:

```
new published post ──→ existing alive published post (tier-2) ──→ money page
```

Because each new batch adds tier-2 weight to different high-DA published pages, the authority graph compounds over time: the longer the system runs, the more densely interconnected the published posts become, and the stronger each surviving tier-2 page becomes in passing equity to the money page.

**Terminology:** Throughout this document, "alive URL pool" means URLs where `classification IN ('alive', 'redirect_alive')` in `link_checks`. "Tier-2 target" is the existing published URL that will receive the inbound link. "Tier-2 variant" is the newly authored variant that links to the tier-2 target.

## Requirements

**Tier-2 Target Selection**

- R1. Before each batch is dispatched, query the alive URL pool: URLs from `link_checks` where `classification IN ('alive', 'redirect_alive')`, ordered by the DA tier of their platform (highest first). Prefer URLs with `check_type='t30d'` confirmation; fall back to `t7d` if no `t30d` record exists.
- R2. From the qualifying pool, exclude any URL used as a tier-2 target within the past 7 days (cooldown window, using `anchor_history` records where `is_tier2=true`).
- R3. Also exclude from the pool any URL that was itself published as a tier-2 variant (i.e., the variant that produced this URL had `is_tier2=true` in its `anchor_history` record). This prevents creating a tier-3 chain where a tier-2 page itself points to another intermediate page rather than to the money page.
- R4. If the alive URL pool contains fewer than 10 distinct URLs (before cooldown filtering), or if the pool passes R3 filtering but no URLs survive the cooldown filter (R2), skip tier-2 selection for this batch — all 7 variants point to the money page as normal. Log: `[CompoundGraph] skipped: {reason} (pool={pre_filter_count}, post_cooldown={post_filter_count})`.
- R5. Select the single highest-DA-platform URL that passes all filters (R1–R3) as the tier-2 target for this batch.

**Tier-2 Variant Assignment**

- R6. Assign exactly 1 variant per batch to the tier-2 target. The tier-2 variant count is fixed at 1 for v1 and is not operator-configurable.
- R7. For v1, assign the last persona slot (slot 7) as the tier-2 variant unconditionally. Persona-topic matching for slot selection is deferred to a later iteration.
- R8. The remaining 6 variants are unaffected — they continue to use `target_url` from brand profile as normal.

**Tier-2 Variant Content**

- R9. The tier-2 variant's `target_url_override` is set to the selected tier-2 target URL.
- R10. The anchor text generated for the tier-2 variant must describe the intermediate page's topic, not the brand's money page topic. The anchor generation prompt receives the tier-2 target URL and its platform/title as context so the LLM generates topically appropriate anchors.
- R11. The tier-2 variant body contains exactly one anchor link, pointing to the tier-2 target URL. The money page is not linked or mentioned in the body.
- R12. The tier-2 variant goes through the full standard pipeline: variant generation LLM, Jaccard uniqueness lint, anchor generation, publish queue — no special bypass.

**Audit and Observability**

- R13. Each tier-2 assignment is recorded in `anchor_history` with a new boolean column `is_tier2` (default `false`). When `is_tier2=true`, the `target_url` in that record must be the tier-2 target URL (not the brand's money page URL). This record provides the cooldown query (R2), the tier-3 exclusion check (R3), and enables reporting.
- R14. The batch summary log includes: `[CompoundGraph] tier-2 assigned: {platform} {url}` when successful, or `[CompoundGraph] skipped: {reason}` when skipped.

## User Flow

```
Batch dispatch triggered
        │
        ▼
Query alive URL pool
(link_checks: classification IN ('alive','redirect_alive'), ordered by DA tier)
Exclude URLs published as tier-2 variants (R3: anti-tier-3 guard)
        │
        ├─── Pool < 10 URLs ──────────────────────────────→ all 7 → money page + log skip
        │
        ▼
Apply 7-day cooldown filter (R2)
(exclude URLs in anchor_history WHERE is_tier2=true AND used within 7d)
        │
        ├─── No URLs survive cooldown ──────────────────→ all 7 → money page + log skip
        │
        ▼
Select highest-DA URL as tier-2 target (R5)
        │
        ▼
Assign slot 7 as tier-2 variant (R6, R7)
Set target_url_override = tier-2 target URL
        │
        ▼
Anchor generation for tier-2 variant (R10):
context = tier-2 target page topic + platform/title
(single anchor, no money page in body)
        │
        ▼
Full standard pipeline (R12):
Jaccard lint → publish queue → link_checks
        │
        ▼
Record in anchor_history (R13):
is_tier2=true, target_url = tier-2 URL
(cooldown clock starts)
```

## Success Criteria

- After 30 batches: at least 5 distinct published pages have received tier-2 inbound links from subsequent batches (verifiable via `SELECT COUNT(DISTINCT target_url) FROM anchor_history WHERE is_tier2=true`).
- No tier-2 variant appears in `anchor_history` with `is_tier2=true` and `target_url` equal to the brand's money page URL (validates R13 write correctness).
- No tier-2 target URL appears more than once in `anchor_history WHERE is_tier2=true` within any 7-day window (validates cooldown, R2).
- No URL that was itself a tier-2 variant appears in the selection pool as a tier-2 target (validates R3 anti-tier-3 guard).
- The pool-size skip fires correctly when tested with fewer than 10 alive URLs, leaving all 7 variants unmodified.

## Scope Boundaries

- The link chain is capped at two hops from a new post's perspective: new post → alive published post (tier-2) → money page. No tier-3 chains. R3 enforces this at selection time.
- Exactly 1 variant per batch becomes a tier-2 variant. Two-variant mode and per-batch configurability are out of scope for v1.
- The feature does not verify whether the selected tier-2 page still contains an outbound link to the money page. That is the responsibility of the existing `link_checks` / `anchor-monitor` subsystem.
- No UI changes in this iteration. Tier-2 behavior is automatic and transparent to the operator (observable via logs and `anchor_history`).
- Persona-topic matching for slot assignment is out of scope for v1 — slot 7 is used unconditionally.

## Key Decisions

- **1 variant per batch, hardcoded:** Keeps 6 of 7 variants' link equity flowing directly to the money page. Avoids diluting the primary campaign objective. Configurability deferred until real operator demand emerges.
- **Slot 7 unconditionally for v1:** Persona-topic matching for slot selection adds lookup complexity with no measurable impact on the core SEO outcome (the tier-2 page receives a backlink regardless of persona). Simpler is correct here.
- **Highest DA platform wins selection:** Deterministic, no LLM call needed, aligns with the existing DA tier ranking used by the ROI scorer.
- **7-day cooldown per tier-2 target:** Prevents any single published page from accumulating an unnatural inbound link spike within a short window, which could be a platform moderation signal.
- **10-URL cold start threshold:** Ensures enough pool diversity so the same 1–2 URLs don't dominate every batch.
- **Single anchor in tier-2 variant body, describing the intermediate page:** The tier-2 variant is authored as if organically recommending a useful third-party resource. This is the most natural framing and avoids keyword stuffing around brand terms.
- **Anti-tier-3 guard at selection time (R3):** Simpler to exclude at query time than to verify hop-count at runtime. The `is_tier2` flag on `anchor_history` is the source of truth.

## Dependencies / Assumptions

- The alive URL pool is derived from `link_checks`. The tier-2 selector prefers `t30d`-confirmed URLs, falling back to `t7d`.
- Platform DA tier data must be accessible at tier-2 selection time. The existing ROI scorer already holds this data; the selector can reuse it.
- The `anchor_history` table requires a new `is_tier2 INTEGER DEFAULT 0` column (`addColumnIfMissing` migration).
- **Assumption to validate before planning:** The `target_url` written into `anchor_history` must reflect the final resolved target URL (post-`target_url_override`), not the brand's default money page URL. If the current write path always uses `brand.target_urls[0]`, the cooldown query (R2) and tier-3 guard (R3) will silently malfunction. This must be confirmed before designing the query.

## Outstanding Questions

### Resolve Before Planning

_(none — all product decisions resolved)_

**Resolved during brainstorm:** `anchor_history.target_url` records `variant.target_url`, which is the fully resolved URL after `target_url_override` is applied (`publish-worker.ts:166`). The cooldown query (R2) and tier-3 exclusion (R3) will correctly find tier-2 target URLs in `anchor_history`. No alternative write path needed.

### Deferred to Planning

- [Affects R5][Needs research] What DA tier lookup path is available at batch dispatch time? Does the ROI scorer's data structure expose per-platform DA tier in a way the tier-2 selector can import without circular dependency?
- [Affects R10][Needs research] How does the anchor generation prompt currently receive target URL context (`callAnchorLLM`)? Can the tier-2 target URL + platform/title be injected via the existing prompt template, or does the template need a new variable?

## Next Steps

→ `/ce:plan` for structured implementation planning
