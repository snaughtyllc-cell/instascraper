# Scraping Cost Control — Design Spec

**Date:** 2026-06-30
**Status:** Approved design (brainstorm complete) → awaiting spec sign-off
**Scope:** `server/scraper.js`, `server/db.js` (one new table), `server/scheduler.js`, `server/index.js`, + unit tests. No changes to existing table shapes. No new dependencies.
**Sub-project:** C, first thrust — "Cost: see it & cap it." (Reach/discovery expansion and scheduling-cadence rework are explicitly deferred to later sub-projects.)

---

## 1. Context & Problem

InstaScraper scrapes Instagram via Apify actors. Today there is **zero cost visibility and zero cost control**: nothing records how many Apify runs fire, how many results they consume, or what they cost; there is no budget ceiling, run cap, or counter anywhere. Given the trial-expiry outage history, uncontrolled spend is a real operational risk.

Confirmed against the code:

- **Single launch chokepoint:** every Apify run is started by `_startApifyRun(actorId, input)` ([scraper.js:124](../../../server/scraper.js)) — used by the primary scrape ([:88](../../../server/scraper.js)), the fallback ([:216](../../../server/scraper.js)), discovery phase 2 ([:407](../../../server/scraper.js)), profile enrichment ([:553](../../../server/scraper.js)), and URL import ([:613](../../../server/scraper.js)).
- **Two completion paths:** the primary scrape finalizes asynchronously via `_pollAndStore` → `_fetchAndStoreResults` ([:141](../../../server/scraper.js), [:207](../../../server/scraper.js)); fallback, discovery, enrichment, and URL import finalize synchronously via `_waitForRun` ([:536](../../../server/scraper.js)). Both fetch `GET /actor-runs/{runId}` (so both have the run object, which carries usage) and both know the item count.
- **Footgun #1 — fallback double-run:** when the reel scraper returns ≤3 items, a second generic actor run auto-fires ([:212–228](../../../server/scraper.js)), silently doubling cost for that account, with no opt-out and no accounting.
- **Footgun #2 — manual↔auto collision:** `startScrapeJob` ([:78](../../../server/scraper.js)) has no guard against launching a scrape for an account that already has an in-flight scrape job (e.g. a manual scrape during the scheduled `runAutoScrape`), so the same account can be scraped twice concurrently.
- Auto-scrape ([scheduler.js runAutoScrape](../../../server/scheduler.js)) launches all active accounts ~concurrently with no per-cycle cap.

## 2. Goals & Non-Goals

### Goals
- **See it:** record every Apify run (actor, purpose, account/query, status, results consumed, real `usage_usd`) in a queryable ledger, and surface 30-day spend + top-cost accounts.
- **Cap it (soft):** a rolling-30-day budget ceiling that, when armed and reached, stops *new* run launches (auto-scrape skips the rest of the cycle; manual scrape returns a clear message; optional runs skip) — never killing an in-flight run, auto-resuming when the window drops back under.
- **Stop the obvious waste:** count the fallback run and make it disableable; prevent manual↔auto collision.

### Non-Goals (deferred to later Sub-C thrusts)
- No reach/discovery expansion (better candidates, cross-account dedup, cheaper enrichment).
- No scheduling-cadence rework (staleness-based prioritization, sequential-await, per-cycle run caps). The soft cap reduces spend without changing cadence.
- No change to existing table shapes (`posts`, `scrape_jobs`, `tracked_accounts`, etc.).
- No Apify billing-API integration; cost comes from each run's own object.

## 3. Decisions (from brainstorm)

| Decision | Choice |
|----------|--------|
| Enforcement | **Soft cap** — block new launches when over ceiling; never kill in-flight; auto-resume. |
| Denomination | **Real `usage_usd`** read from the Apify run object (verified at build; falls back to a per-run estimate if the field is absent). |
| Window | **Rolling trailing 30 days.** |
| Arming | Enforcement is **armed only when `APIFY_BUDGET_USD_30D` is set** (>0). Unset/0 ⇒ tracking runs, blocking off — can never surprise-halt scraping. |
| Tracking architecture | **Dedicated `apify_runs` ledger** (one row per actor run) — the only option that correctly attributes the fallback run and gives per-account cost. |

## 4. Architecture

Two instrumented chokepoints + a budget helper.

### 4a. Launch chokepoint — `_startApifyRun`
Change the signature to `_startApifyRun(actorId, input, context)` where `context = { purpose, query }` (`purpose` ∈ `'scrape' | 'fallback' | 'discovery' | 'enrichment' | 'import'`; `query` = the account/hashtag/url label). All five call sites pass a small `context`. Inside `_startApifyRun`, in order:

1. **Budget gate:** `const budget = await budgetStatus();` → if `budget.over`, throw a typed `BudgetExceededError(budget)` *before* the POST (no run is launched, nothing billed).
2. POST to Apify (unchanged).
3. **Record launch:** insert an `apify_runs` row (`run_id`, `actor_id`, `purpose`, `query`, `status='running'`, `started_at=now`, `scrape_job_id` when applicable) using the returned `run.id`.

Because every path calls `_startApifyRun`, all runs are gated and recorded in one place.

### 4b. Completion finalizer — `_recordRunCompletion`
New shared helper `_recordRunCompletion(runId, runObject, itemCount, finalStatus)` that updates the matching `apify_runs` row with `results_count`, `usage_usd` (read from `runObject` — see §11), `status` (`'succeeded' | 'failed'`), and `completed_at`. It is called by **both** completion paths so no run path is left unfinalized (this is the load-bearing correctness requirement):

- `_pollAndStore` / `_fetchAndStoreResults`: on `SUCCEEDED` (has the run object + final item count) and on every failure/timeout branch.
- `_waitForRun`: on `SUCCEEDED` (it already fetches the run object and items — finalize before returning items) and on the terminal-failure branch (finalize as failed before returning `null`).

### 4c. Budget helper — `budgetStatus()`
Returns `{ spentUsd, projectedUsd, ceilingUsd, enforced, over }`:

- `ceilingUsd = parseFloat(process.env.APIFY_BUDGET_USD_30D) || 0`; `enforced = ceilingUsd > 0`.
- `spentUsd = SUM(usage_usd)` over `apify_runs WHERE started_at >= now - 30 days` (finalized rows).
- **In-flight estimate (closes the concurrency overshoot):** in-flight rows (`status='running'`) have `usage_usd=0` until finalized, so near-concurrent launches could blow past a soft cap. `projectedUsd = spentUsd + runningCount × estPerRun`, where `estPerRun` = the trailing-window average `usage_usd` of finalized runs, or `parseFloat(process.env.APIFY_EST_USD_PER_RUN) || 0.05` when there's no history yet.
- `over = enforced && projectedUsd >= ceilingUsd`.

### 4d. Caller handling of `BudgetExceededError`
- **Primary scrape** (`startScrapeJob`, [:86–97](../../../server/scraper.js) try/catch): catch `BudgetExceededError`, mark the `scrape_jobs` row `status='skipped'` with a budget message (distinct from `'failed'`), and rethrow a typed signal the manual route maps to a clear user message ("Apify 30-day budget reached — scraping paused until spend drops below $X").
- **Auto-scrape loop** (`runAutoScrape`): catch `BudgetExceededError` and **break** the loop (skip the remaining accounts this cycle), logging one `[Metric]` line — not N per-account failures.
- **Optional runs** (fallback [:215–228](../../../server/scraper.js) already in try/catch; discovery [:407](../../../server/scraper.js); enrichment [:553](../../../server/scraper.js)): catch and skip silently (these are best-effort).

## 5. Data Model — new `apify_runs` table

Added to `initDB()` in `db.js` (uses the existing `${SERIAL}` / `${NOW_DEFAULT}` helpers, like the other tables):

```sql
CREATE TABLE IF NOT EXISTS apify_runs (
  id            ${SERIAL},
  run_id        TEXT UNIQUE NOT NULL,
  actor_id      TEXT,
  purpose       TEXT,                      -- scrape | fallback | discovery | enrichment | import
  query         TEXT,                      -- account/hashtag/url label
  status        TEXT DEFAULT 'running',    -- running | succeeded | failed
  results_count INTEGER DEFAULT 0,
  usage_usd     REAL DEFAULT 0,
  scrape_job_id INTEGER,                   -- nullable link to scrape_jobs.id
  started_at    TEXT DEFAULT ${NOW_DEFAULT},
  completed_at  TEXT
);
```

No existing table is modified.

## 6. Configuration (env)

| Var | Default | Effect |
|-----|---------|--------|
| `APIFY_BUDGET_USD_30D` | unset / 0 | The soft-cap ceiling. Unset/0 ⇒ tracking only, no blocking. |
| `APIFY_EST_USD_PER_RUN` | `0.05` | Per-run estimate for in-flight runs (only used until there's finalized history to average). |
| `APIFY_DISABLE_REEL_FALLBACK` | unset (fallback ON) | When set truthy, skips the ≤3-item generic fallback run (footgun #1). |
| `APIFY_SCRAPE_DEDUP_MINUTES` | `10` | Collision-guard window (footgun #2). |

## 7. Footgun Fixes

- **#1 Fallback double-run:** gate the fallback block at [scraper.js:212](../../../server/scraper.js) behind `!isTruthy(process.env.APIFY_DISABLE_REEL_FALLBACK)`. Default preserves current behavior (fallback on). The fallback run is recorded + finalized via the chokepoints regardless, so it's always counted.
- **#2 Manual↔auto collision:** in `startScrapeJob`, before inserting the job, skip if an active job for the same `query` exists: `SELECT 1 FROM scrape_jobs WHERE query=$1 AND status='running' AND created_at >= now - APIFY_SCRAPE_DEDUP_MINUTES`. If found, return `{ skipped: true, reason: 'already running' }` without launching. The time window prevents a stuck `'running'` row from blocking forever.

## 8. Observability

- **Per-run metric** on finalize: `[Metric] apify_run purpose=<p> query=<q> usd=<u> items=<n> status=<s> run=<id>` (matches Sub-A's `[Metric]` log convention).
- **Aggregate read:** a new `GET /admin/apify-usage` endpoint, behind the same auth the existing job-trigger/admin endpoints use (e.g. the jobs surface at [index.js:336](../../../server/index.js)). Returns `{ window_days: 30, spent_usd, projected_usd, ceiling_usd, enforced, run_count, top_accounts: [{ query, usd, runs }] }` (top 10 by `usage_usd`). The plan confirms the exact auth middleware when wiring the route.

## 9. Error Handling

- A budget block is **not** an error condition for the system — it's an expected steady state when armed and over budget. It is surfaced as a distinct `scrape_jobs.status='skipped'` + a clear user message (manual) or a single metric line (auto), never as a stack trace or a crash.
- Reading `usage_usd` from the run object is defensive: if the field is missing/non-numeric, record `0` and the estimate path covers in-flight projection (see §11). A missing usage field never throws.
- Ledger writes use the existing `pool.query` interface; a ledger write failure must not abort a scrape (wrap in try/catch, log, continue) — accounting is best-effort and must never break data collection.

## 10. Testing (`node:test`, sqlite in-memory, matching existing `server/*.test.js`)

- **`budgetStatus` math:** finalized sum over the 30-day window; in-flight `projectedUsd` with `runningCount × estPerRun`; `estPerRun` from trailing average vs. env fallback; `enforced=false` when ceiling unset/0; `over` true only when `enforced && projected >= ceiling`. Inject "now" so the 30-day boundary is deterministic.
- **Gate decision:** a pure predicate over a `budgetStatus` result — blocks when `over`, never blocks when `enforced=false`.
- **`_recordRunCompletion`:** updates `results_count` / `usage_usd` / `status` / `completed_at` on the row matching `run_id`; tolerates a missing usage field (records 0, no throw).
- **Both paths finalize:** assert that the success branch of `_pollAndStore`/`_fetchAndStoreResults` AND the success branch of `_waitForRun` invoke `_recordRunCompletion` (via an injected spy / stubbed `fetch`), so neither path leaves a row stuck `'running'` — the CX-004 guarantee.
- **Collision guard:** the dedup query skips when an active recent job exists for the same query, and allows when none (or the existing one is outside the window).

## 11. Risks & Verification

1. **`usage_usd` field shape (verify at build).** Apify run objects report usage; the exact field is expected to be `runObject.usageTotalUsd` (with `usageUsd` as a breakdown). The implementer must confirm the field name against a real run object (the same object both completion paths already fetch). If absent on this plan/actor tier, record `0` and rely on the `estPerRun` projection; note in the metric that real cost is unavailable. **This is the one external unknown** — handle gracefully, don't assume.
2. **Soft cap is best-effort, not a hard financial limit.** With concurrent launches, the in-flight estimate reduces but does not eliminate overshoot (the estimate can be wrong, and a burst can still launch slightly over). This is acceptable for a soft cap; a hard limit would require the deferred sequential-scheduling work. Documented, not solved here.
3. **`_pollAndStore` is fire-and-forget** (`setTimeout` recursion, not awaited). Its finalizer call runs in that async tail; tests for it stub `fetch`/timers rather than relying on wall-clock. The synchronous `_waitForRun` path is straightforward to test.

## 12. Summary of Changes

| File | Change |
|------|--------|
| `server/db.js` | Add `apify_runs` table to `initDB()`. |
| `server/scraper.js` | `_startApifyRun(actorId, input, context)` + budget gate + launch-row insert; new `_recordRunCompletion` finalizer called from `_pollAndStore`/`_fetchAndStoreResults` and `_waitForRun`; `budgetStatus()` helper; `BudgetExceededError`; fallback toggle; collision guard in `startScrapeJob`; pass `context` at all 5 launch sites; `[Metric]` line on finalize. |
| `server/scheduler.js` | `runAutoScrape` breaks the loop on `BudgetExceededError` (skip rest of cycle, one metric line). |
| `server/index.js` | Manual-scrape route maps `BudgetExceededError` / `{skipped}` to a clear message; add the `GET /admin/apify-usage` read (behind existing auth). |
| `server/*.test.js` | New tests per §10. |
