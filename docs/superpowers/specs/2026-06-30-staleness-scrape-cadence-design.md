# Staleness-Based Scrape Cadence (Sub-C, Thrust 2) — Design Spec

**Date:** 2026-06-30
**Status:** Approved design (brainstorm) → awaiting spec sign-off
**Scope:** `server/scheduler.js` (`runAutoScrape` rewrite + new pure cadence helpers), `server/scraper.js` (record success/failure on `tracked_accounts` in the completion paths), `server/db.js` (two new columns), `server/index.js` (no behavior change; only the existing `/scheduler/status` reflects new metrics). No new dependencies.
**Base branch:** `staleness-scrape-cadence`, off current `main` (PRs #1–#7 merged & live).
**Sub-project:** Sub-C **Thrust 2** ("scheduling-cadence rework"), the piece the cost-control spec (Thrust 1, PR #3) explicitly deferred. Thrust 3 (reach/discovery expansion) is a separate later spec.

---

## 1. Context & Problem

Auto-scrape runs every 3 days and scrapes **every** active account uniformly ([scheduler.js:189](../../../server/scheduler.js) `cron 0 3 */3 * *` → [runAutoScrape:17](../../../server/scheduler.js)). Verified against the code:

- **No prioritization.** A creator who posts daily and one who hasn't posted in a month are scraped on the identical 3-day clock. The daily poster's library goes stale between runs; the dormant one wastes an Apify run (~$0.05–0.11 each) on nothing new.
- **Failures aren't dampened.** `last_scraped_at` is only set on a *successful* scrape ([scraper.js:516-520](../../../server/scraper.js)); a private/renamed/0-reel account (the handoff's `kaylaa.christine`, `sabrinasnowww`) fails every cycle yet is retried every cycle at full cost.
- **No per-cycle ceiling.** As the tracked set grows, every cycle scrapes all of it; the only brake is the rolling-30-day soft cap (PR #3), which is a *spend* ceiling, not a *cadence* control.

The now-armed budget (`APIFY_BUDGET_USD_30D`) bounds total spend but doesn't make the spend *smart*. This thrust concentrates Apify runs where they buy freshness and backs off where they don't.

## 2. Goals & Non-Goals

### Goals
- **Frequency-aware cadence:** scrape active posters more often, quiet accounts less.
- **Failure backoff:** an account that fails/returns nothing repeatedly steps aside with a growing cooldown instead of consuming a slot every cycle.
- **Per-cycle run cap:** a hard ceiling on auto-scrapes per run, ordered most-overdue first.
- **Observable:** one metric line per cycle (due / scraped / capped / backed-off).

### Non-Goals (deferred)
- **Thrust 3** reach/discovery expansion (discover from all tracked, cross-account dedup, cheaper enrichment) — separate spec.
- No change to the budget gate, manual scrape, rollup, cleanup, idea-gen, or discovery jobs.
- No true sequential-await-on-completion (auto-scrape still launches jobs that finalize asynchronously; the cap + interval bound concurrency in practice). Documented, not solved here.
- No per-account manual cadence overrides (could be a later nicety).

## 3. Decisions (from brainstorm)

| Decision | Choice |
|----------|--------|
| Cadence model | **Hybrid (C):** frequency-derived per-account interval **+** per-cycle run cap. |
| Interval tiers | From posts/week: **active → 2d, moderate → 4d, quiet → 8d** (env-tunable; default thresholds below). |
| Due rule | Due when `now − last_scraped_at ≥ interval`. Never-scraped → immediately due. |
| Failure backoff | `consecutive_failures` drives a cooldown `min(BASE_BACKOFF × 2^(failures−1), MAX_BACKOFF)` measured from `last_attempt_at`; in-cooldown accounts are not due. |
| What counts as failure | Apify run FAILED/ABORTED/TIMED-OUT **or** completed-with-0-posts. Success-with-≥1-post resets `consecutive_failures` to 0. |
| Per-cycle cap | `SCRAPE_MAX_PER_CYCLE` (default 10) most-overdue due accounts. |
| Schedule | Run **daily** (`cron 0 3 * * *`, was every-3-days); the interval + cap control real spend. |

## 4. Architecture

### 4a. Pure cadence helpers (`scheduler.js`, exported for tests)
- `computeInterval(postsPerWeek) → days` — `≥ ACTIVE_PPW (4) → 2`; `≥ MODERATE_PPW (1) → 4`; else `8`. Thresholds/intervals read from env with these defaults.
- `backoffDays(consecutiveFailures) → days` — `0 → 0`; else `min(BASE_BACKOFF (1) × 2^(failures−1), MAX_BACKOFF (14))`.
- `isDue(acct, now) → boolean` — `true` if never scraped; else requires `daysSince(last_scraped_at) ≥ computeInterval(acct.postsPerWeek)` **and** `daysSince(last_attempt_at) ≥ backoffDays(acct.consecutive_failures)`.
- `selectDueAccounts(accounts, cap, now) → Account[]` — filter `isDue`, sort by **most overdue** (`daysSince(last_scraped_at)` desc, never-scraped first), take `cap`.

All pure (take `now` and plain account objects), no I/O — unit-tested like the existing `scoreCandidate`/`aggregateCandidates` helpers.

### 4b. `runAutoScrape` rewrite (`scheduler.js`)
1. Load active accounts with `username, last_scraped_at, last_attempt_at, consecutive_failures`.
2. For each, compute `postsPerWeek` — one grouped query over `posts` (count in the trailing `FREQ_WINDOW_DAYS` (default 28) ÷ weeks), joined in memory; accounts with no recent posts → `postsPerWeek = 0` (→ quiet tier).
3. `due = selectDueAccounts(accounts, SCRAPE_MAX_PER_CYCLE, now)`.
4. For each due account: set `last_attempt_at = now` (so a launch counts as an attempt even before completion), then `startScrapeJob(...)` (budget-gated, unchanged). On `BudgetExceededError`, stop the cycle (same as today) and report partial.
5. `console.log('[Metric] cadence due=<d> scraped=<s> capped=<c> backed_off=<b>')` and set `jobStatus.autoScrape.message`.

### 4c. Success/failure recording (`scraper.js` completion paths)
All updates key on **`filters.query`** (the requested account label), not `accountHandle` — because on a 0-result run `accountHandle` (derived from scraped items) is empty. They run only for username scrapes (`filters.queryType === 'username'` / a non-hashtag/non-url query) so hashtag/import runs don't touch `tracked_accounts`. All best-effort (`try/catch`, never break the job).
- **Success-with-posts** (`_fetchAndStoreResults`, `count ≥ 1`): in addition to the existing `last_scraped_at` update, set `consecutive_failures = 0` for `WHERE username = filters.query`.
- **Completed-0-posts** (`_fetchAndStoreResults`, `count === 0`): set `consecutive_failures = consecutive_failures + 1` for `WHERE username = filters.query`. `last_scraped_at` is already *not* advanced here (the existing update is gated on a non-empty `accountHandle`, which is empty when nothing was scraped) — so no change is needed to preserve that; the backoff (`last_attempt_at` + failures) is what holds the account back.
- **Run failure** (`_pollAndStore` FAILED/ABORTED/TIMED-OUT and polling-timeout branches): `consecutive_failures = consecutive_failures + 1` for `WHERE username = filters.query`.

### 4d. Configuration (env, all optional with defaults)
`SCRAPE_MAX_PER_CYCLE=10`, `CADENCE_ACTIVE_PPW=4`, `CADENCE_MODERATE_PPW=1`, `CADENCE_INTERVAL_ACTIVE=2`, `CADENCE_INTERVAL_MODERATE=4`, `CADENCE_INTERVAL_QUIET=8`, `CADENCE_FREQ_WINDOW_DAYS=28`, `CADENCE_BACKOFF_BASE=1`, `CADENCE_BACKOFF_MAX=14`. Unset → defaults reproduce a sane cadence.

## 5. Data Model
`tracked_accounts` gains two nullable columns via the existing dual-mode migration list in `db.js` (both arms):
- `last_attempt_at TEXT DEFAULT NULL`
- `consecutive_failures INTEGER DEFAULT 0`

No other schema change. `last_scraped_at`, `last_post_count`, `posts.posted_at` are reused.

## 6. Observability
- `[Metric] cadence due=<d> scraped=<s> capped=<c> backed_off=<b>` per cycle.
- `jobStatus.autoScrape.message` shows e.g. `Scraped 7 of 9 due (cap 10), 2 backed off`.
- On budget stop, the existing partial-stop message is kept.

## 7. Error Handling
- Cadence helpers are pure and total (no throw on missing/zero fields → quiet tier / immediately-due).
- Failure-recording updates are wrapped; a DB blip there never aborts a scrape.
- A malformed `last_attempt_at`/`last_scraped_at` parses to "very old" → account treated as due (fail-open to freshness, bounded by the cap), never crashes selection.

## 8. Testing (`node:test`, matching existing `server/*.test.js`)
- **`computeInterval`:** active/moderate/quiet thresholds incl. boundaries; 0 posts/week → quiet.
- **`backoffDays`:** 0 failures → 0; 1 → BASE; doubles each failure; clamps at MAX.
- **`isDue`:** never-scraped → due; within interval → not due; past interval but in backoff cooldown → not due; past both → due.
- **`selectDueAccounts`:** filters non-due; orders most-overdue first (never-scraped ahead of stale); respects the cap; a chronically-failing account is excluded while in cooldown so it can't starve healthy due accounts.
- **Recording semantics (sqlite round-trip):** success-with-posts → `consecutive_failures = 0`; completed-0-posts → increments and does not advance `last_scraped_at`; failure path increments.

## 9. Risks & Verification
1. **Async completion vs. `last_attempt_at`.** Setting `last_attempt_at` at launch (not completion) is intentional — it's the backoff clock and prevents a slow/failing account from being re-selected next cycle before its prior run resolves. Verify: a failing account is not re-picked the following day.
2. **Frequency query cost.** One grouped count over `posts` per cycle — cheap; indexed on `account_handle`. Verify it adds negligible time.
3. **Cap too low for a large tracked set.** With cap 10 and many active accounts, the most-overdue rotate in over days. Acceptable and tunable; the metric surfaces `capped=<c>` so starvation is visible.
4. **Manual scrape interaction.** Manual scrapes update `last_scraped_at`/`consecutive_failures` like auto, so a manual refresh correctly makes an account not-due. Verify a manual scrape resets the cadence clock.

## 10. Summary of Changes
| File | Change |
|------|--------|
| `server/db.js` | `tracked_accounts.last_attempt_at TEXT`, `consecutive_failures INTEGER DEFAULT 0` (dual-mode migration). |
| `server/scheduler.js` | New pure helpers (`computeInterval`, `backoffDays`, `isDue`, `selectDueAccounts`); `runAutoScrape` selects due-and-capped accounts, sets `last_attempt_at`, logs cadence metric; cron → daily. |
| `server/scraper.js` | Completion paths record `consecutive_failures` (reset on success-with-posts, increment on 0-posts/failure). |
| `server/*.test.js` | Helper + recording-semantics tests per §8. |
