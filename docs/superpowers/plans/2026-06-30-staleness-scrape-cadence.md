# Staleness-Based Scrape Cadence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the uniform every-3-days auto-scrape with a daily, frequency-aware cadence that scrapes due accounts (capped per cycle), backs off chronically-failing accounts, and spends Apify where it buys freshness.

**Architecture:** Pure, exported cadence helpers in `server/scheduler.js` (`cadenceConfig`, `computeInterval`, `backoffDays`, `daysSince`, `isDue`, `selectDueAccounts`, `buildCadenceAccounts`) carry all the logic and are unit-tested. `runAutoScrape` becomes a thin orchestrator that builds account cadence objects from DB rows + a frequency query, selects due-and-capped accounts, stamps `last_attempt_at`, and launches the (budget-gated) scrape. The scraper's completion paths record success/failure on `tracked_accounts.consecutive_failures`.

**Tech Stack:** Node/Express, dual-mode DB (`pg` prod / `better-sqlite3` dev+test), `node-cron`, `node:test`.

## Global Constraints

- **Test runner:** `node --test` from `server/` (`npm test`). Pure helpers are top-level functions in `server/scheduler.js`, added to its `module.exports = { … }` object, imported in tests as `const sched = require('./scheduler')`.
- **`now` is milliseconds** (a `Date.now()`-style number) passed explicitly into helpers so tests are deterministic. App code may call `Date.now()`/`new Date()` (only workflow *scripts* forbid them).
- **Frequency window must be an integer** — the dual-mode shim rewrites `TO_CHAR(NOW() - INTERVAL '<n> days', …)` → `datetime('now','-<n> days')` only when `<n>` is `\d+`. `cadenceConfig().freqWindowDays` is `Math.floor`-ed.
- **Config defaults (verbatim):** `SCRAPE_MAX_PER_CYCLE=10`, `CADENCE_ACTIVE_PPW=4`, `CADENCE_MODERATE_PPW=1`, `CADENCE_INTERVAL_ACTIVE=2`, `CADENCE_INTERVAL_MODERATE=4`, `CADENCE_INTERVAL_QUIET=8`, `CADENCE_FREQ_WINDOW_DAYS=28`, `CADENCE_BACKOFF_BASE=1`, `CADENCE_BACKOFF_MAX=14`.
- **Failure semantics:** success-with-≥1-post → `consecutive_failures = 0`; completed-0-posts (no engagement/date filters, username query) → `+1`; run FAILED/ABORTED/TIMED-OUT/poll-timeout → `+1`. All best-effort (`try/catch`), keyed on the **requested username** (`filters.query`, `@` stripped).
- **No change** to the budget gate, manual scrape, rollup, cleanup, idea-gen, discovery. DRY / YAGNI / TDD / frequent commits.

---

### Task 1: Pure cadence helpers + tests

**Files:**
- Modify: `server/scheduler.js` — add helpers near the top (after the `require`s, before `runAutoScrape`); add them to `module.exports`.
- Create: `server/cadence.test.js`.

**Interfaces:**
- Produces:
  - `cadenceConfig(env = process.env) → cfg` — `{ maxPerCycle, activePpw, moderatePpw, intervalActive, intervalModerate, intervalQuiet, freqWindowDays, backoffBase, backoffMax }`, each from env with the default above; non-numeric/negative → default; `freqWindowDays` floored to int.
  - `computeInterval(postsPerWeek, cfg) → days`.
  - `backoffDays(consecutiveFailures, cfg) → days`.
  - `daysSince(iso, nowMs) → number` (Infinity for null/malformed).
  - `isDue(acct, nowMs, cfg) → boolean` where `acct = { last_scraped_at, last_attempt_at, consecutive_failures, postsPerWeek }`.
  - `selectDueAccounts(accounts, nowMs, cfg) → Account[]` (due only, most-overdue first, capped at `cfg.maxPerCycle`).
  - `buildCadenceAccounts(accountRows, freqRows, cfg) → Account[]` (merges `{username,last_scraped_at,last_attempt_at,consecutive_failures}` rows with `{username, recent_post_count}` rows → adds `postsPerWeek`).

- [ ] **Step 1: Write the failing test**

Create `server/cadence.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const {
  cadenceConfig, computeInterval, backoffDays, daysSince, isDue, selectDueAccounts, buildCadenceAccounts,
} = require('./scheduler');

const CFG = cadenceConfig({}); // all defaults
const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_000_000 * DAY; // arbitrary fixed "now" in ms

test('cadenceConfig: defaults + env override + bad values fall back', () => {
  assert.strictEqual(CFG.maxPerCycle, 10);
  assert.strictEqual(CFG.intervalQuiet, 8);
  assert.strictEqual(cadenceConfig({ SCRAPE_MAX_PER_CYCLE: '3' }).maxPerCycle, 3);
  assert.strictEqual(cadenceConfig({ SCRAPE_MAX_PER_CYCLE: 'nope' }).maxPerCycle, 10);
  assert.strictEqual(cadenceConfig({ CADENCE_FREQ_WINDOW_DAYS: '30.9' }).freqWindowDays, 30); // floored int
});

test('computeInterval: active/moderate/quiet incl. boundaries', () => {
  assert.strictEqual(computeInterval(10, CFG), 2);
  assert.strictEqual(computeInterval(4, CFG), 2);   // boundary = active
  assert.strictEqual(computeInterval(1, CFG), 4);   // boundary = moderate
  assert.strictEqual(computeInterval(0.5, CFG), 8); // quiet
  assert.strictEqual(computeInterval(0, CFG), 8);
});

test('backoffDays: 0 → 0, doubles, clamps at max', () => {
  assert.strictEqual(backoffDays(0, CFG), 0);
  assert.strictEqual(backoffDays(1, CFG), 1);
  assert.strictEqual(backoffDays(2, CFG), 2);
  assert.strictEqual(backoffDays(3, CFG), 4);
  assert.strictEqual(backoffDays(99, CFG), 14); // clamp
});

test('daysSince: null/malformed → Infinity', () => {
  assert.strictEqual(daysSince(null, NOW), Infinity);
  assert.strictEqual(daysSince('garbage', NOW), Infinity);
  assert.strictEqual(daysSince(new Date(NOW - 3 * DAY).toISOString(), NOW), 3);
});

test('isDue: never-scraped → due', () => {
  assert.strictEqual(isDue({ last_scraped_at: null, postsPerWeek: 0, consecutive_failures: 0 }, NOW, CFG), true);
});

test('isDue: within interval → not due', () => {
  const acct = { last_scraped_at: new Date(NOW - 1 * DAY).toISOString(), postsPerWeek: 5, consecutive_failures: 0 }; // interval 2
  assert.strictEqual(isDue(acct, NOW, CFG), false);
});

test('isDue: past interval but in backoff cooldown → not due', () => {
  const acct = {
    last_scraped_at: new Date(NOW - 9 * DAY).toISOString(), // quiet interval 8 → past
    last_attempt_at: new Date(NOW - 1 * DAY).toISOString(),  // attempted 1d ago
    postsPerWeek: 0, consecutive_failures: 3,                // backoff 4d → still cooling
  };
  assert.strictEqual(isDue(acct, NOW, CFG), false);
});

test('isDue: past interval and past cooldown → due', () => {
  const acct = {
    last_scraped_at: new Date(NOW - 20 * DAY).toISOString(),
    last_attempt_at: new Date(NOW - 10 * DAY).toISOString(), // cooled (backoff for 3 failures = 4d)
    postsPerWeek: 0, consecutive_failures: 3,
  };
  assert.strictEqual(isDue(acct, NOW, CFG), true);
});

test('selectDueAccounts: filters non-due, most-overdue first, respects cap', () => {
  const mk = (u, scrapedDaysAgo, ppw = 0, fails = 0, attemptDaysAgo = scrapedDaysAgo) => ({
    username: u,
    last_scraped_at: scrapedDaysAgo == null ? null : new Date(NOW - scrapedDaysAgo * DAY).toISOString(),
    last_attempt_at: attemptDaysAgo == null ? null : new Date(NOW - attemptDaysAgo * DAY).toISOString(),
    postsPerWeek: ppw, consecutive_failures: fails,
  });
  const accts = [
    mk('fresh', 1, 5),                 // within interval 2 → not due
    mk('never', null),                 // never → due (most overdue)
    mk('stale', 20, 0),                // quiet, way overdue → due
    mk('mid', 9, 0),                   // quiet, just overdue → due
    mk('failing', 30, 0, 3, 1),        // overdue but cooling (attempt 1d, backoff 4d) → not due
  ];
  const due = selectDueAccounts(accts, NOW, { ...CFG, maxPerCycle: 2 });
  assert.deepStrictEqual(due.map(a => a.username), ['never', 'stale']); // never (Inf) then most-overdue, capped at 2
});

test('buildCadenceAccounts: merges rows + computes postsPerWeek over the window', () => {
  const cfg = { ...CFG, freqWindowDays: 28 }; // 4 weeks
  const rows = [{ username: 'a', last_scraped_at: null, last_attempt_at: null, consecutive_failures: 2 }, { username: 'b', last_scraped_at: null }];
  const freq = [{ username: 'a', recent_post_count: 8 }]; // 8 posts / 4 weeks = 2 ppw
  const out = buildCadenceAccounts(rows, freq, cfg);
  assert.strictEqual(out[0].postsPerWeek, 2);
  assert.strictEqual(out[0].consecutive_failures, 2);
  assert.strictEqual(out[1].postsPerWeek, 0); // b absent from freq
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test cadence.test.js`
Expected: FAIL — helpers not exported / undefined.

- [ ] **Step 3: Implement the helpers**

In `server/scheduler.js`, after the `require` block (after line ~6, before `let scraperInstance`), add:

```js
function cadenceConfig(env = process.env) {
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
  return {
    maxPerCycle: num(env.SCRAPE_MAX_PER_CYCLE, 10),
    activePpw: num(env.CADENCE_ACTIVE_PPW, 4),
    moderatePpw: num(env.CADENCE_MODERATE_PPW, 1),
    intervalActive: num(env.CADENCE_INTERVAL_ACTIVE, 2),
    intervalModerate: num(env.CADENCE_INTERVAL_MODERATE, 4),
    intervalQuiet: num(env.CADENCE_INTERVAL_QUIET, 8),
    freqWindowDays: Math.floor(num(env.CADENCE_FREQ_WINDOW_DAYS, 28)),
    backoffBase: num(env.CADENCE_BACKOFF_BASE, 1),
    backoffMax: num(env.CADENCE_BACKOFF_MAX, 14),
  };
}

function computeInterval(postsPerWeek, cfg = cadenceConfig()) {
  const ppw = Number(postsPerWeek) || 0;
  if (ppw >= cfg.activePpw) return cfg.intervalActive;
  if (ppw >= cfg.moderatePpw) return cfg.intervalModerate;
  return cfg.intervalQuiet;
}

function backoffDays(consecutiveFailures, cfg = cadenceConfig()) {
  const f = Number(consecutiveFailures) || 0;
  if (f <= 0) return 0;
  return Math.min(cfg.backoffBase * Math.pow(2, f - 1), cfg.backoffMax);
}

function daysSince(iso, nowMs) {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return Infinity; // malformed → very old → fail-open to due
  return (nowMs - t) / (24 * 60 * 60 * 1000);
}

function isDue(acct, nowMs, cfg = cadenceConfig()) {
  const interval = computeInterval(acct.postsPerWeek || 0, cfg);
  if (daysSince(acct.last_scraped_at, nowMs) < interval) return false;
  const cooldown = backoffDays(acct.consecutive_failures, cfg);
  if (cooldown > 0 && daysSince(acct.last_attempt_at, nowMs) < cooldown) return false;
  return true;
}

function selectDueAccounts(accounts, nowMs, cfg = cadenceConfig()) {
  return accounts
    .filter(a => isDue(a, nowMs, cfg))
    .sort((a, b) => daysSince(b.last_scraped_at, nowMs) - daysSince(a.last_scraped_at, nowMs))
    .slice(0, cfg.maxPerCycle);
}

function buildCadenceAccounts(accountRows, freqRows, cfg = cadenceConfig()) {
  const weeks = (cfg.freqWindowDays || 28) / 7;
  const freq = new Map((freqRows || []).map(r => [r.username, Number(r.recent_post_count) || 0]));
  return (accountRows || []).map(a => ({
    username: a.username,
    last_scraped_at: a.last_scraped_at || null,
    last_attempt_at: a.last_attempt_at || null,
    consecutive_failures: Number(a.consecutive_failures) || 0,
    postsPerWeek: weeks > 0 ? (freq.get(a.username) || 0) / weeks : 0,
  }));
}
```

- [ ] **Step 4: Export the helpers**

Change the `module.exports` line at the bottom of `server/scheduler.js` to add the new names:

```js
module.exports = { startScheduler, getSchedulerStatus, runAutoScrape, runEngagementRollup, runAutoCleanup, runDiscovery, runIdeaGeneration, runThumbnailSweep, cadenceConfig, computeInterval, backoffDays, daysSince, isDue, selectDueAccounts, buildCadenceAccounts };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && node --test cadence.test.js`
Expected: PASS (all 10 tests).

- [ ] **Step 6: Commit**

```bash
git add server/scheduler.js server/cadence.test.js
git commit -m "feat(cadence): pure staleness/backoff helpers for scrape scheduling"
```

---

### Task 2: Schema columns + completion-path failure recording

**Files:**
- Modify: `server/db.js` — add two columns to both migration arms (~L270-287).
- Modify: `server/scraper.js` — `_fetchAndStoreResults` success reset + 0-post increment (~L561); `_pollAndStore` failure increments (~L380-402). Add a small `isTrackedUsernameQuery` helper + export.
- Create: `server/cadence-recording.test.js`.

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `isTrackedUsernameQuery(query) → boolean` (true for a non-empty, non-`#`, non-`http` query — i.e. a tracked-account username). The `consecutive_failures` column other tasks read.

- [ ] **Step 1: Write the failing test**

Create `server/cadence-recording.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { isTrackedUsernameQuery } = require('./scraper');

test('isTrackedUsernameQuery: username yes; hashtag/url/empty no', () => {
  assert.strictEqual(isTrackedUsernameQuery('sophiamoiss'), true);
  assert.strictEqual(isTrackedUsernameQuery('@sophiamoiss'), true);
  assert.strictEqual(isTrackedUsernameQuery('#dance'), false);
  assert.strictEqual(isTrackedUsernameQuery('https://instagram.com/x/'), false);
  assert.strictEqual(isTrackedUsernameQuery(''), false);
  assert.strictEqual(isTrackedUsernameQuery(null), false);
});

test('failure increment + success reset SQL round-trip (sqlite)', () => {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE tracked_accounts (username TEXT UNIQUE, consecutive_failures INTEGER DEFAULT 0)");
  db.prepare("INSERT INTO tracked_accounts (username, consecutive_failures) VALUES ('a', 0)").run();
  const bump = db.prepare("UPDATE tracked_accounts SET consecutive_failures = COALESCE(consecutive_failures,0) + 1 WHERE username = ?");
  bump.run('a'); bump.run('a');
  assert.strictEqual(db.prepare("SELECT consecutive_failures c FROM tracked_accounts WHERE username='a'").get().c, 2);
  db.prepare("UPDATE tracked_accounts SET consecutive_failures = 0 WHERE username = ?").run('a');
  assert.strictEqual(db.prepare("SELECT consecutive_failures c FROM tracked_accounts WHERE username='a'").get().c, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test cadence-recording.test.js`
Expected: FAIL — `isTrackedUsernameQuery` is not a function.

- [ ] **Step 3: Add the migration columns (both arms)**

In `server/db.js`, in the **Postgres** arm (the `ADD COLUMN IF NOT EXISTS` block, after the `posts ... tagged_users` line added in PR #6 — i.e. after the last `posts`/`suggested_accounts` ADD), add:

```js
      `ALTER TABLE tracked_accounts ADD COLUMN IF NOT EXISTS last_attempt_at TEXT DEFAULT NULL`,
      `ALTER TABLE tracked_accounts ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER DEFAULT 0`,
```

In the **SQLite** arm (the plain `ADD COLUMN` block), add:

```js
      `ALTER TABLE tracked_accounts ADD COLUMN last_attempt_at TEXT DEFAULT NULL`,
      `ALTER TABLE tracked_accounts ADD COLUMN consecutive_failures INTEGER DEFAULT 0`,
```

- [ ] **Step 4: Add `isTrackedUsernameQuery` + export in `scraper.js`**

In `server/scraper.js`, near the other top-level helpers (e.g. after `calcER`/`extractViews`), add:

```js
function isTrackedUsernameQuery(query) {
  return typeof query === 'string' && query.trim() !== '' && !query.startsWith('#') && !query.startsWith('http');
}
```

Add to the exports block (after `module.exports.parseTaggedUsers = parseTaggedUsers;`):

```js
module.exports.isTrackedUsernameQuery = isTrackedUsernameQuery;
```

- [ ] **Step 5: Success reset + 0-post increment in `_fetchAndStoreResults`**

In `server/scraper.js`, find the success update (~L561):

```js
    if (accountHandle) {
      await pool.query(
        `UPDATE tracked_accounts SET last_scraped_at = TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), last_post_count = $1, followers = $2, updated_at = TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') WHERE username = $3`,
        [count, followersCount, accountHandle]
      );
    }
```

Replace it with (adds `consecutive_failures = 0` to the success update, and a 0-post increment afterward):

```js
    if (accountHandle) {
      await pool.query(
        `UPDATE tracked_accounts SET last_scraped_at = TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), last_post_count = $1, followers = $2, consecutive_failures = 0, updated_at = TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') WHERE username = $3`,
        [count, followersCount, accountHandle]
      );
    } else if (count === 0 && isTrackedUsernameQuery(filters.query) && !filters.minLikes && !filters.minViews && !filters.startDate && !filters.endDate) {
      // Scrape completed but found nothing for a tracked account (no filters) → count as a failure for cadence backoff.
      try {
        await pool.query(
          `UPDATE tracked_accounts SET consecutive_failures = COALESCE(consecutive_failures, 0) + 1 WHERE username = $1`,
          [filters.query.replace('@', '')]
        );
      } catch (e) { console.error('[Cadence] 0-post failure record failed:', e.message); }
    }
```

- [ ] **Step 6: Failure increment in `_pollAndStore`**

In `server/scraper.js` `_pollAndStore`, in the `FAILED || ABORTED || TIMED-OUT` branch (~L380, right after the `scrape_jobs` UPDATE and before its `return`), add:

```js
          if (isTrackedUsernameQuery(filters.query)) {
            try { await pool.query(`UPDATE tracked_accounts SET consecutive_failures = COALESCE(consecutive_failures, 0) + 1 WHERE username = $1`, [filters.query.replace('@', '')]); } catch (e) {}
          }
```

And in the polling-timeout branch (~L398, after that `scrape_jobs` UPDATE), add the identical block:

```js
          if (isTrackedUsernameQuery(filters.query)) {
            try { await pool.query(`UPDATE tracked_accounts SET consecutive_failures = COALESCE(consecutive_failures, 0) + 1 WHERE username = $1`, [filters.query.replace('@', '')]); } catch (e) {}
          }
```

- [ ] **Step 7: Run focused + full suite**

Run: `cd server && node --test cadence-recording.test.js` → PASS.
Run: `cd server && npm test` → all existing + new tests pass (no regressions).

- [ ] **Step 8: Commit**

```bash
git add server/db.js server/scraper.js server/cadence-recording.test.js
git commit -m "feat(cadence): tracked_accounts attempt/failure columns + completion recording

last_attempt_at + consecutive_failures columns (dual-mode). Scrape completion
resets failures on success-with-posts, increments on 0-posts (no-filter
username scrape) and on run failure/timeout."
```

---

### Task 3: `runAutoScrape` rewrite (due selection + cap + metric) and daily cron

**Files:**
- Modify: `server/scheduler.js` — rewrite `runAutoScrape` (~L17-43); change the auto-scrape cron in `startScheduler` (~L189).

**Interfaces:**
- Consumes: `cadenceConfig`, `buildCadenceAccounts`, `selectDueAccounts`, `isDue`, `computeInterval`, `daysSince` (Task 1); `tracked_accounts.last_attempt_at`/`consecutive_failures` (Task 2).
- Produces: none (terminal task).

- [ ] **Step 1: Rewrite `runAutoScrape`**

In `server/scheduler.js`, replace the entire `runAutoScrape` function (~L17-43) with:

```js
async function runAutoScrape() {
  jobStatus.autoScrape.status = 'running';
  jobStatus.autoScrape.lastRun = new Date().toISOString();
  console.log('[Scheduler] Auto-scrape starting...');
  try {
    const cfg = cadenceConfig();
    const accountsRes = await pool.query("SELECT username, last_scraped_at, last_attempt_at, consecutive_failures FROM tracked_accounts WHERE status = 'active'");
    if (accountsRes.rows.length === 0) { jobStatus.autoScrape.message = 'No active accounts'; jobStatus.autoScrape.status = 'idle'; return; }

    const freqRes = await pool.query(
      `SELECT account_handle AS username, COUNT(*) AS recent_post_count FROM posts
       WHERE posted_at >= TO_CHAR(NOW() - INTERVAL '${cfg.freqWindowDays} days', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
         AND (soft_deleted = 0 OR soft_deleted IS NULL)
       GROUP BY account_handle`
    );

    const now = Date.now();
    const accounts = buildCadenceAccounts(accountsRes.rows, freqRes.rows, cfg);
    const due = selectDueAccounts(accounts, now, cfg);
    const totalDue = accounts.filter(a => isDue(a, now, cfg)).length;
    const capped = Math.max(0, totalDue - due.length);
    const backedOff = accounts.filter(a => !isDue(a, now, cfg) && daysSince(a.last_scraped_at, now) >= computeInterval(a.postsPerWeek, cfg)).length;

    let scraped = 0;
    for (const account of due) {
      try {
        await pool.query(`UPDATE tracked_accounts SET last_attempt_at = TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') WHERE username = $1`, [account.username]);
        await scraperInstance.startScrapeJob({ query: account.username, queryType: 'username', minLikes: null, minViews: null, startDate: null, endDate: null, source: 'auto' });
        scraped++;
        if (scraped < due.length) await new Promise(r => setTimeout(r, 30000));
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          console.log(`[Metric] auto_scrape_budget_stop scraped=${scraped} due=${due.length} msg="${err.message}"`);
          jobStatus.autoScrape.message = `Stopped at ${scraped}/${due.length} due — ${err.message}`;
          jobStatus.autoScrape.status = 'idle';
          return;
        }
        console.error(`[Scheduler] Failed to scrape @${account.username}:`, err.message);
      }
    }
    console.log(`[Metric] cadence due=${due.length} scraped=${scraped} capped=${capped} backed_off=${backedOff}`);
    jobStatus.autoScrape.message = `Scraped ${scraped} of ${due.length} due (cap ${cfg.maxPerCycle}), ${capped} capped, ${backedOff} backed off`;
    jobStatus.autoScrape.status = 'idle';
  } catch (err) { jobStatus.autoScrape.status = 'error'; jobStatus.autoScrape.message = err.message; }
}
```

- [ ] **Step 2: Change the auto-scrape cron to daily**

In `startScheduler` (~L189), change:

```js
  cron.schedule('0 3 */3 * *', () => runAutoScrape());
```
to:
```js
  cron.schedule('0 3 * * *', () => runAutoScrape()); // daily; cadence interval + per-cycle cap control actual spend
```

- [ ] **Step 3: Run the full suite**

Run: `cd server && npm test`
Expected: all tests green (Task 1 + Task 2 + existing). `runAutoScrape` is an orchestrator over the already-tested pure helpers; no new unit test is added for it (matches how `runDiscovery`/`runEngagementRollup` are handled).

- [ ] **Step 4: Sanity-check the frequency SQL under sqlite**

Run:
```bash
cd server && node -e "const {cadenceConfig}=require('./scheduler');const c=cadenceConfig();const s=\`SELECT account_handle AS username, COUNT(*) AS recent_post_count FROM posts WHERE posted_at >= TO_CHAR(NOW() - INTERVAL '\${c.freqWindowDays} days', 'YYYY-MM-DD\\\"T\\\"HH24:MI:SS\\\"Z\\\"') AND (soft_deleted = 0 OR soft_deleted IS NULL) GROUP BY account_handle\`;const pool=require('./db');pool.query(s).then(r=>{console.log('freq query OK, rows:',r.rows.length);process.exit(0)}).catch(e=>{console.error('FREQ SQL ERR',e.message);process.exit(1)})"
```
Expected: `freq query OK, rows: <n>` (confirms the `INTERVAL '<int> days'` rewrite works against the local sqlite — no SQL error).

- [ ] **Step 5: Commit**

```bash
git add server/scheduler.js
git commit -m "feat(cadence): runAutoScrape selects due+capped accounts, daily cron

Builds per-account cadence from posting frequency, scrapes only due accounts
(most-overdue first, capped at SCRAPE_MAX_PER_CYCLE), stamps last_attempt_at,
logs [Metric] cadence. Cron every-3-days → daily."
```

---

## Self-Review

**1. Spec coverage:**
- §4a pure helpers → Task 1. ✓
- §4b `runAutoScrape` rewrite (freq query, due+cap, last_attempt_at, metric) → Task 3. ✓
- §4c success/failure recording (keyed on `filters.query`, 0-post + failure increments, success reset) → Task 2 Steps 5-6. ✓
- §4d env config → Task 1 `cadenceConfig`. ✓
- §5 schema (2 columns, both arms) → Task 2 Step 3. ✓
- §6 observability (`[Metric] cadence …`, status message) → Task 3 Step 1. ✓
- §3 daily cron → Task 3 Step 2. ✓
- §8 tests (computeInterval/backoffDays/isDue/selectDueAccounts + recording round-trip) → Tasks 1 & 2 test steps. ✓
- Non-goals (Thrust 3, budget gate, other jobs) → untouched. ✓

**2. Placeholder scan:** No TBD/TODO/vague steps — all code inline. The frequency-window integer constraint is enforced (`Math.floor`) and re-verified in Task 3 Step 4.

**3. Type consistency:** `cadenceConfig()→cfg` shape consumed identically by every helper and by `runAutoScrape`. Account object shape (`{username,last_scraped_at,last_attempt_at,consecutive_failures,postsPerWeek}`) produced by `buildCadenceAccounts` and consumed by `isDue`/`selectDueAccounts`. `nowMs` (number) is the time arg everywhere. `isTrackedUsernameQuery(query)→bool` used in all three recording sites. Column names `last_attempt_at`/`consecutive_failures` consistent across db.js, scraper.js, and scheduler.js. ✓
