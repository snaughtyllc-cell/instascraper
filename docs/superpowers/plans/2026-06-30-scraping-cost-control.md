# Scraping Cost Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Apify scraping cost visibility (a per-run ledger with real `usage_usd`) and a soft 30-day budget cap, and fix two cost footguns (fallback double-run; manual↔auto collision).

**Architecture:** A new `apify_runs` ledger table plus a set of pure, db-injectable functions in `scraper.js` (budget math, launch/completion recording, usage summary, collision check) — all unit-tested in isolation. Those functions are then wired into the two run chokepoints: `_startApifyRun` (the single launch point — budget gate + launch record) and a shared completion finalizer called by **both** completion paths (`_pollAndStore`/`_fetchAndStoreResults` and `_waitForRun`), so every run path is counted.

**Tech Stack:** Node.js (CommonJS), `node-fetch`, PostgreSQL/SQLite via `server/db.js`, `node:test` + `node:assert` + `better-sqlite3` (already deps). No new dependencies.

## Global Constraints

- No changes to existing table shapes (`posts`, `scrape_jobs`, `tracked_accounts`, …). Only ADD the `apify_runs` table.
- No new npm dependencies.
- Soft cap: block only *new* launches when over ceiling; never kill an in-flight run; auto-resume when the 30-day total drops back under.
- Enforcement is armed only when `APIFY_BUDGET_USD_30D > 0`. Unset/0 ⇒ tracking runs, no blocking.
- Cost is read from the Apify run object (`runObject.usageTotalUsd`); if absent/non-numeric, record `0` (never throw).
- All timestamps written/compared by this feature use **ISO-8601 without milliseconds** (`YYYY-MM-DDTHH:MM:SSZ`) to match `db.js`'s `NOW_DEFAULT` (`TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')` / `datetime('now')`), so lexicographic timestamp comparisons are exact.
- Env vars: `APIFY_BUDGET_USD_30D` (ceiling, default off), `APIFY_EST_USD_PER_RUN` (default `0.05`), `APIFY_DISABLE_REEL_FALLBACK` (default off = fallback on), `APIFY_SCRAPE_DEDUP_MINUTES` (default `10`).
- Tests run via `cd server && npm test` (`node --test`).
- Accounting must never break scraping: every ledger read/write at a call site is wrapped so a failure logs and continues.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `server/db.js` | Schema. | Add `apify_runs` table to `initDB()`. |
| `server/scraper.js` | Apify scraping + (new) cost ledger functions + run-path instrumentation. | Add module-level cost functions (Task 1); instrument `_startApifyRun`, `_pollAndStore`, `_fetchAndStoreResults`, `_waitForRun` (Task 2); caller handling + footgun fixes (Task 3). |
| `server/scheduler.js` | Cron jobs. | `runAutoScrape` breaks on `BudgetExceededError` (Task 3). |
| `server/index.js` | HTTP routes. | Manual-scrape routes map budget/skip outcomes to clear messages; add `GET /admin/apify-usage` (Tasks 3–4). |
| `server/apify-cost.test.js` | Unit tests for the cost data layer. | Create (Task 1). |

---

## Task 1: Cost ledger data layer (table + pure functions + tests)

**Files:**
- Modify: `server/db.js` (add `apify_runs` table inside `initDB()`, next to the other `CREATE TABLE` calls)
- Modify: `server/scraper.js` (add module-level functions near the top, after the `calcER` helper at line 17; add named exports after `module.exports = InstagramScraper;` at line 681)
- Test: `server/apify-cost.test.js` (create)

**Interfaces — Produces (later tasks rely on these exact signatures):**
- `isoNoMillis(ms) → string`
- `class BudgetExceededError extends Error` (has `.budget`)
- `extractUsageUsd(runObject) → number`
- `budgetStatus(db, nowMs?) → Promise<{ spentUsd, projectedUsd, ceilingUsd, enforced, over, runningCount, estPerRun }>`
- `recordRunLaunch(db, { runId, actorId, purpose, query, scrapeJobId?, nowMs? }) → Promise<void>`
- `recordRunCompletion(db, { runId, runObject?, status, nowMs? }) → Promise<void>`
- `usageSummary(db, nowMs?) → Promise<{ window_days, spent_usd, projected_usd, ceiling_usd, enforced, run_count, top_accounts: [{query, usd, runs}] }>`
- `hasActiveJob(db, query, nowMs?, windowMin?) → Promise<boolean>`
- `db` is any object with `query(sql, params) → Promise<{ rows }>` (production passes the module `pool`; tests pass an in-memory shim).

- [ ] **Step 1: Add the `apify_runs` table to `db.js`**

In `server/db.js`, inside `initDB()`, after the `idea_delivery_log` `CREATE TABLE` block (around line 248) and before the `// Migrations for existing tables` comment, add:

```js
  // Apify run cost ledger (one row per actor run) — see Sub-C cost control
  await db.query(`
    CREATE TABLE IF NOT EXISTS apify_runs (
      id ${SERIAL},
      run_id TEXT UNIQUE NOT NULL,
      actor_id TEXT,
      purpose TEXT,
      query TEXT,
      status TEXT DEFAULT 'running',
      results_count INTEGER DEFAULT 0,
      usage_usd REAL DEFAULT 0,
      scrape_job_id INTEGER,
      started_at TEXT DEFAULT ${NOW_DEFAULT},
      completed_at TEXT
    )
  `);
```

- [ ] **Step 2: Write the failing test file**

Create `server/apify-cost.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const scraper = require('./scraper');

const {
  isoNoMillis, BudgetExceededError, extractUsageUsd,
  budgetStatus, recordRunLaunch, recordRunCompletion, usageSummary, hasActiveJob,
} = scraper;

// Minimal pg-style wrapper over an in-memory sqlite db: $1,$2 → ?, returns { rows }.
function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE apify_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT UNIQUE NOT NULL, actor_id TEXT,
    purpose TEXT, query TEXT, status TEXT DEFAULT 'running', results_count INTEGER DEFAULT 0,
    usage_usd REAL DEFAULT 0, scrape_job_id INTEGER, started_at TEXT, completed_at TEXT)`);
  sqlite.exec(`CREATE TABLE scrape_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, query TEXT, query_type TEXT, status TEXT DEFAULT 'running',
    created_at TEXT)`);
  return {
    sqlite,
    query: async (sql, params = []) => {
      const converted = sql.replace(/\$(\d+)/g, '?');
      const trimmed = converted.trim();
      if (/^SELECT/i.test(trimmed)) return { rows: sqlite.prepare(converted).all(...params) };
      const info = sqlite.prepare(converted).run(...params);
      return { rows: [], rowCount: info.changes };
    },
  };
}

const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-06-30T12:00:00Z');

test('isoNoMillis matches the no-millis NOW_DEFAULT format', () => {
  assert.strictEqual(isoNoMillis(Date.parse('2026-06-30T12:00:00.123Z')), '2026-06-30T12:00:00Z');
});

test('extractUsageUsd reads usageTotalUsd, defaults to 0 on missing/non-numeric', () => {
  assert.strictEqual(extractUsageUsd({ usageTotalUsd: 0.042 }), 0.042);
  assert.strictEqual(extractUsageUsd({}), 0);
  assert.strictEqual(extractUsageUsd(null), 0);
  assert.strictEqual(extractUsageUsd({ usageTotalUsd: 'x' }), 0);
  assert.strictEqual(extractUsageUsd({ usageTotalUsd: Infinity }), 0);
});

test('recordRunLaunch inserts a running row; recordRunCompletion finalizes it', async () => {
  const db = makeDb();
  await recordRunLaunch(db, { runId: 'r1', actorId: 'a', purpose: 'scrape', query: '@x', nowMs: NOW });
  let row = db.sqlite.prepare(`SELECT * FROM apify_runs WHERE run_id='r1'`).get();
  assert.strictEqual(row.status, 'running');
  assert.strictEqual(row.usage_usd, 0);

  await recordRunCompletion(db, { runId: 'r1', runObject: { usageTotalUsd: 0.07, stats: { itemCount: 12 } }, status: 'succeeded', nowMs: NOW });
  row = db.sqlite.prepare(`SELECT * FROM apify_runs WHERE run_id='r1'`).get();
  assert.strictEqual(row.status, 'succeeded');
  assert.strictEqual(row.results_count, 12);
  assert.strictEqual(row.usage_usd, 0.07);
  assert.ok(row.completed_at);
});

test('recordRunCompletion with no runObject records status only, no throw', async () => {
  const db = makeDb();
  await recordRunLaunch(db, { runId: 'r2', actorId: 'a', purpose: 'scrape', query: '@y', nowMs: NOW });
  await recordRunCompletion(db, { runId: 'r2', status: 'failed', nowMs: NOW });
  const row = db.sqlite.prepare(`SELECT * FROM apify_runs WHERE run_id='r2'`).get();
  assert.strictEqual(row.status, 'failed');
  assert.strictEqual(row.usage_usd, 0);
});

test('budgetStatus: enforcement off when ceiling unset', async () => {
  const db = makeDb();
  delete process.env.APIFY_BUDGET_USD_30D;
  const s = await budgetStatus(db, NOW);
  assert.strictEqual(s.enforced, false);
  assert.strictEqual(s.over, false);
});

test('budgetStatus: sums succeeded usage in the 30-day window and flags over', async () => {
  const db = makeDb();
  process.env.APIFY_BUDGET_USD_30D = '1.00';
  // two succeeded runs inside window summing to 0.90
  await recordRunLaunch(db, { runId: 'a', actorId: 'x', purpose: 'scrape', query: '@a', nowMs: NOW - HOUR });
  await recordRunCompletion(db, { runId: 'a', runObject: { usageTotalUsd: 0.50, stats: { itemCount: 1 } }, status: 'succeeded', nowMs: NOW - HOUR });
  await recordRunLaunch(db, { runId: 'b', actorId: 'x', purpose: 'scrape', query: '@b', nowMs: NOW - HOUR });
  await recordRunCompletion(db, { runId: 'b', runObject: { usageTotalUsd: 0.40, stats: { itemCount: 1 } }, status: 'succeeded', nowMs: NOW - HOUR });
  let s = await budgetStatus(db, NOW);
  assert.ok(Math.abs(s.spentUsd - 0.90) < 1e-9);
  assert.strictEqual(s.over, false); // 0.90 < 1.00, no in-flight
  // a third succeeded run pushes spent to 1.10 → over
  await recordRunLaunch(db, { runId: 'c', actorId: 'x', purpose: 'scrape', query: '@c', nowMs: NOW - HOUR });
  await recordRunCompletion(db, { runId: 'c', runObject: { usageTotalUsd: 0.20, stats: { itemCount: 1 } }, status: 'succeeded', nowMs: NOW - HOUR });
  s = await budgetStatus(db, NOW);
  assert.ok(s.over, 'over once projected >= ceiling');
});

test('budgetStatus: excludes runs older than 30 days', async () => {
  const db = makeDb();
  process.env.APIFY_BUDGET_USD_30D = '1.00';
  await recordRunLaunch(db, { runId: 'old', actorId: 'x', purpose: 'scrape', query: '@o', nowMs: NOW - 40 * 24 * HOUR });
  await recordRunCompletion(db, { runId: 'old', runObject: { usageTotalUsd: 5.0, stats: { itemCount: 1 } }, status: 'succeeded', nowMs: NOW - 40 * 24 * HOUR });
  const s = await budgetStatus(db, NOW);
  assert.strictEqual(s.spentUsd, 0);
  assert.strictEqual(s.over, false);
});

test('budgetStatus: in-flight runs add estimated cost via projectedUsd', async () => {
  const db = makeDb();
  process.env.APIFY_BUDGET_USD_30D = '1.00';
  process.env.APIFY_EST_USD_PER_RUN = '0.30';
  // spent 0.80 succeeded, no finished-average yet beyond these; plus 1 running
  await recordRunLaunch(db, { runId: 's1', actorId: 'x', purpose: 'scrape', query: '@a', nowMs: NOW - HOUR });
  await recordRunCompletion(db, { runId: 's1', runObject: { usageTotalUsd: 0.80, stats: { itemCount: 1 } }, status: 'succeeded', nowMs: NOW - HOUR });
  await recordRunLaunch(db, { runId: 'run1', actorId: 'x', purpose: 'scrape', query: '@b', nowMs: NOW }); // still running
  const s = await budgetStatus(db, NOW);
  // estPerRun = avg of succeeded (0.80); projected = 0.80 + 1*0.80 = 1.60 >= 1.00 → over
  assert.ok(s.over, 'in-flight estimate pushes projected over ceiling');
  assert.ok(s.projectedUsd > s.spentUsd);
});

test('usageSummary returns totals and top accounts by spend', async () => {
  const db = makeDb();
  process.env.APIFY_BUDGET_USD_30D = '5.00';
  for (const [id, q, usd] of [['1', '@a', 0.5], ['2', '@a', 0.5], ['3', '@b', 0.2]]) {
    await recordRunLaunch(db, { runId: id, actorId: 'x', purpose: 'scrape', query: q, nowMs: NOW });
    await recordRunCompletion(db, { runId: id, runObject: { usageTotalUsd: usd, stats: { itemCount: 1 } }, status: 'succeeded', nowMs: NOW });
  }
  const sum = await usageSummary(db, NOW);
  assert.strictEqual(sum.run_count, 3);
  assert.ok(Math.abs(sum.spent_usd - 1.2) < 1e-9);
  assert.strictEqual(sum.top_accounts[0].query, '@a');
  assert.ok(Math.abs(sum.top_accounts[0].usd - 1.0) < 1e-9);
  assert.strictEqual(sum.top_accounts[0].runs, 2);
});

test('hasActiveJob detects a recent running job for the same query', async () => {
  const db = makeDb();
  db.sqlite.prepare(`INSERT INTO scrape_jobs (query, query_type, status, created_at) VALUES (?,?,?,?)`)
    .run('@busy', 'username', 'running', isoNoMillis(NOW - 2 * 60 * 1000));
  assert.strictEqual(await hasActiveJob(db, '@busy', NOW), true);
  assert.strictEqual(await hasActiveJob(db, '@free', NOW), false);
  // outside the 10-min window → not active
  db.sqlite.prepare(`INSERT INTO scrape_jobs (query, query_type, status, created_at) VALUES (?,?,?,?)`)
    .run('@stale', 'username', 'running', isoNoMillis(NOW - 30 * 60 * 1000));
  assert.strictEqual(await hasActiveJob(db, '@stale', NOW), false);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd server && node --test apify-cost.test.js`
Expected: FAIL — the imported functions are `undefined` (not yet exported), so destructuring yields `undefined` and calls throw `TypeError`.

- [ ] **Step 4: Implement the data-layer functions in `scraper.js`**

In `server/scraper.js`, immediately after the `calcER` function (ends line 17) and before `class InstagramScraper` (line 19), add:

```js
function isoNoMillis(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

class BudgetExceededError extends Error {
  constructor(status) {
    super(`Apify 30-day budget reached: ~$${status.projectedUsd.toFixed(2)} projected vs $${status.ceilingUsd.toFixed(2)} ceiling`);
    this.name = 'BudgetExceededError';
    this.budget = status;
  }
}

function extractUsageUsd(runObject) {
  const u = runObject && runObject.usageTotalUsd;
  return (typeof u === 'number' && isFinite(u)) ? u : 0;
}

async function budgetStatus(db, nowMs = Date.now()) {
  const ceilingUsd = parseFloat(process.env.APIFY_BUDGET_USD_30D) || 0;
  const enforced = ceilingUsd > 0;
  const since = isoNoMillis(nowMs - 30 * 24 * 60 * 60 * 1000);
  const res = await db.query(
    `SELECT
       COALESCE(SUM(usage_usd), 0) AS spent,
       COALESCE(SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END), 0) AS running,
       COALESCE(AVG(CASE WHEN status = 'succeeded' THEN usage_usd END), 0) AS avg_usd,
       COALESCE(SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END), 0) AS finished
     FROM apify_runs WHERE started_at >= $1`,
    [since]
  );
  const row = res.rows[0] || {};
  const spentUsd = Number(row.spent) || 0;
  const runningCount = Number(row.running) || 0;
  const avgUsd = Number(row.avg_usd) || 0;
  const finished = Number(row.finished) || 0;
  const estPerRun = finished > 0 ? avgUsd : (parseFloat(process.env.APIFY_EST_USD_PER_RUN) || 0.05);
  const projectedUsd = spentUsd + runningCount * estPerRun;
  const over = enforced && projectedUsd >= ceilingUsd;
  return { spentUsd, projectedUsd, ceilingUsd, enforced, over, runningCount, estPerRun };
}

async function recordRunLaunch(db, { runId, actorId, purpose, query, scrapeJobId = null, nowMs = Date.now() }) {
  await db.query(
    `INSERT INTO apify_runs (run_id, actor_id, purpose, query, status, started_at, scrape_job_id)
     VALUES ($1, $2, $3, $4, 'running', $5, $6)`,
    [runId, actorId, purpose, query, isoNoMillis(nowMs), scrapeJobId]
  );
}

async function recordRunCompletion(db, { runId, runObject = null, status, nowMs = Date.now() }) {
  const usd = extractUsageUsd(runObject);
  const items = (runObject && runObject.stats && Number(runObject.stats.itemCount)) || 0;
  await db.query(
    `UPDATE apify_runs SET status = $1, results_count = $2, usage_usd = $3, completed_at = $4 WHERE run_id = $5`,
    [status, items, usd, isoNoMillis(nowMs), runId]
  );
  console.log(`[Metric] apify_run run=${runId} status=${status} items=${items} usd=${usd.toFixed(4)}`);
}

async function usageSummary(db, nowMs = Date.now()) {
  const status = await budgetStatus(db, nowMs);
  const since = isoNoMillis(nowMs - 30 * 24 * 60 * 60 * 1000);
  const totals = await db.query(`SELECT COUNT(*) AS run_count FROM apify_runs WHERE started_at >= $1`, [since]);
  const top = await db.query(
    `SELECT query, COALESCE(SUM(usage_usd), 0) AS usd, COUNT(*) AS runs
     FROM apify_runs WHERE started_at >= $1 AND query IS NOT NULL
     GROUP BY query ORDER BY usd DESC LIMIT 10`,
    [since]
  );
  return {
    window_days: 30,
    spent_usd: status.spentUsd,
    projected_usd: status.projectedUsd,
    ceiling_usd: status.ceilingUsd,
    enforced: status.enforced,
    run_count: Number(totals.rows[0].run_count) || 0,
    top_accounts: top.rows.map(r => ({ query: r.query, usd: Number(r.usd) || 0, runs: Number(r.runs) || 0 })),
  };
}

async function hasActiveJob(db, query, nowMs = Date.now(), windowMin = parseInt(process.env.APIFY_SCRAPE_DEDUP_MINUTES, 10) || 10) {
  const since = isoNoMillis(nowMs - windowMin * 60 * 1000);
  const res = await db.query(
    `SELECT 1 FROM scrape_jobs WHERE query = $1 AND status = 'running' AND created_at >= $2 LIMIT 1`,
    [query, since]
  );
  return res.rows.length > 0;
}
```

Then at the bottom of the file, after `module.exports = InstagramScraper;` (line 681), append:

```js
module.exports.isoNoMillis = isoNoMillis;
module.exports.BudgetExceededError = BudgetExceededError;
module.exports.extractUsageUsd = extractUsageUsd;
module.exports.budgetStatus = budgetStatus;
module.exports.recordRunLaunch = recordRunLaunch;
module.exports.recordRunCompletion = recordRunCompletion;
module.exports.usageSummary = usageSummary;
module.exports.hasActiveJob = hasActiveJob;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && node --test apify-cost.test.js`
Expected: PASS (all tests). Then run the full suite: `cd server && npm test` → all prior tests still green.

- [ ] **Step 6: Commit**

```bash
git add server/db.js server/scraper.js server/apify-cost.test.js
git commit -m "feat(cost): apify_runs ledger + budget/usage data layer (tested)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Instrument the run chokepoints

**Files:** Modify `server/scraper.js` (`_startApifyRun`, `_pollAndStore`, `_fetchAndStoreResults`, `_waitForRun`, and the 5 launch call sites).

**Interfaces — Consumes (from Task 1):** `budgetStatus(pool)`, `recordRunLaunch(pool, …)`, `recordRunCompletion(pool, …)`, `BudgetExceededError`. **Produces:** `_startApifyRun(actorId, input, context)` now gates on budget (throws `BudgetExceededError`) and records the launch; every run finalizes its ledger row via `recordRunCompletion` on both completion paths.

**Verification note:** these are the live Apify run paths — they require `fetch` + a real Apify run and are **not** unit-tested in this codebase (no existing scraper-run-path tests; the spec's risk note documents this). Verification is code review against this task + `cd server && npm test` staying green (no import/regression breakage). The *logic* these call sites invoke is already unit-tested in Task 1.

- [ ] **Step 1: Gate + record launch in `_startApifyRun`**

Replace `_startApifyRun` (lines 124–139) with:

```js
  async _startApifyRun(actorId, input, context = {}) {
    const status = await budgetStatus(pool);
    if (status.over) throw new BudgetExceededError(status);

    const res = await fetch(
      `${APIFY_BASE}/acts/${actorId}/runs?token=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Apify API error: ${res.status} — ${text}`);
    }
    const data = await res.json();
    const run = data.data;
    try {
      await recordRunLaunch(pool, {
        runId: run.id,
        actorId,
        purpose: context.purpose || 'scrape',
        query: context.query || null,
        scrapeJobId: context.scrapeJobId || null,
      });
    } catch (e) {
      console.error('[Apify] ledger launch insert failed:', e.message);
    }
    return run;
  }
```

- [ ] **Step 2: Pass `context` at all 5 launch sites**

Update each `_startApifyRun(...)` call to pass a 3rd `context` arg:

- `startScrapeJob` (line 88): `const run = await this._startApifyRun(actorId, input, { purpose: 'scrape', query, scrapeJobId: jobId });`
- Fallback (line 216): add `{ purpose: 'fallback', query: filters.query }` as the 3rd arg to `_startApifyRun(GENERIC_ACTOR_ID, {...}, { purpose: 'fallback', query: filters.query })`.
- Discovery phase 2 (line 407): add `{ purpose: 'discovery', query: username }`.
- Profile enrichment (line 553): add `{ purpose: 'enrichment', query: username }`.
- URL import (line 613): add `{ purpose: 'import', query: cleanUrls[0] || 'import' }`.

- [ ] **Step 3: Finalize on the primary completion path (`_pollAndStore`)**

In `_pollAndStore` (lines 141–205), add a `recordRunCompletion` call (wrapped) at each terminal branch, using the polled `run` object:

- In the `SUCCEEDED` branch (after line 173 `await this._fetchAndStoreResults(...)`, before `return;`):
  ```js
  try { await recordRunCompletion(pool, { runId, runObject: run, status: 'succeeded' }); } catch (e) { console.error('[Apify] ledger finalize failed:', e.message); }
  ```
- In the `FAILED || ABORTED || TIMED-OUT` branch (before its `return;`):
  ```js
  try { await recordRunCompletion(pool, { runId, runObject: run, status: 'failed' }); } catch (e) { console.error('[Apify] ledger finalize failed:', e.message); }
  ```
- In the `attempts >= maxAttempts` polling-timeout branch:
  ```js
  try { await recordRunCompletion(pool, { runId, runObject: run, status: 'failed' }); } catch (e) { console.error('[Apify] ledger finalize failed:', e.message); }
  ```
- In the outer `catch (err)` branch (no run object available):
  ```js
  try { await recordRunCompletion(pool, { runId, status: 'failed' }); } catch (e) { console.error('[Apify] ledger finalize failed:', e.message); }
  ```

- [ ] **Step 4: Finalize on the synchronous completion path (`_waitForRun`)**

Replace `_waitForRun` (lines 536–548) with:

```js
  async _waitForRun(runId, maxPolls = 20) {
    for (let i = 0; i < maxPolls; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const res = await fetch(`${APIFY_BASE}/actor-runs/${runId}?token=${this.apiKey}`);
      const data = await res.json();
      if (data.data.status === 'SUCCEEDED') {
        try { await recordRunCompletion(pool, { runId, runObject: data.data, status: 'succeeded' }); } catch (e) { console.error('[Apify] ledger finalize failed:', e.message); }
        const itemsRes = await fetch(`${APIFY_BASE}/actor-runs/${runId}/dataset/items?token=${this.apiKey}`);
        return await itemsRes.json();
      }
      if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(data.data.status)) {
        try { await recordRunCompletion(pool, { runId, runObject: data.data, status: 'failed' }); } catch (e) { console.error('[Apify] ledger finalize failed:', e.message); }
        return null;
      }
    }
    try { await recordRunCompletion(pool, { runId, status: 'failed' }); } catch (e) { console.error('[Apify] ledger finalize failed:', e.message); }
    return null;
  }
```

- [ ] **Step 5: Verify no regression and commit**

Run: `cd server && npm test`
Expected: all tests still pass (no new tests here; the data-layer logic is covered by Task 1). Confirm by code review that every run path (primary, fallback, discovery, enrichment, import) launches via `_startApifyRun` (gated + recorded) and finalizes via `recordRunCompletion`.

```bash
git add server/scraper.js
git commit -m "feat(cost): gate + record every Apify run at the launch and completion chokepoints

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Soft-cap caller handling, collision guard, fallback toggle

**Files:** Modify `server/scraper.js` (`startScrapeJob`, fallback block), `server/scheduler.js` (`runAutoScrape`), `server/index.js` (manual scrape routes).

**Interfaces — Consumes:** `hasActiveJob(pool, query)`, `BudgetExceededError` (Task 1/2). **Produces:** budget blocks surface as a distinct `scrape_jobs.status='skipped'` + a clear API message; auto-scrape stops the cycle on a budget block; the fallback run is disableable.

**Verification note:** caller wiring across three files; the collision-guard logic (`hasActiveJob`) is already unit-tested in Task 1. Verification is code review + `cd server && npm test` green.

- [ ] **Step 1: Collision guard + budget handling in `startScrapeJob`**

Replace `startScrapeJob` (lines 78–98) with:

```js
  async startScrapeJob({ query, queryType, minLikes, minViews, startDate, endDate, source }) {
    const jobSource = source || 'manual';

    // Footgun #2: skip if an active scrape for the same query is already running.
    try {
      if (await hasActiveJob(pool, query)) {
        console.log(`[Scraper] Skipping @${query} — an active scrape job already exists.`);
        return { skipped: true, reason: 'already running' };
      }
    } catch (e) {
      console.error('[Scraper] collision check failed (continuing):', e.message);
    }

    const result = await pool.query(
      `INSERT INTO scrape_jobs (query, query_type, status, source) VALUES ($1, $2, 'running', $3) RETURNING id`,
      [query, queryType, jobSource]
    );
    const jobId = result.rows[0].id;

    try {
      const { actorId, input } = this._buildInput(query, queryType);
      const run = await this._startApifyRun(actorId, input, { purpose: 'scrape', query, scrapeJobId: jobId });

      await pool.query('UPDATE scrape_jobs SET apify_run_id = $1 WHERE id = $2', [run.id, jobId]);

      this._pollAndStore(run.id, jobId, { minLikes, minViews, startDate, endDate, query });
      return { jobId, apifyRunId: run.id, status: 'running' };
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        await pool.query('UPDATE scrape_jobs SET status = $1, error = $2 WHERE id = $3', ['skipped', err.message, jobId]);
        throw err; // let the caller (route / scheduler) handle it distinctly
      }
      await pool.query('UPDATE scrape_jobs SET status = $1, error = $2 WHERE id = $3', ['failed', err.message, jobId]);
      throw err;
    }
  }
```

(Note: `RETURNING id` — `db.js` strips `RETURNING id` for sqlite but returns `rows: [{ id: lastInsertRowid }]`, so `result.rows[0].id` works in both modes, exactly as today.)

- [ ] **Step 2: Footgun #1 — make the fallback run disableable**

In `_fetchAndStoreResults`, change the fallback condition (line 212) from:

```js
    if (items.length <= 3 && filters.query && !filters.query.startsWith('#') && !filters.query.startsWith('http')) {
```

to:

```js
    const fallbackDisabled = /^(1|true|yes)$/i.test(process.env.APIFY_DISABLE_REEL_FALLBACK || '');
    if (!fallbackDisabled && items.length <= 3 && filters.query && !filters.query.startsWith('#') && !filters.query.startsWith('http')) {
```

- [ ] **Step 3: `runAutoScrape` stops the cycle on a budget block**

In `server/scheduler.js`, update the loop body in `runAutoScrape` (lines 24–30). Add a `require` of `BudgetExceededError` at the top of the file (after line 2 `const pool = require('./db');`):

```js
const { BudgetExceededError } = require('./scraper');
```

Then change the catch inside the loop (line 29) so a budget block breaks the loop:

```js
    for (const account of result.rows) {
      try {
        await scraperInstance.startScrapeJob({ query: account.username, queryType: 'username', minLikes: null, minViews: null, startDate: null, endDate: null, source: 'auto' });
        scraped++;
        if (scraped < result.rows.length) await new Promise(r => setTimeout(r, 30000));
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          console.log(`[Metric] auto_scrape_budget_stop scraped=${scraped} total=${result.rows.length} msg="${err.message}"`);
          jobStatus.autoScrape.message = `Stopped at ${scraped}/${result.rows.length} — ${err.message}`;
          jobStatus.autoScrape.status = 'idle';
          return;
        }
        console.error(`[Scheduler] Failed to scrape @${account.username}:`, err.message);
      }
    }
```

- [ ] **Step 4: Manual scrape routes map budget/skip to a clear message**

In `server/index.js`, the manual scrape routes are `POST /scrape` (line 94) and `POST /tracked/:username/scrape` (line 241). For each, wrap the `startScrapeJob` call so a `BudgetExceededError` returns HTTP 429 with a clear message and a `{ skipped: true }` result returns 200 with that info. Use the exported error class — add near the other requires at the top of `index.js`:

```js
const { BudgetExceededError } = require('./scraper');
```

`POST /tracked/:username/scrape` (line 241–246) becomes:

```js
app.post('/tracked/:username/scrape', async (req, res) => {
  try {
    const result = await scraper.startScrapeJob({ query: req.params.username, queryType: 'username', minLikes: null, minViews: null, startDate: null, endDate: null, source: 'manual' });
    if (result && result.skipped) return res.json({ skipped: true, message: 'A scrape for this account is already running.' });
    res.json(result);
  } catch (err) {
    if (err instanceof BudgetExceededError) return res.status(429).json({ error: err.message, budget: err.budget });
    res.status(500).json({ error: err.message });
  }
});
```

Apply the same `try/catch` + `skipped` handling to `POST /scrape` (line 94), preserving its existing request-body parsing and response shape — only add the `BudgetExceededError` → 429 branch and the `result.skipped` → 200 branch around the existing `startScrapeJob` call.

- [ ] **Step 5: Verify no regression and commit**

Run: `cd server && npm test`
Expected: all tests pass. Code-review that: a budget block stops auto-scrape and 429s manual scrapes; a collision returns `skipped`; the fallback is gated by the env flag.

```bash
git add server/scraper.js server/scheduler.js server/index.js
git commit -m "feat(cost): soft-cap enforcement, manual<->auto collision guard, fallback toggle

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: `GET /admin/apify-usage` endpoint

**Files:** Modify `server/index.js`.

**Interfaces — Consumes:** `usageSummary(pool)` (Task 1, already unit-tested). **Produces:** an authenticated read of 30-day Apify usage.

- [ ] **Step 1: Add the route behind auth**

In `server/index.js`: add `usageSummary` to the scraper import (it's exported off the scraper module). Near the top where `scraper` is constructed/required, add:

```js
const { usageSummary } = require('./scraper');
```

Register an auth guard and the route alongside the other `requireAuth` mounts (after line 84's `app.use('/ideas', requireAuth);`) and route definitions:

```js
app.use('/admin', requireAuth);

app.get('/admin/apify-usage', async (req, res) => {
  try {
    const summary = await usageSummary(pool);
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

This needs the module `pool` — `index.js` already imports it (confirm `const pool = require('./db')` exists near the top; if the file accesses the DB only through `scraper`/`health`, add the `require`). The `usageSummary` logic is covered by Task 1's unit test; this step is thin wiring.

- [ ] **Step 2: Verify and commit**

Run: `cd server && npm test`
Expected: all tests pass (no new tests; route is thin wiring over the Task 1-tested `usageSummary`). Optionally smoke-test locally: `curl -s localhost:<port>/admin/apify-usage` after authenticating returns the summary JSON.

```bash
git add server/index.js
git commit -m "feat(cost): GET /admin/apify-usage 30-day spend + top accounts

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- Ledger table → Task 1 Step 1. ✓
- Real `usage_usd` from run object + graceful fallback → `extractUsageUsd` (Task 1) + tests. ✓
- Launch chokepoint gate + record → Task 2 Steps 1–2. ✓
- Shared completion finalizer on BOTH paths (CX-004) → Task 2 Steps 3–4. ✓
- `budgetStatus` rolling-30-day + in-flight estimate → Task 1 (function + 4 tests). ✓
- Soft-cap caller handling (auto skip-rest, manual message, optional skip) → Task 3 Steps 1,3,4. ✓
- Armed only when `APIFY_BUDGET_USD_30D>0` → `budgetStatus` `enforced` + test. ✓
- Footgun #1 fallback toggle → Task 3 Step 2. ✓
- Footgun #2 collision guard → Task 1 `hasActiveJob` (tested) + Task 3 Step 1 wiring. ✓
- Observability: `[Metric]` line → Task 1 `recordRunCompletion`; `/admin/apify-usage` → Task 4. ✓
- ISO-no-millis timestamp constraint → `isoNoMillis` used everywhere + Task 1 test. ✓
- No existing-table changes / no new deps → only `apify_runs` added; no package.json change. ✓

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N". Every code step shows complete code. The optional runs' (discovery/enrichment) budget-block skip is inherent: they call `_startApifyRun` inside existing `try/catch`es (fallback at scraper.js:215, discovery at :405-ish, enrichment within `_fetchProfileQuick`) that already swallow errors and continue — a thrown `BudgetExceededError` is caught and skips that optional run, which is the intended behavior; no extra code needed. (Confirm during Task 3 review that each optional launch site sits inside a try/catch; the fallback and discovery sites do per the line references.)

**3. Type consistency:** `budgetStatus` returns `{ spentUsd, projectedUsd, ceilingUsd, enforced, over, runningCount, estPerRun }` (Task 1) and is consumed as `.over` (Task 2 Step 1) and via `usageSummary` (Task 1/Task 4). `recordRunCompletion(db, { runId, runObject?, status })` and `recordRunLaunch(db, { runId, actorId, purpose, query, scrapeJobId? })` signatures match all call sites in Task 2. `hasActiveJob(db, query)` matches Task 3 Step 1. `BudgetExceededError.budget` set in Task 1, read in Task 3 Step 4. Consistent.

**Note for executor:** Task 3 Step 4 says "confirm `const pool = require('./db')` exists in `index.js`." If it does not, add it — `usageSummary(pool)` and the route need it.
