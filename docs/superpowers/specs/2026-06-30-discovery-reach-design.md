# Discovery Reach (Sub-C, Thrust 3) — Design Spec

**Date:** 2026-06-30
**Status:** Approved design → build
**Scope:** `server/scheduler.js` (`runDiscovery` rewrite + new pure source-selection helper), `server/scraper.js` (`discoverRelated` gains an opt-out of inline enrichment; enrichment/gender extracted into reusable methods), `server/db.js` (one new column), no `index.js` behavior change. No new dependencies.
**Base branch:** `claude/instascraper-discovery-hardening-1w7499`, off current `main` (PRs #1–#8 merged & live).
**Sub-project:** Sub-C **Thrust 3** ("reach / discovery expansion"), the last roadmap item, explicitly deferred by Thrust 2 (PR #8).

---

## 1. Context & Problem

`runDiscovery` ([scheduler.js:177](../../../server/scheduler.js)) runs weekly (`cron 0 4 * * 1`) and seeds candidate discovery from `trackedResult.rows.slice(0, 5)` — **only the first 5 active accounts**, in arbitrary DB order. Verified against the code:

- **Reach is capped at 5 and never rotates.** As the tracked set grows past 5, the same first-5 accounts seed discovery every cycle and the rest are never mined. There is no ordering, so which 5 is incidental.
- **Enrichment is per-source and duplicated.** Each source's `discoverRelated` ([scraper.js:612](../../../server/scraper.js)) independently enriches up to 4 candidates via Apify *and* gender-classifies its own batch. A candidate tagged by several sources can be enriched and classified once per source — wasted Apify/Anthropic calls — because dedup (`aggregateCandidates`) happens *after*, in `runDiscovery`.
- **No cross-cycle accumulation.** Suggestions upsert with `ON CONFLICT (username) DO NOTHING` ([scheduler.js:210](../../../server/scheduler.js)). A candidate re-surfaced by a *new* source in a later cycle never bumps its `collabStrength`/`suggestion_score`, so "collab'd with N of your creators" undercounts across cycles.

Thrust 2 made *scraping* cadence smart and bounded; discovery is still narrow and wasteful. The now-armed budget (`APIFY_BUDGET_USD_30D=10`) caps spend but doesn't widen reach or cut waste. This thrust widens reach (rotation), de-duplicates enrichment (one global pass), and makes collab strength cumulative.

> **Carry-over finding (handoff):** the reel actor returns no `taggedUsers`, so the main-scrape collab path yields ~0. Discovery is unaffected: it uses the **generic** actor (`resultsType: 'posts'`), which does return `taggedUsers`/`usertags`, plus caption `@mention` mining. Reach work stays on the generic-actor path.

## 2. Goals & Non-Goals

### Goals
- **Reach via rotation:** over successive cycles, discover from *all* active accounts, not a fixed first-5 — least-recently-discovered first, capped per cycle.
- **Cheaper enrichment:** enrich each unique candidate at most once per cycle, via a single global pass with a hard cap, instead of per-source.
- **Cross-cycle dedup/accumulation:** when a new source re-surfaces an existing suggestion, merge the source and bump its score instead of ignoring it.
- **Observable & bounded:** one metric line (sources / candidates / enriched / added); per-cycle Apify cost stays in the same ballpark as today and remains under the budget gate.

### Non-Goals (deferred)
- No mentions-pivot / building collab capture on the reel path (handoff: low-value, reel actor has no taggedUsers).
- No change to the budget gate, manual scrape, auto-scrape (Thrust 2), rollup, cleanup, or idea-gen jobs.
- No second-degree discovery (discovering from suggested, not just tracked).
- No UI change to the suggestions review surface.

## 3. Decisions

| Decision | Choice |
|----------|--------|
| Reach model | **Rotation, not all-at-once.** Select active accounts least-recently-used as a discovery source, capped at `DISCOVERY_MAX_SOURCES` (default **5** — preserves today's per-cycle source cost while guaranteeing full coverage over time). |
| Rotation key | New `tracked_accounts.last_discovery_at` (TEXT, ISO). Never-discovered → highest priority. Stamped best-effort after each source is attempted (success or failure), so a failing source doesn't wedge the rotation. |
| Source ordering | `last_discovery_at ASC`, never-discovered (NULL) first; tie-break by `username` for determinism. Done as a **pure JS helper** (`selectDiscoverySources`) over fetched rows — dual-mode-safe (no `NULLS FIRST` SQL), unit-testable like the cadence helpers. |
| Enrichment | **One global pass.** Sources harvest candidates *without* inline enrichment/gender. `runDiscovery` aggregates (dedup), then enriches the top `DISCOVERY_ENRICH_MAX` (default **8**) unique candidates once each, then gender-classifies the whole batch once. |
| Harvest mode | `discoverRelated(username, { enrich: false })` returns raw harvested candidates (DB caption+tagged mining + one generic-actor posts scrape for mentions/tagged). `enrich` defaults to `true` → fully backward-compatible for any existing caller. |
| Cross-cycle accumulation | Upsert changes from `DO NOTHING` to `DO UPDATE`: merge `source` (append new source token if absent), `suggestion_score = MAX(old, new)`, refresh `relevance_reason`, and keep the better (non-zero) enrichment fields. Only un-reviewed rows are bumped (don't resurrect dismissed/approved suggestions' scoring). |
| Per-cycle global cap | Aggregated candidates still truncated (`slice(0, 50)`) before insert, as today. |

## 4. Architecture

### 4a. Pure helper (`scheduler.js`, exported for tests)
- `selectDiscoverySources(accounts, max, ) → Account[]` — sort by `last_discovery_at` ascending with NULL (never-discovered) first, tie-break `username` asc; take `max`. Pure, no I/O.

### 4b. `discoverRelated(username, opts)` (`scraper.js`)
- New second arg `opts = { enrich = true }`.
- Phases 1–2 (DB mining + generic-actor mentions/tagged harvest) unchanged.
- When `enrich === false`: return the harvested candidate list immediately (deduped within the call via the existing `seen` set), **skipping** the per-candidate Apify enrichment block and the gender-classify/male-drop tail.
- When `enrich === true`: unchanged (existing per-source enrichment + gender filter) — preserves the current contract and tests.
- Extract the existing enrichment-of-one and gender-batch logic so `runDiscovery` can reuse them:
  - `enrichCandidates(candidates, max)` — DB-first enrichment for all; Apify `_fetchProfileQuick` for up to `max` that lack DB data; mutates/returns the list. (Refactor of the current inline block.)
  - `_classifyGenderBatch` already exists and is batch-shaped — reuse as-is.

### 4c. `runDiscovery` rewrite (`scheduler.js`)
1. Load active accounts with `username, last_discovery_at`; build `existing` set (tracked ∪ suggested) as today.
2. `sources = selectDiscoverySources(accounts, DISCOVERY_MAX_SOURCES)`.
3. For each source: `discoverRelated(src, { enrich: false })`, collect candidates not in `existing`; stamp `last_discovery_at = NOW()` best-effort; throttle (existing 10s gap).
4. `aggregated = aggregateCandidates(raw)` (cross-source dedup, collabStrength).
5. `enrichCandidates(aggregated-sorted-by-collabStrength, DISCOVERY_ENRICH_MAX)` — single global pass, each unique candidate enriched ≤ once.
6. Gender-classify the aggregated batch once; drop males.
7. Score (`scoreCandidate`) + upsert with `DO UPDATE` accumulation; `slice(0, 50)` cap retained.
8. Metric: `[Metric] discovery sources=<n> candidates=<n> enriched=<n> female=<n> added=<n>`.

### 4d. Config (`scheduler.js`, env-tunable, defaults preserve today's cost)
- `DISCOVERY_MAX_SOURCES=5`
- `DISCOVERY_ENRICH_MAX=8`

### 4e. DB (`db.js`)
- `ALTER TABLE tracked_accounts ADD COLUMN IF NOT EXISTS last_discovery_at TEXT DEFAULT NULL` (+ the no-`IF NOT EXISTS` sqlite-dev twin, matching the existing migration block).

## 5. Cost & Risk

- **Per cycle:** ≤ `DISCOVERY_MAX_SOURCES` generic posts-scrapes (5) + ≤ `DISCOVERY_ENRICH_MAX` profile fetches (8) + 1 gender-classify call. That is **lower** than today's worst case (5 sources × (1 scrape + 4 enrich) = 25 Apify calls) because enrichment is now global and deduped (≤ 5 + 8 = 13). Budget gate still wraps every Apify call.
- **Rotation safety:** stamping `last_discovery_at` even on failure prevents a perpetually-failing source from blocking the queue; fail-open ordering means new accounts surface first.
- **Accumulation safety:** only un-reviewed suggestions get re-scored, so dismissals/approvals aren't disturbed; `MAX` score is monotonic (never demotes).

## 6. Test Plan (`server/discovery-reach.test.js`, `node --test`)
- `selectDiscoverySources`: never-discovered first; oldest-first among dated; cap respected; deterministic tie-break; empty input.
- Accumulation SQL semantics on a sqlite fixture: first insert sets score; second insert from a new source bumps score (MAX) and merges source; a reviewed row is not demoted.
- `discoverRelated(..., {enrich:false})` returns harvested candidates without invoking Apify enrichment (DB-mining path, no network) — guarded so it runs offline.
