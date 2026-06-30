# Reel Radar — Content-First Discovery (Sub-C, Thrust 4) — Design Spec

**Date:** 2026-06-30
**Status:** Approved design → build
**Scope:** new `server/radar.js` (pipeline + pure scoring helpers), `server/db.js` (two new tables), `server/scheduler.js` (one new cron + manual-trigger guard), `server/index.js` (new `/radar/*` routes), `client/` (new Radar tab + watchlist panel; Suggested gets a `radar:*` source label). No new backend dependencies.
**Base branch:** off current `main` (PRs #1–#8 + discovery-reach Thrust 3 + view-median + CI all merged & live).
**Sub-project:** Sub-C **Thrust 4** — the *new-source* discovery thrust that Thrust 3 (Discovery Reach) explicitly deferred.

---

## 1. Context & Problem

Discovery today (`scraper.js#discoverRelated` + `scheduler.js#runDiscovery`) is a **mention/tag-graph walk**: it only surfaces accounts that are @mentioned in captions or photo-tagged by accounts you already track. Thrust 3 (Discovery Reach, already merged) made that walk *wider* (rotation over all sources), *cheaper* (one global enrichment pass), and *cumulative* (cross-cycle score accumulation) — but it stays **inside the graph by design** (its non-goals exclude new sources and content-first surfacing).

That leaves three limitations the team feels (all selected in brainstorm):

1. **Reach ceiling.** Discovery can never reach a creator who isn't mentioned/tagged by an existing seed. Genuinely new creators in the niche are invisible.
2. **Noisy suggestions.** Graph-adjacency is a weak quality signal — being tagged by a tracked account doesn't mean a creator is *viral*.
3. **Wrong unit.** The product is "find content worth recreating," but discovery surfaces *accounts*, not the *reels* that actually went viral.

**Reel Radar** adds a new, **content-first** discovery source that breaks out of the graph: it pulls top-performing reels directly from niche **hashtags**, scores them by **breakout magnitude** (how far a reel beats its own author's median), and surfaces both the **reels** (new Radar surface) and the **repeat-breakout authors** (rolled into the existing Suggested tab). It is complementary to — not a replacement for — Thrust 3's graph walk.

> **Actor note (carry-over):** the reel actor returns no `taggedUsers`, but the **generic** actor (`apify~instagram-scraper`, `resultsType:'posts'`) is the one used by discovery and returns full post metrics + author handles. Radar harvests via that same generic actor pointed at hashtag pages. See [[apify-actors-fields]].

## 2. Goals & Non-Goals

### Goals
- **Break the neighborhood ceiling:** discover reels/creators with zero graph connection to existing seeds, via a hybrid **hashtag watchlist**.
- **Kill noise with breakout scoring:** rank by `view_count ÷ author_median_views` so a reel is judged against its *own* author's norm, not absolute size.
- **Content-first surface:** the primary output is **reels** in a new Radar tab; breakout authors are a derived rollup into Suggested.
- **Cost-bounded:** a two-stage funnel (cheap absolute filter → enrich survivors only) keeps Apify spend proportional to *survivors*, all under the armed `APIFY_BUDGET_USD_30D` gate.
- **Reuse, don't reinvent:** breakout math from `engagement-metrics.js`; account rollup uses Thrust 3's accumulation upsert; gender filter, thumbnails, bulk-select UI, and the `_startApifyRun` ledger all reused.

### Non-Goals (deferred to v2)
- **Audio-based discovery** — not built until an actor is confirmed to harvest reels by sound (R-3 below).
- **Keyword search** and **IG related-profiles** sources.
- **Per-model niche scoping** — `watch_terms.model_id` is a nullable forward-hook only; not wired to any model in v1.
- Richer niche-fit (ML/embeddings) — v1 niche-fit is lightweight (term-match + caption/hashtag overlap).
- No change to the budget gate, Thrust 3 graph discovery, auto-scrape, rollups, cleanup, or idea-gen.

## 3. Decisions

| Decision | Choice |
|----------|--------|
| Discovery source (v1) | **Hashtags only.** Audio/keyword/related-profiles deferred (R-3). |
| Watchlist model | **Hybrid.** Auto-seed `kind='hashtag', source='auto'` from tracked accounts' `top_hashtags`; admins **pin** (`source='admin'`) and **exclude** (`status='excluded'` suppresses a matching auto term). |
| Storage of discovered reels | **New `radar_reels` table, separate from `posts`.** Keeps Library / engagement rollups / ER math tracked-only. A reel enters `posts` only on explicit **Save to Library** (reuses the existing upsert). |
| Account rollup | **Reuse `suggested_accounts`** with `source='radar:<term>'`; upsert via **Thrust 3's accumulation semantics** (merge source token, `suggestion_score = MAX(old,new)`, never demote/resurrect reviewed rows). |
| Cost model | **Two-stage funnel.** Stage 1: harvest + free absolute-floor filter + dedup. Stage 2: enrich only surviving authors (capped) to get `author_median_views`. |
| Breakout math | **Reuse `engagement-metrics.js`** `median()` over the author's fetched recent reels; `breakout = view_count ÷ max(author_median_views, floor)`, capped. Unknown median → absolute-percentile fallback (never silently 0). |
| Thumbnails | **Live IG CDN URL in Radar (no caching).** Download/cache via `thumbnails.js` **only on Save to Library**. Avoids volume/download cost for the majority that get dismissed. |
| Cadence | New weekly cron (`0 6 * * 1`, tunable) + **"Run Radar now"** manual trigger guarded by the existing `hasActiveJob` collision pattern. |
| Budget interaction | Every Apify call routes through `_startApifyRun` (ledgered + soft-capped). Per-cycle caps keep Radar in its lane within the shared $10/30d pool. |

## 4. Architecture

### 4a. Data model (`db.js`, additive; `isoNoMillis`/`NOW_DEFAULT` timestamps; dual-mode twins)

**`watch_terms`** — the hybrid watchlist:
```
id, term TEXT, kind TEXT ('hashtag'|'audio'|'keyword'),
source TEXT ('auto'|'admin'), status TEXT ('active'|'excluded'|'paused'),
model_id INTEGER DEFAULT NULL,            -- forward hook, unused in v1
added_at TEXT DEFAULT <now>, last_run_at TEXT DEFAULT NULL, notes TEXT DEFAULT ''
UNIQUE(term, kind)
```

**`radar_reels`** — discovered reels (separate from `posts`):
```
id, shortcode TEXT UNIQUE NOT NULL, account_handle TEXT,
video_url TEXT, thumbnail_url TEXT, caption TEXT,
like_count INTEGER, comment_count INTEGER, view_count INTEGER,
posted_at TEXT, post_url TEXT,
discovered_via TEXT,                       -- the watch term
author_followers INTEGER DEFAULT NULL, author_median_views INTEGER DEFAULT NULL,
breakout_score REAL DEFAULT 0, niche_fit_score REAL DEFAULT 0, total_score REAL DEFAULT 0,
status TEXT DEFAULT 'new',                  -- new | saved | dismissed
discovered_at TEXT DEFAULT <now>
```

`suggested_accounts` is reused unchanged (existing columns: `source, suggestion_score, status, relevance_reason, top_hashtags, …`).

### 4b. Pipeline (`server/radar.js`) — pure helpers exported for tests; all Apify via `_startApifyRun`
1. **Resolve watchlist** — `selectWatchTerms(terms, max)`: `status='active'` (auto∪admin) minus terms with an `excluded` twin; order `last_run_at ASC` (NULL first); take `RADAR_TERMS_PER_CYCLE`. Pure, unit-tested (mirrors `selectDiscoverySources`).
2. **Harvest** — per term: one generic-actor run on the hashtag (`resultsType:'posts'`, `resultsLimit=RADAR_RESULTS_PER_TERM`); keep `type==='Video'`/reels. Stamp `last_run_at` best-effort (success or fail). *(R-1 / R-2 below.)*
3. **Stage-1 filter (free)** — `passesFloors(reel, cfg)`: drop below `RADAR_MIN_VIEWS` / `RADAR_MIN_LIKES` / older than `RADAR_MAX_AGE_DAYS`. Pure.
4. **Dedup** — drop shortcodes already in `posts` or `radar_reels`; drop authors already in `tracked_accounts` or with an **`approved`/`dismissed`** `suggested_accounts` row (don't re-surface accepted-or-rejected accounts). Authors with a `pending`/`snoozed` suggestion are *kept* — their rollup just accumulates the score in step 7. Reuse existing handle normalization.
5. **Stage-2 enrichment (survivors only)** — for distinct surviving authors (≤ `RADAR_AUTHORS_ENRICH_MAX`): one generic-actor profile/recent-reels fetch → `author_followers` + `author_median_views` via `engagement-metrics.median()` over fetched reel views.
6. **Score** — `scoreReel(reel, author, cfg)` (pure): `breakout = clamp(view_count ÷ max(author_median_views, VIEW_FLOOR))`; `niche_fit = term-match baseline + caption/hashtag overlap`; `total = wB·breakout + wN·niche_fit`. Unknown median → absolute-percentile breakout fallback. Upsert into `radar_reels` (status `new`).
7. **Account rollup** — authors with `≥ RADAR_ROLLUP_MIN_BREAKOUTS` reels (or one ≥ `RADAR_ROLLUP_SOLO_BREAKOUT`) → gender-classify (reuse `_classifyGenderBatch`, drop male) → upsert into `suggested_accounts` (`source='radar:<term>'`, `suggestion_score` from best/avg breakout) using Thrust 3's accumulation upsert.
8. **Metric** — `[Metric] radar terms=<n> harvested=<n> survivors=<n> enriched=<n> reels=<n> authors=<n>`.

### 4c. Routes (`index.js`, behind `requireAuth`)
- `GET /radar/reels?term&min_breakout&since&status` — paged Radar feed (default sort `total_score DESC`).
- `POST /radar/reels/:shortcode/save` — promote into `posts` (existing upsert) + cache thumbnail; set `status='saved'`.
- `POST /radar/reels/:shortcode/dismiss` — `status='dismissed'`.
- `POST /radar/reels/bulk` — `{ shortcodes[], action:'save'|'dismiss' }` (reuse Sub-D bulk pattern).
- `GET /radar/terms` · `POST /radar/terms` (pin) · `PATCH /radar/terms/:id` (exclude/pause).
- `POST /radar/run` — manual trigger, `hasActiveJob`-guarded.

### 4d. Scheduler (`scheduler.js`)
- New cron `0 6 * * 1` → `radar.runRadar()`; manual↔auto collision guard reusing the existing pattern.

### 4e. Client (`client/`)
- **Radar tab:** reels grid (reuse Library card/grid), default sort `total_score`; per-card badge (untracked), breakout multiplier ("12× median"), `via #term`; actions Save / Track author / Dismiss; bulk save/dismiss (reuse Sub-D multi-select). Thumbnails served from live `thumbnail_url`.
- **Watchlist panel** (in Radar tab): list terms (source/status), pin / exclude / pause, show `last_run_at` + reels-surfaced count per term.
- **Suggested:** render `radar:*` source label + reason ("3 breakout reels via #x, best 12× median"); add a "Radar-sourced" filter. No new approve/reject logic.

### 4f. Config (env, defaults preserve a small footprint)
`RADAR_TERMS_PER_CYCLE=10` · `RADAR_RESULTS_PER_TERM=50` · `RADAR_AUTHORS_ENRICH_MAX=20` · `RADAR_MIN_VIEWS=50000` · `RADAR_MIN_LIKES=1000` · `RADAR_MAX_AGE_DAYS=14` · `RADAR_VIEW_FLOOR=1000` (median floor, avoids divide-by-tiny) · `RADAR_ROLLUP_MIN_BREAKOUTS=2` · `RADAR_ROLLUP_SOLO_BREAKOUT=10` (a single ≥10× reel rolls the author up) · scoring weights `RADAR_W_BREAKOUT=0.7` / `RADAR_W_NICHE=0.3`. All defaults are starting points, env-tunable.

## 5. Cost & Risk

- **Per cycle (worst case):** ≤ `RADAR_TERMS_PER_CYCLE` harvest runs (10) + ≤ `RADAR_AUTHORS_ENRICH_MAX` author fetches (20) + 1 gender-classify. Two-stage funnel means enrichment scales with *survivors*, not raw harvest. Every call is ledgered + soft-capped; Radar stops launching new term-runs when the 30-day total hits the cap (never kills in-flight, auto-resumes).
- **Shared budget:** Radar draws from the same $10/30d pool as core scraping — per-cycle caps + weekly cadence keep it bounded. If contention shows up, lower `RADAR_TERMS_PER_CYCLE`.
- **Thumbnail expiry:** Radar shows live CDN thumbs that 403 after a few days — acceptable for a weekly-reviewed feed; caching happens on Save.
- **Rollup safety:** accumulation upsert never demotes or resurrects reviewed suggestions (inherited from Thrust 3).

## 6. Open Verifications (with fallbacks — proven by a single-run spike before pipeline build)

- **R-1 (load-bearing):** does `apify~instagram-scraper` return hashtag posts with engagement + author handle (via `directUrls:['…/explore/tags/<tag>/']` *or* `search`+`searchType:'hashtag'`)? Fallback: a dedicated Apify hashtag actor.
- **R-2:** does hashtag-mode include `view_count` on reels? If absent, breakout uses a likes-percentile until the stage-2 author fetch backfills views.
- **R-3 (audio, v2 only):** confirm an actor can harvest reels by sound before building that source. Out of v1 scope.

## 7. Test Plan (`server/radar.test.js`, `node --test`, keep CI green)
- `selectWatchTerms`: active∪admin, excluded suppresses matching auto term, `last_run_at` ordering (NULL first), cap, deterministic tie-break, empty input.
- `passesFloors`: views/likes/age boundaries.
- Dedup: shortcode in `posts`/`radar_reels`; author tracked / reviewed-out.
- `scoreReel`: breakout ratio + cap; unknown-median percentile fallback; weight blend; niche-fit overlap.
- Rollup threshold: `≥ MIN_BREAKOUTS` vs solo-breakout; `suggestion_score` derivation; accumulation upsert doesn't demote a reviewed row (sqlite fixture).
- Offline mocked-Apify `runRadar` smoke (no network), like `ai-agent`/cost tests.
- New tables exercised through `initDB()` dual-mode in the integration test.

## 8. Phasing
- **v1 (this spec):** hashtag source, two-stage funnel, breakout+niche scoring, `radar_reels` + `watch_terms`, Radar tab + watchlist panel, Suggested rollup, weekly cron + manual trigger, cost caps, tests.
- **v2 (deferred):** audio discovery (pending R-3), keyword search, IG related-profiles, per-model niche scoping (`model_id` wiring), richer niche-fit.

## 9. Parallelization note (for the split build)
Backend (`server/` + `db.js`) and frontend (`client/`) touch disjoint directories and meet only at the §4c JSON API contract. They can be built on separate branches with near-zero conflict once this spec + the implementation plan are committed. The §4c route shapes are the frozen contract between the two slices.
