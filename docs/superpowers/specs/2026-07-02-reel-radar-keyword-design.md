# Reel Radar v2 — Keyword-Driven Creator Discovery — Design

**Date:** 2026-07-02
**Branch:** `feat/reel-radar-keyword` (off `main`)

## Problem

Network discovery has converged for the roster — it re-finds already-known/male/mega accounts and adds ~0 new sub-500K female reel creators (see [[discovery-network-converged]]). We need a discovery source that finds fresh creators independent of the roster's network: **keyword search** ("blonde", "petite", …).

## Research verdict (validated by spikes, 2026-07-02)

| Approach | Result |
|---|---|
| Hashtag harvest via generic actor | real posts but **0 reels** (images/carousels only) — dead end |
| `apify/instagram-search-scraper` `searchType:"popular"` | **fails** (`no_items`) |
| `apify/instagram-search-scraper` `searchType:"user"` | accounts by name/handle match (returned a brand) — weak |
| **`data-slayer/instagram-search-reels`** (`query`) | ✅ **content-relevant reels + views + creator handles**, ~$0.008/search |

`query:"blonde"` returned 12 reels from 12 distinct creators (e.g. `kameron.whit` 50,178 plays, caption "Blonde is the outfit…"). Fields per reel: `ig_play_count`, `like_count`, `comment_count`, `user.username`, `user.full_name`, `code` (shortcode), `caption.text`, `caption.hashtags`, `taken_at_date`, `video_url`, `thumbnail_url`. Pricing ~$1.50/1,000 results, pay-per-event. Not blocked (unlike the profile/generic actor).

## Approach: author-centric

The parked `reel-radar-discovery` branch (26 commits, on hold) was built on the hashtag/generic-actor harvest that yields 0 reels — its harvest is a dead end. We **rebuild fresh on `main`, reusing its pure helpers**, and swap the harvest to the keyword actor. The search reels are the *discovery signal*; we extract the **creators** and feed them into the pipeline shipped today (reel previews + reel-performance scoring). Radar results therefore appear **in the existing Suggested tab** — no separate radar reel-browser, no `radar_reels` table.

Per-keyword pipeline (`runRadar`):
> keyword → `data-slayer/instagram-search-reels` harvest → normalize → dedupe reels → collect distinct **authors** → gender-classify, drop males (mirror discovery) → skip authors already in `suggested_accounts`/`tracked_accounts` → `INSERT` new authors into `suggested_accounts` (`source = radar:<term>`, `relevance_reason = "found via '<term>' — <N> view reel"`) → **`captureTopReels(author)`** (today's method: pulls the author's profile top-3 reels, persists to `suggested_reels`, computes `scoreReels`, writes `suggestion_score`).

So a radar-found creator lands in Suggested with a real reel-performance score and a 3-reel preview strip, tagged with the keyword that surfaced them.

## Components

### `watch_terms` table (reuse from branch, one tweak)
Additive `CREATE TABLE IF NOT EXISTS watch_terms` in `initDB` (dual-mode), exactly as on the branch **except** `kind TEXT DEFAULT 'keyword'` (was `'hashtag'`):
```
id ${SERIAL}, term TEXT NOT NULL, kind TEXT DEFAULT 'keyword', source TEXT DEFAULT 'user',
status TEXT DEFAULT 'active', added_at TEXT DEFAULT ${NOW_DEFAULT}, last_run_at TEXT DEFAULT NULL,
notes TEXT DEFAULT '', UNIQUE(term, kind)
```
No `radar_reels` table (author-centric).

### `server/radar.js` (new file, rebuilt on main)
- **Reused pure helpers** (ported from branch, unit-tested): `radarConfig(env)`, `selectWatchTerms(terms, max)`, `dedupeReels(reels, {knownShortcodes})`, `excludeAuthors(reels, {blockedHandles})`, `selectRollupAuthors(reels, cfg)` (distinct authors, capped), `passesFloors(reel, cfg)` (min views/age gate).
- **New:** `harvestKeyword(scraper, term, cfg)` — runs `RADAR_ACTOR_ID` (default `data-slayer~instagram-search-reels`) with `{ query: term, maxPages: cfg.maxPages }` via `scraper._startApifyRun` + `_waitForRun`; returns raw items.
- **New:** `normalizeSearchReel(item, term)` (pure, unit-tested) → `{ shortcode: item.code, ownerUsername: item.user?.username, viewCount: item.ig_play_count ?? null, likeCount: item.like_count ?? 0, commentCount: item.comment_count ?? 0, caption: item.caption?.text || '', postedAt, permalink: 'https://www.instagram.com/reel/'+code+'/', term }` where `postedAt` = `taken_at_date` normalized to ISO (tolerate an ISO string OR an epoch-seconds number OR null). Returns `null` for items missing `code` or `user.username` (caller filters those out).
- **Reused orchestration** `runRadar(scraper, {env})`: select active watch terms (cap `termsPerCycle`) → per term: harvest → normalize → `passesFloors`/`dedupeReels` → collect authors (`selectRollupAuthors`) → gender-classify batch (reuse `scraperInstance._classifyGenderBatch`), drop males → skip known (in `suggested_accounts`/`tracked_accounts`) → INSERT new authors into `suggested_accounts` → `await scraperInstance.captureTopReels(author)` (bounded by budget guard; `BudgetExceededError` → stop, mirroring discovery) → update `watch_terms.last_run_at`. Emits a `[Metric] radar terms=.. authors=.. added=.. reels=..` line. Guards against the third-party actor via today's `isErrorStubResponse` (harvest that's all error-stubs → skip term, log).
- `getRadarStatus()` + `radarState` (reuse) for the status endpoint.

### Routes (`server/index.js`, behind `requireAuth`)
- `GET /radar/terms` — list watch terms.
- `POST /radar/terms` — add `{ term }` (kind `keyword`, source `user`); `ON CONFLICT (term,kind) DO NOTHING`.
- `PATCH /radar/terms/:id` — set `status` (active/paused) — for enable/disable without delete.
- `DELETE /radar/terms/:id` — remove a term.
- `POST /radar/run` — fire-and-forget `runRadar(scraperInstance)`; returns `{ started: true }`.
(Reuse the branch's route bodies; drop `/radar/reels*` save/dismiss/bulk — not needed author-centric.)

### Frontend (`client/src/pages/SuggestedAccountsTab.js`)
A small **"Reel Radar" panel** in the Suggested tab header: a text input to add a keyword, a chip list of active terms (each with a remove ✕), and a **"Run Radar"** button (mirrors the existing "Run Discovery" button's fire-and-forget + poll pattern). Radar-found creators appear in the normal suggestions list (they're `suggested_accounts`), tagged by `source = radar:<term>` shown in the existing relevance-reason line. The term list is **user-managed and starts empty** (the UI reads whatever is in `watch_terms`). The keywords already provided (blonde, petite, domination, …) are loaded once **post-deploy via a one-time seed step** (a `POST /radar/terms` per keyword, like the reel-score backfill) — not hardcoded in the app.

### Cron (`server/scheduler.js`)
Weekly `cron.schedule('0 6 * * 1', () => runRadar(scraperInstance))` (Monday 6am UTC, after discovery's 4am), guarded by scraper/apiKey presence.

### Config (`radarConfig`, env-tunable)
| Field | Env | Default |
|---|---|---|
| `termsPerCycle` | `RADAR_TERMS_PER_CYCLE` | 10 |
| `maxPages` | `RADAR_MAX_PAGES` | 1 |
| `authorsMax` | `RADAR_AUTHORS_MAX` | 30 (cap captures/cycle) |
| `minViews` | `RADAR_MIN_VIEWS` | 20000 (reel floor to count an author) |
| `maxAgeDays` | `RADAR_MAX_AGE_DAYS` | 30 |
| `actorId` | `RADAR_ACTOR_ID` | `data-slayer~instagram-search-reels` |

No follower cap in v1 (keyword search surfaces mid-tier creators; the reel-performance score handles quality). Third-party actor risk mitigated by the env-swappable `actorId` + error-stub detection + logging.

## Testing (TDD, `node --test`)
- **`normalizeSearchReel`** (pure): maps a real data-slayer item → our shape; missing `code`/`user.username` → skipped; null `ig_play_count` → `viewCount: null`.
- **`radarConfig`**: defaults + env override + non-numeric fallback (mirrors `discoveryConfig` test).
- **`selectWatchTerms` / `dedupeReels` / `selectRollupAuthors` / `passesFloors`**: ported pure-helper tests from the branch (dedupe by shortcode, author cap, floors reject low-views/old).
- **`watch_terms` insert contract**: dual-mode `INSERT ... ON CONFLICT (term,kind) DO NOTHING` round-trip (inline sqlite, mirrors existing db-contract tests).
- **Integration** (harvest→capture→serve): the `runRadar` orchestration and `harvestKeyword` are Apify/DB glue (no unit test); verified by a manual prod run after deploy (like discovery).

## Out of scope (YAGNI)
- The branch's `radar_reels` table + reel-browser tab + save/dismiss/bulk routes.
- Auto-seeding terms from post hashtags (was the branch's flaw — junk terms).
- Follower-cap filtering in radar; blending radar into `runDiscovery`.
- Multi-actor fallback (just env-swappable `actorId` for now).
