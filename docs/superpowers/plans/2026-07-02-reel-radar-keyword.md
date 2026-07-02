# Reel Radar v2 — Keyword-Driven Creator Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a keyword-driven creator-discovery pipeline: an admin-managed list of keywords ("blonde", "petite", …) → `data-slayer~instagram-search-reels` harvest → extract distinct creators → insert into `suggested_accounts` → run today's `captureTopReels` + `scoreReels`, so radar-found creators appear in the existing Suggested tab with a reel-performance score and a 3-reel preview.

**Architecture:** Author-centric. A new `server/radar.js` module holds pure helpers (ported/adapted from the parked `reel-radar-discovery` branch) plus a `runRadar(scraper)` orchestrator that mirrors `runDiscovery` in `server/scheduler.js`. A new `watch_terms` table stores the keywords. Routes in `server/index.js` manage terms and fire runs; a weekly cron triggers it. The Suggested tab gets a small "Reel Radar" panel. **No `radar_reels` table, no reel-browser** — the search reels are only a discovery signal; the creators are the product.

**Tech Stack:** Node.js (CommonJS), Express, dual-mode DB layer (`server/db.js`: PostgreSQL in prod via `pg`, SQLite via `better-sqlite3` in tests/local), Apify (`_startApifyRun`/`_waitForRun` on the `InstagramScraper` class), React + Tailwind + axios frontend. Tests: `node --test` (`node:test` + `assert` + inline `better-sqlite3`).

## Global Constraints

Every task's requirements implicitly include this section.

- **Test runner:** all server tests run from `server/` via `npm test` (= `node --test --test-concurrency=1`). A single file: `cd server && node --test radar.test.js`.
- **Dual-mode SQL:** all DB writes must run under both PostgreSQL and SQLite. Use plain Postgres syntax (`$1` params, `ON CONFLICT (...) DO NOTHING/UPDATE`); the SQLite shim in `server/db.js` accepts it. Schema is additive only: `CREATE TABLE IF NOT EXISTS`, interpolating `${SERIAL}` and `${NOW_DEFAULT}` (defined inside `initDB`).
- **Author-centric — do NOT create** a `radar_reels` table, a reel-browser tab, or `/radar/reels*` save/dismiss/bulk routes.
- **Reuse, don't reimplement scoring:** the account's `suggestion_score` and reel previews come from `scraper.captureTopReels(username)` (which internally calls `scoreReels`). Radar never computes its own score.
- **Third-party actor safety:** the harvest actor id is env-swappable (`RADAR_ACTOR_ID`, default `data-slayer~instagram-search-reels`); a harvest that is all Apify error-stubs is skipped and logged via the existing `isErrorStubResponse`.
- **Mirror discovery's guards:** gender-classify the candidate authors once and drop males (`scraper._classifyGenderBatch`); wrap Apify calls so a `BudgetExceededError` stops the cycle cleanly.
- **`require('./db')` is a unified object** with `.query(sql, params) → { rows, rowCount }` — NOT a raw pg Pool. Every module names it `pool`.
- **Commit after every task.** DRY, YAGNI, TDD.

## File Structure

| File | Create/Modify | Responsibility |
|---|---|---|
| `server/db.js` | Modify (`initDB`) | Add `watch_terms` `CREATE TABLE IF NOT EXISTS` (dual-mode). |
| `server/radar.js` | Create | Pure helpers (`radarConfig`, `normalizeSearchReel`, `passesFloors`, `selectWatchTerms`, `dedupeReels`, `excludeAuthors`, `selectRollupAuthors`) + Apify/DB glue (`harvestKeyword`, `runRadar`, `getRadarStatus`, `radarState`). Requires only `./db`; the scraper is passed in (no circular require). |
| `server/radar.test.js` | Create | `node:test` unit tests for the pure helpers, the `watch_terms` insert contract, and the `runRadar` re-entrancy guard. |
| `server/index.js` | Modify | `require('./radar')`, `app.use('/radar', requireAuth)`, and the `/radar/terms` (GET/POST/PATCH/DELETE) + `/radar/run` (POST) routes. |
| `server/radar-routes.test.js` | Create | HTTP-harness test (mirrors `integration.test.js`) for route wiring + input validation. |
| `server/scheduler.js` | Modify (`startScheduler`) | Weekly `cron.schedule('0 6 * * 1', …)` calling `radar.runRadar(scraperInstance)`, guarded. |
| `client/src/api.js` | Modify | Named axios exports for the radar endpoints. |
| `client/src/pages/SuggestedAccountsTab.js` | Modify | "Reel Radar" panel: add-keyword input, active-term chips with remove, "Run Radar" button (fire-and-forget + poll, mirroring "Run Discovery"). |

---

## Task 1: `watch_terms` table (dual-mode schema)

**Files:**
- Modify: `server/db.js` (inside `initDB`, after the `apify_runs` `CREATE TABLE` which ends at `server/db.js:283`, before the `// Migrations for existing tables` block at `server/db.js:285`)
- Test: `server/radar.test.js` (create; this task adds only the schema-contract test)

**Interfaces:**
- Produces: a `watch_terms` table with columns `id, term, kind, source, status, added_at, last_run_at, notes` and `UNIQUE(term, kind)`, with `kind DEFAULT 'keyword'`, `source DEFAULT 'user'`, `status DEFAULT 'active'`. `radarConfig`/routes/`runRadar` in later tasks read/write it.

- [ ] **Step 1: Write the failing test**

Create `server/radar.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');

// Mirror of the dual-mode DDL initDB creates — asserts the shape is creatable,
// defaults apply, and UNIQUE(term,kind) + ON CONFLICT DO NOTHING behave.
function makeWatchTerms(db) {
  db.exec(`CREATE TABLE watch_terms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    term TEXT NOT NULL,
    kind TEXT DEFAULT 'keyword',
    source TEXT DEFAULT 'user',
    status TEXT DEFAULT 'active',
    added_at TEXT,
    last_run_at TEXT DEFAULT NULL,
    notes TEXT DEFAULT '',
    UNIQUE(term, kind))`);
}

test('watch_terms: defaults apply and ON CONFLICT(term,kind) DO NOTHING is idempotent', () => {
  const db = new Database(':memory:');
  makeWatchTerms(db);
  db.prepare("INSERT INTO watch_terms (term) VALUES ('blonde') ON CONFLICT(term,kind) DO NOTHING").run();
  const dup = db.prepare("INSERT INTO watch_terms (term) VALUES ('blonde') ON CONFLICT(term,kind) DO NOTHING").run();
  assert.strictEqual(dup.changes, 0, 'second identical insert is a no-op');
  const rows = db.prepare('SELECT * FROM watch_terms').all();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].kind, 'keyword');   // default
  assert.strictEqual(rows[0].source, 'user');    // default
  assert.strictEqual(rows[0].status, 'active');  // default
});
```

- [ ] **Step 2: Run the test to verify it passes (schema-mirror test is self-contained)**

Run: `cd server && node --test radar.test.js`
Expected: PASS (this test embeds its own DDL; it fails only if the DDL shape is wrong).

- [ ] **Step 3: Add the real table to `initDB`**

In `server/db.js`, immediately AFTER the `apify_runs` `CREATE TABLE IF NOT EXISTS` block (ends `~:283`) and BEFORE the `// Migrations for existing tables` comment (`~:285`), insert:

```js
  await db.query(`
    CREATE TABLE IF NOT EXISTS watch_terms (
      id ${SERIAL},
      term TEXT NOT NULL,
      kind TEXT DEFAULT 'keyword',
      source TEXT DEFAULT 'user',
      status TEXT DEFAULT 'active',
      added_at TEXT DEFAULT ${NOW_DEFAULT},
      last_run_at TEXT DEFAULT NULL,
      notes TEXT DEFAULT '',
      UNIQUE(term, kind)
    )
  `);
```

- [ ] **Step 4: Verify the whole server test suite still passes (initDB runs against SQLite in tests)**

Run: `cd server && npm test`
Expected: PASS (no regressions; `watch_terms` now created on init).

- [ ] **Step 5: Commit**

```bash
git add server/db.js server/radar.test.js
git commit -m "feat(radar): add watch_terms table (dual-mode, kind=keyword)"
```

---

## Task 2: `radar.js` foundation — `radarConfig`, `normalizeSearchReel`, `passesFloors`

**Files:**
- Create: `server/radar.js`
- Test: `server/radar.test.js` (append)

**Interfaces:**
- Produces:
  - `radarConfig(env = process.env) → { termsPerCycle:int, maxPages:int, authorsMax:int, minViews:number, maxAgeDays:number, actorId:string }`
  - `normalizeSearchReel(item, term) → { shortcode, ownerUsername, viewCount:number|null, likeCount:number, commentCount:number, caption:string, postedAt:ISOstring|null, permalink:string, term } | null` (null when `item.code` or `item.user.username` is missing)
  - `passesFloors(reel, cfg, nowMs = Date.now()) → boolean` (reel uses the `normalizeSearchReel` shape: `viewCount`, `postedAt`)
- Consumes: nothing from other tasks. `radar.js` requires only `const pool = require('./db');`.

- [ ] **Step 1: Write the failing tests** (append to `server/radar.test.js`)

```js
const radar = require('./radar');

test('radarConfig: defaults, env override, non-numeric fallback', () => {
  const d = radar.radarConfig({});
  assert.strictEqual(d.termsPerCycle, 10);
  assert.strictEqual(d.maxPages, 1);
  assert.strictEqual(d.authorsMax, 30);
  assert.strictEqual(d.minViews, 20000);
  assert.strictEqual(d.maxAgeDays, 30);
  assert.strictEqual(d.actorId, 'data-slayer~instagram-search-reels');
  const o = radar.radarConfig({ RADAR_TERMS_PER_CYCLE: '3', RADAR_MIN_VIEWS: '1000', RADAR_ACTOR_ID: 'custom~actor' });
  assert.strictEqual(o.termsPerCycle, 3);
  assert.strictEqual(o.minViews, 1000);
  assert.strictEqual(o.actorId, 'custom~actor');
  // non-numeric env falls back to default
  assert.strictEqual(radar.radarConfig({ RADAR_MIN_VIEWS: 'abc' }).minViews, 20000);
});

test('normalizeSearchReel: maps a data-slayer item, drops incomplete, null views', () => {
  const item = {
    code: 'ABC123',
    user: { username: 'kameron.whit', full_name: 'Kameron' },
    ig_play_count: 50178, like_count: 1200, comment_count: 30,
    caption: { text: 'Blonde is the outfit', hashtags: ['blonde'] },
    taken_at_date: '2026-06-20T00:00:00Z',
    video_url: 'https://cdn/v.mp4', thumbnail_url: 'https://cdn/t.jpg',
  };
  const r = radar.normalizeSearchReel(item, 'blonde');
  assert.strictEqual(r.shortcode, 'ABC123');
  assert.strictEqual(r.ownerUsername, 'kameron.whit');
  assert.strictEqual(r.viewCount, 50178);
  assert.strictEqual(r.likeCount, 1200);
  assert.strictEqual(r.commentCount, 30);
  assert.strictEqual(r.caption, 'Blonde is the outfit');
  assert.strictEqual(r.permalink, 'https://www.instagram.com/reel/ABC123/');
  assert.strictEqual(r.term, 'blonde');
  // missing code / username → null
  assert.strictEqual(radar.normalizeSearchReel({ ...item, code: undefined }, 'blonde'), null);
  assert.strictEqual(radar.normalizeSearchReel({ ...item, user: {} }, 'blonde'), null);
  // null ig_play_count → viewCount null (not 0)
  assert.strictEqual(radar.normalizeSearchReel({ ...item, ig_play_count: null }, 'blonde').viewCount, null);
  // taken_at_date as epoch seconds → ISO string
  const epoch = radar.normalizeSearchReel({ ...item, taken_at_date: 1750377600 }, 'blonde');
  assert.strictEqual(typeof epoch.postedAt, 'string');
  assert.ok(epoch.postedAt.startsWith('2025-'));
});

test('passesFloors: minViews + age window, future-dated rejected', () => {
  const cfg = radar.radarConfig({}); // minViews 20000, maxAgeDays 30
  const now = Date.parse('2026-06-30T00:00:00Z');
  const ok = { viewCount: 60000, postedAt: '2026-06-25T00:00:00Z' };
  assert.strictEqual(radar.passesFloors(ok, cfg, now), true);
  assert.strictEqual(radar.passesFloors({ ...ok, viewCount: 10000 }, cfg, now), false);
  assert.strictEqual(radar.passesFloors({ ...ok, viewCount: null }, cfg, now), false);
  assert.strictEqual(radar.passesFloors({ ...ok, postedAt: '2026-01-01T00:00:00Z' }, cfg, now), false); // too old
  assert.strictEqual(radar.passesFloors({ ...ok, postedAt: '2026-07-05T00:00:00Z' }, cfg, now), false); // future
  assert.strictEqual(radar.passesFloors({ ...ok, postedAt: null }, cfg, now), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && node --test radar.test.js`
Expected: FAIL — `Cannot find module './radar'`.

- [ ] **Step 3: Create `server/radar.js` with the three functions**

```js
const pool = require('./db');

const DEFAULT_ACTOR_ID = 'data-slayer~instagram-search-reels';

function radarConfig(env = process.env) {
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
  return {
    termsPerCycle: Math.floor(num(env.RADAR_TERMS_PER_CYCLE, 10)),
    maxPages: Math.floor(num(env.RADAR_MAX_PAGES, 1)),
    authorsMax: Math.floor(num(env.RADAR_AUTHORS_MAX, 30)),
    minViews: num(env.RADAR_MIN_VIEWS, 20000),
    maxAgeDays: num(env.RADAR_MAX_AGE_DAYS, 30),
    actorId: env.RADAR_ACTOR_ID || DEFAULT_ACTOR_ID,
  };
}

// PURE. Map a data-slayer/instagram-search-reels item to our author-centric shape.
// Returns null when the item lacks a shortcode or a creator handle (caller filters).
function normalizeSearchReel(item, term) {
  if (!item) return null;
  const shortcode = item.code;
  const ownerUsername = item.user && item.user.username;
  if (!shortcode || !ownerUsername) return null;
  // views: null (unknown) stays null — never coerce to a fake 0.
  let viewCount = null;
  if (item.ig_play_count != null) {
    const v = Number(item.ig_play_count);
    viewCount = Number.isFinite(v) ? v : null;
  }
  // taken_at_date tolerates an ISO string OR epoch-seconds number OR null.
  let postedAt = null;
  const ta = item.taken_at_date;
  if (typeof ta === 'number' && Number.isFinite(ta)) {
    postedAt = new Date(ta * 1000).toISOString();
  } else if (typeof ta === 'string' && ta) {
    const t = Date.parse(ta);
    postedAt = Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  return {
    shortcode,
    ownerUsername: String(ownerUsername),
    viewCount,
    likeCount: Number(item.like_count) || 0,
    commentCount: Number(item.comment_count) || 0,
    caption: (item.caption && item.caption.text) || '',
    postedAt,
    permalink: `https://www.instagram.com/reel/${shortcode}/`,
    term,
  };
}

// PURE. Min-views floor + age window; future-dated reels are rejected.
function passesFloors(reel, cfg, nowMs = Date.now()) {
  const v = Number(reel.viewCount);
  if (!Number.isFinite(v) || v < cfg.minViews) return false;
  const t = reel.postedAt ? Date.parse(reel.postedAt) : NaN;
  if (!Number.isFinite(t)) return false;
  const ageDays = (nowMs - t) / (24 * 60 * 60 * 1000);
  return ageDays >= 0 && ageDays <= cfg.maxAgeDays;
}

module.exports = { radarConfig, normalizeSearchReel, passesFloors };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && node --test radar.test.js`
Expected: PASS (all Task 1 + Task 2 tests green).

- [ ] **Step 5: Commit**

```bash
git add server/radar.js server/radar.test.js
git commit -m "feat(radar): radar.js config + normalizeSearchReel + passesFloors (TDD)"
```

---

## Task 3: `radar.js` selection helpers — `selectWatchTerms`, `dedupeReels`, `excludeAuthors`, `selectRollupAuthors`

**Files:**
- Modify: `server/radar.js`
- Test: `server/radar.test.js` (append)

**Interfaces:**
- Produces:
  - `selectWatchTerms(terms, max) → term[]` — active only, an `excluded`-status row suppresses its same-`term` twin, ordered oldest-`last_run_at`-first (null first), capped at `max`.
  - `dedupeReels(reels, { knownShortcodes = new Set() }) → reel[]` — drop falsy/known/repeat shortcodes.
  - `excludeAuthors(reels, { blockedHandles = new Set() }) → reel[]` — drop reels whose `ownerUsername` (lowercased) is blocked.
  - `selectRollupAuthors(reels, cfg) → { username, term, source:'radar:<term>', reason }[]` — one entry per distinct `ownerUsername`, best (highest-`viewCount`) reel wins the term/reason, sorted by best views desc, capped at `cfg.authorsMax`.

- [ ] **Step 1: Write the failing tests** (append to `server/radar.test.js`)

```js
test('selectWatchTerms: active only, excluded suppresses twin, null-first, cap', () => {
  const terms = [
    { id: 1, term: 'a', kind: 'keyword', status: 'active',   last_run_at: '2026-06-01T00:00:00Z' },
    { id: 2, term: 'b', kind: 'keyword', status: 'active',   last_run_at: null },
    { id: 3, term: 'c', kind: 'keyword', status: 'paused',   last_run_at: null },
    { id: 4, term: 'd', kind: 'keyword', status: 'active',   last_run_at: '2026-05-01T00:00:00Z' },
    { id: 5, term: 'd', kind: 'keyword', status: 'excluded', last_run_at: null }, // excludes 'd'
  ];
  assert.deepStrictEqual(radar.selectWatchTerms(terms, 10).map(t => t.term), ['b', 'a']);
  assert.deepStrictEqual(radar.selectWatchTerms(terms, 1).map(t => t.term), ['b']); // cap
});

test('dedupeReels / excludeAuthors (author-centric shape)', () => {
  const reels = [
    { shortcode: 'A', ownerUsername: 'x' },
    { shortcode: 'A', ownerUsername: 'x' },
    { shortcode: 'B', ownerUsername: 'y' },
    { shortcode: 'C', ownerUsername: 'z' },
  ];
  const d = radar.dedupeReels(reels, { knownShortcodes: new Set(['C']) });
  assert.deepStrictEqual(d.map(r => r.shortcode), ['A', 'B']);
  const e = radar.excludeAuthors(d, { blockedHandles: new Set(['x']) });
  assert.deepStrictEqual(e.map(r => r.shortcode), ['B']);
});

test('selectRollupAuthors: distinct authors, best reel wins term, sorted, capped', () => {
  const cfg = radar.radarConfig({ RADAR_AUTHORS_MAX: '2' });
  const reels = [
    { ownerUsername: 'a', viewCount: 100000, term: 'blonde' },
    { ownerUsername: 'a', viewCount: 200000, term: 'petite' }, // best → term 'petite'
    { ownerUsername: 'b', viewCount: 150000, term: 'blonde' },
    { ownerUsername: 'c', viewCount: 50000,  term: 'blonde' }, // dropped by cap=2
  ];
  const out = radar.selectRollupAuthors(reels, cfg);
  assert.deepStrictEqual(out.map(a => a.username), ['a', 'b']); // sorted by best views desc, capped
  assert.strictEqual(out[0].source, 'radar:petite');
  assert.ok(out[0].reason.includes("found via 'petite'"));
  assert.ok(out[0].reason.includes('view reel'));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && node --test radar.test.js`
Expected: FAIL — `radar.selectWatchTerms is not a function` (and the other three).

- [ ] **Step 3: Add the four helpers to `server/radar.js`**

Insert these functions above the `module.exports` line:

```js
// PURE. Active terms, oldest-run first (never-run first), excluded twin suppressed, capped.
function selectWatchTerms(terms, max) {
  const excluded = new Set((terms || []).filter(t => t.status === 'excluded').map(t => t.term));
  const ms = (iso) => { const t = iso ? new Date(iso).getTime() : NaN; return Number.isFinite(t) ? t : -1; };
  return (terms || [])
    .filter(t => t.status === 'active' && !excluded.has(t.term))
    .sort((a, b) => {
      const d = ms(a.last_run_at) - ms(b.last_run_at);
      if (d !== 0) return d;
      return String(a.term).localeCompare(String(b.term));
    })
    .slice(0, Math.max(0, max | 0));
}

// PURE. Drop falsy/known/repeat shortcodes (order-preserving).
function dedupeReels(reels, { knownShortcodes = new Set() } = {}) {
  const seen = new Set();
  const out = [];
  for (const r of reels || []) {
    if (!r.shortcode || knownShortcodes.has(r.shortcode) || seen.has(r.shortcode)) continue;
    seen.add(r.shortcode);
    out.push(r);
  }
  return out;
}

// PURE. Drop reels whose author (lowercased) is blocked.
function excludeAuthors(reels, { blockedHandles = new Set() } = {}) {
  return (reels || []).filter(r => !blockedHandles.has(String(r.ownerUsername || '').toLowerCase()));
}

// PURE. Collapse surviving reels to distinct authors; the highest-view reel
// wins the term + reason. Sort by best views desc, then username; cap authorsMax.
function selectRollupAuthors(reels, cfg) {
  const byAuthor = new Map();
  for (const r of reels || []) {
    const u = r.ownerUsername;
    if (!u) continue;
    const key = u.toLowerCase();
    const views = Number(r.viewCount) || 0;
    const cur = byAuthor.get(key);
    if (!cur) {
      byAuthor.set(key, { username: u, term: r.term, bestViews: views });
    } else if (views > cur.bestViews) {
      cur.bestViews = views;
      cur.term = r.term;
    }
  }
  return [...byAuthor.values()]
    .sort((a, b) => (b.bestViews - a.bestViews) || String(a.username).localeCompare(String(b.username)))
    .slice(0, Math.max(0, cfg.authorsMax | 0))
    .map(a => ({
      username: a.username,
      term: a.term,
      source: `radar:${a.term}`,
      reason: `found via '${a.term}' — ${a.bestViews.toLocaleString('en-US')} view reel`,
    }));
}
```

Then update the exports line to:

```js
module.exports = { radarConfig, normalizeSearchReel, passesFloors, selectWatchTerms, dedupeReels, excludeAuthors, selectRollupAuthors };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && node --test radar.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/radar.js server/radar.test.js
git commit -m "feat(radar): selectWatchTerms/dedupeReels/excludeAuthors/selectRollupAuthors (TDD)"
```

---

## Task 4: `radar.js` orchestration — `harvestKeyword`, `runRadar`, `getRadarStatus`

**Files:**
- Modify: `server/radar.js`
- Test: `server/radar.test.js` (append — unit-tests only the re-entrancy/no-key guards; the harvest→capture path is Apify/DB glue, verified by the manual prod run in Task 8, exactly like discovery)

**Interfaces:**
- Consumes: a `scraper` instance exposing `apiKey`, `_startApifyRun(actorId, input, { purpose, query })`, `_waitForRun(runId, maxPolls) → items[]|null`, `_classifyGenderBatch(items) → { usernameLower: 'female'|'male'|'unknown' }`, `captureTopReels(username) → { count, score }` (may throw `BudgetExceededError`), and the static `InstagramScraper.isErrorStubResponse(items) → boolean`. Uses `pool` for `watch_terms`, `suggested_accounts`, `tracked_accounts`.
- Produces:
  - `harvestKeyword(scraper, term, cfg) → rawItems[]`
  - `runRadar(scraper, { env = process.env } = {}) → stats` where guarded early-returns are `{ started:false, reason:'already_running' }` / `{ started:false, reason:'no_api_key' }` and a real run returns `{ started:true, terms, authors, added, reels }`.
  - `getRadarStatus() → radarState` (`{ running:boolean, lastRun:ISO|null, message:string }`); `__setRunning(v)` test hook.

- [ ] **Step 1: Write the failing tests** (append to `server/radar.test.js`)

```js
test('runRadar: re-entrancy guard returns started:false when already running', async () => {
  radar.__setRunning(true);
  const res = await radar.runRadar({ apiKey: 'x' });
  assert.strictEqual(res.started, false);
  assert.strictEqual(res.reason, 'already_running');
  radar.__setRunning(false);
});

test('runRadar: no api key returns started:false', async () => {
  const res = await radar.runRadar({}); // no apiKey
  assert.strictEqual(res.started, false);
  assert.strictEqual(res.reason, 'no_api_key');
});

test('getRadarStatus: exposes the shared radarState object', () => {
  const s = radar.getRadarStatus();
  assert.ok(s && typeof s === 'object');
  assert.strictEqual(typeof s.running, 'boolean');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && node --test radar.test.js`
Expected: FAIL — `radar.__setRunning is not a function` / `radar.runRadar is not a function`.

- [ ] **Step 3: Add harvest + orchestration to `server/radar.js`**

At the TOP of the file, extend the require line to pull in the error-stub detector:

```js
const pool = require('./db');
const { isErrorStubResponse } = require('./scraper');
```

Then add these functions above `module.exports`:

```js
// Apify glue: run the keyword-search actor for one term. Returns raw items.
async function harvestKeyword(scraper, term, cfg) {
  const run = await scraper._startApifyRun(
    cfg.actorId,
    { query: term, maxPages: cfg.maxPages },
    { purpose: 'radar', query: term }
  );
  const items = await scraper._waitForRun(run.id, 20); // ~60s cap; keyword search is fast
  return items || [];
}

const radarState = { running: false, lastRun: null, message: '' };
function __setRunning(v) { radarState.running = v; }   // test hook
function getRadarStatus() { return radarState; }

// Orchestrator (mirrors runDiscovery): keyword → harvest → normalize → floors/dedupe/
// exclude → distinct authors → gender-drop-males → INSERT suggested_accounts →
// captureTopReels (budget-guarded). Emits one [Metric] line.
async function runRadar(scraper, { env = process.env } = {}) {
  if (radarState.running) return { started: false, reason: 'already_running' };
  if (!scraper || !scraper.apiKey) return { started: false, reason: 'no_api_key' };
  radarState.running = true;
  radarState.lastRun = new Date().toISOString();
  const cfg = radarConfig(env);
  const now = Date.now();
  const stats = { started: true, terms: 0, authors: 0, added: 0, reels: 0 };
  try {
    const termsRes = await pool.query('SELECT id, term, kind, source, status, last_run_at FROM watch_terms');
    const chosen = selectWatchTerms(termsRes.rows, cfg.termsPerCycle);
    stats.terms = chosen.length;

    // Skip authors already tracked or already suggested (any status).
    const trackedRes = await pool.query('SELECT username FROM tracked_accounts');
    const suggestedRes = await pool.query('SELECT username FROM suggested_accounts');
    const blocked = new Set(
      [...trackedRes.rows, ...suggestedRes.rows].map(x => String(x.username).toLowerCase())
    );

    const known = new Set();   // intra-cycle shortcode dedupe
    const surviving = [];
    for (const term of chosen) {
      let raw = [];
      try {
        raw = await harvestKeyword(scraper, term.term, cfg);
      } catch (e) {
        if (e && e.name === 'BudgetExceededError') { console.log(`[Metric] radar_budget_stop term=${term.term}`); break; }
        console.error(`[Radar] harvest failed for '${term.term}':`, e.message);
      }
      // Stamp last_run_at best-effort (dual-mode NOW()).
      try {
        await pool.query(`UPDATE watch_terms SET last_run_at = TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') WHERE id = $1`, [term.id]);
      } catch (e) {}
      // Third-party actor safety: an all-error-stub response means IG blocked us — skip.
      if (isErrorStubResponse(raw)) { console.log(`[Radar] '${term.term}' harvest was all error-stubs — skipped`); continue; }

      let reels = raw.map(it => normalizeSearchReel(it, term.term)).filter(Boolean);
      reels = reels.filter(r => passesFloors(r, cfg, now));
      reels = dedupeReels(reels, { knownShortcodes: known });
      reels = excludeAuthors(reels, { blockedHandles: blocked });
      reels.forEach(r => known.add(r.shortcode));
      surviving.push(...reels);
    }

    const authors = selectRollupAuthors(surviving, cfg); // distinct, capped authorsMax

    // Gender-classify once; drop males (mirror discovery). On failure: treat all as unknown.
    let verdicts = {};
    try {
      verdicts = await scraper._classifyGenderBatch(
        authors.map(a => ({ username: a.username, bio: '', captionSnippet: '', taggedBy: a.source }))
      ) || {};
    } catch (e) { console.error('[Radar] gender classify failed:', e.message); verdicts = {}; }
    const kept = [];
    for (const a of authors) {
      const gender = verdicts[a.username.toLowerCase()] || 'unknown';
      if (gender === 'male') { console.log(`[Radar] Filtered out @${a.username} (male)`); continue; }
      a.gender = gender;
      kept.push(a);
    }
    stats.authors = kept.length;

    let budgetStop = false;
    for (const a of kept) {
      try {
        const ins = await pool.query(
          `INSERT INTO suggested_accounts (username, source, relevance_reason, gender)
           VALUES ($1,$2,$3,$4) ON CONFLICT (username) DO NOTHING`,
          [a.username, a.source, a.reason, a.gender || 'unknown']
        );
        if (ins.rowCount > 0) {
          stats.added++;
          if (!budgetStop) {
            try {
              await scraper.captureTopReels(a.username); // sets suggestion_score + reel previews
              stats.reels++;
            } catch (e) {
              if (e && e.name === 'BudgetExceededError') { budgetStop = true; console.log(`[Radar] reel capture stopped at budget (captured ${stats.reels})`); }
              else console.error(`[Radar] reel capture failed for @${a.username}:`, e.message);
            }
          }
        }
      } catch (e) { console.error(`[Radar] insert failed for @${a.username}:`, e.message); }
    }

    console.log(`[Metric] radar terms=${stats.terms} authors=${stats.authors} added=${stats.added} reels=${stats.reels}`);
    radarState.message = `Terms ${stats.terms}, authors +${stats.added}, reels ${stats.reels}`;
  } catch (err) {
    radarState.message = err.message;
    console.error('[Radar] run failed:', err.message);
  } finally {
    radarState.running = false;
  }
  return stats;
}
```

Update the exports line to:

```js
module.exports = { radarConfig, normalizeSearchReel, passesFloors, selectWatchTerms, dedupeReels, excludeAuthors, selectRollupAuthors, harvestKeyword, runRadar, getRadarStatus, __setRunning };
```

> Note on `_classifyGenderBatch` in the no-op tests: the guard tests never reach it (they early-return). The re-entrancy test passes `{ apiKey: 'x' }` but is stopped by the running-guard before any scraper method is called; the no-key test passes `{}`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && node --test radar.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full server suite (guards against circular-require breakage from `require('./scraper')`)**

Run: `cd server && npm test`
Expected: PASS. (If a circular-require warning appears because `scraper.js` transitively requires `radar.js` — it does not today — resolve by importing `isErrorStubResponse` lazily inside `harvestKeyword`/`runRadar` instead of at top level.)

- [ ] **Step 6: Commit**

```bash
git add server/radar.js server/radar.test.js
git commit -m "feat(radar): harvestKeyword + runRadar orchestrator + status (TDD guards)"
```

---

## Task 5: Backend routes — `/radar/terms` CRUD + `/radar/run`

**Files:**
- Modify: `server/index.js` (add `require('./radar')` near the other top-level requires ~`:9-12`; add `app.use('/radar', requireAuth);` to the auth block at `~:99-112`; add the route handlers — place them in a `// ─── Reel Radar Routes ───` section, e.g. near the scheduler routes ~`:444-454`)
- Test: `server/radar-routes.test.js` (create — HTTP harness mirroring `integration.test.js`)

**Interfaces:**
- Consumes: `radar.getRadarStatus()`, `radar.runRadar(scraper)` (Task 4); `scraper` (the `index.js` singleton, `server/index.js:117`); `requireAuth` (`:92`); `pool`.
- Produces: `GET /radar/terms → { terms: [...] }`; `POST /radar/terms {term} → { ok, id }` (400 `term_required` on empty); `PATCH /radar/terms/:id {status} → { ok }` (400 `bad_status` unless `active|paused`); `DELETE /radar/terms/:id → { ok }`; `POST /radar/run → { ok, started, [reason] }`.

- [ ] **Step 1: Write the failing test** (create `server/radar-routes.test.js`)

```js
process.env.AUTH_PASSWORD = ''; // disable auth for the smoke test (mirrors integration.test.js)
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');

function req(server, method, path, body) {
  const { port } = server.address();
  const data = body ? JSON.stringify(body) : null;
  return new Promise((resolve) => {
    const r = http.request({ port, path, method, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let b = ''; res.on('data', d => b += d); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    if (data) r.write(data);
    r.end();
  });
}

test('radar routes: validation wiring (no DB dependency on the 400 paths)', async () => {
  const app = require('./index'); // exports app without listening
  const server = app.listen(0);
  try {
    // empty term → 400 term_required (returns before touching the DB)
    let r = await req(server, 'POST', '/radar/terms', {});
    assert.strictEqual(r.status, 400);
    assert.match(r.body, /term_required/);
    // bad status → 400 bad_status (returns before touching the DB)
    r = await req(server, 'PATCH', '/radar/terms/1', { status: 'nope' });
    assert.strictEqual(r.status, 400);
    assert.match(r.body, /bad_status/);
  } finally { server.close(); }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && node --test radar-routes.test.js`
Expected: FAIL — POST `/radar/terms` returns 404 (route not registered) instead of 400.

- [ ] **Step 3: Wire the require + auth + routes in `server/index.js`**

Near the top requires (with `const InstagramScraper = require('./scraper');` etc.), add:

```js
const radar = require('./radar');
```

In the `app.use('<prefix>', requireAuth);` block (`~:99-112`), add:

```js
app.use('/radar', requireAuth);
```

Add the route section (place it near the scheduler routes):

```js
// ─── Reel Radar Routes ──────────────────────────────────────────
app.get('/radar/terms', async (req, res) => {
  const rows = await pool.query(
    'SELECT id, term, kind, source, status, last_run_at FROM watch_terms ORDER BY status, term'
  );
  res.json({ terms: rows.rows });
});

app.post('/radar/terms', async (req, res) => {
  const { term } = req.body || {};
  if (!term || !String(term).trim()) return res.status(400).json({ ok: false, error: 'term_required' });
  const norm = String(term).replace(/^#/, '').trim().toLowerCase();
  await pool.query(
    `INSERT INTO watch_terms (term, kind, source, status) VALUES ($1,'keyword','user','active')
     ON CONFLICT (term, kind) DO UPDATE SET status = 'active'`,
    [norm]
  );
  const idRow = (await pool.query("SELECT id FROM watch_terms WHERE term = $1 AND kind = 'keyword'", [norm])).rows[0];
  res.json({ ok: true, id: idRow && idRow.id });
});

app.patch('/radar/terms/:id', async (req, res) => {
  const { status } = req.body || {};
  if (!['active', 'paused'].includes(status)) return res.status(400).json({ ok: false, error: 'bad_status' });
  await pool.query('UPDATE watch_terms SET status = $1 WHERE id = $2', [status, Number(req.params.id)]);
  res.json({ ok: true });
});

app.delete('/radar/terms/:id', async (req, res) => {
  await pool.query('DELETE FROM watch_terms WHERE id = $1', [Number(req.params.id)]);
  res.json({ ok: true });
});

app.post('/radar/run', (req, res) => {
  if (radar.getRadarStatus().running) return res.json({ ok: true, started: false, reason: 'already_running' });
  if (!scraper || !scraper.apiKey) return res.json({ ok: true, started: false, reason: 'no_api_key' });
  radar.runRadar(scraper).catch(e => console.error('[Radar] run failed:', e.message));
  res.json({ ok: true, started: true });
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && node --test radar-routes.test.js`
Expected: PASS.

- [ ] **Step 5: Manual happy-path smoke (local, DB-backed)**

Run (in one shell): `cd server && AUTH_PASSWORD='' node index.js`
Then in another shell:
```bash
curl -s -XPOST localhost:4000/radar/terms -H 'Content-Type: application/json' -d '{"term":"Blonde"}'   # → {"ok":true,"id":1}
curl -s localhost:4000/radar/terms                                                                       # → {"terms":[{"term":"blonde","kind":"keyword",...}]}
curl -s -XPOST localhost:4000/radar/run                                                                   # → {"ok":true,"started":false,"reason":"no_api_key"}  (no APIFY key locally)
```
Expected: term normalized to `blonde`, appears in the list; `/radar/run` returns a JSON `started` verdict (not a crash). Stop the server (Ctrl-C).

- [ ] **Step 6: Run the full server suite**

Run: `cd server && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/index.js server/radar-routes.test.js
git commit -m "feat(radar): /radar/terms CRUD + /radar/run routes (behind requireAuth)"
```

---

## Task 6: Weekly cron trigger

**Files:**
- Modify: `server/scheduler.js` (add `const radar = require('./radar');` near the top requires ~`:1-3`; add one `cron.schedule` line inside `startScheduler` ~`:371-380`)

**Interfaces:**
- Consumes: `radar.runRadar` (Task 4); the module-level `scraperInstance` set in `startScheduler`.
- Produces: a Monday-06:00-UTC job (after discovery's Monday 04:00) that runs radar when the scraper + API key are present.

- [ ] **Step 1: Add the require** at the top of `server/scheduler.js` (with the other requires):

```js
const radar = require('./radar');
```

- [ ] **Step 2: Add the cron line** inside `startScheduler(scraper)`, alongside the existing `cron.schedule(...)` calls (e.g. right after the discovery line `cron.schedule('0 4 * * 1', () => runDiscovery());`):

```js
  cron.schedule('0 6 * * 1', () => {
    if (!scraperInstance || !scraperInstance.apiKey) return;
    radar.runRadar(scraperInstance).catch(e => console.error('[Radar] cron run failed:', e.message));
  });
```

- [ ] **Step 3: Verify the scheduler module loads and the suite is green**

Run: `cd server && node -e "require('./scheduler'); console.log('scheduler loads OK')"`
Expected: prints `scheduler loads OK` (no require/circular errors).
Run: `cd server && npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/scheduler.js
git commit -m "feat(radar): weekly Monday 6am cron for runRadar"
```

---

## Task 7: Frontend — Reel Radar panel in the Suggested tab

**Files:**
- Modify: `client/src/api.js` (add radar endpoints after the `// Suggested accounts` block ~`:40-46`)
- Modify: `client/src/pages/SuggestedAccountsTab.js` (add imports, state, handlers, and the panel JSX)

**Interfaces:**
- Consumes: the routes from Task 5.
- Produces: an admin UI to add/list/remove keyword terms and fire a radar run. Radar-found creators appear in the normal suggestions list (they are `suggested_accounts`), with `relevance_reason` = `found via '<term>' — <N> view reel` already rendered by the existing card (`SuggestedAccountsTab.js:255-257`).

- [ ] **Step 1: Add the API client functions** — in `client/src/api.js`, after the `// Suggested accounts` block, insert:

```js
// Reel Radar (keyword-driven creator discovery)
export const getRadarTerms = () => api.get('/radar/terms');
export const addRadarTerm = (term) => api.post('/radar/terms', { term });
export const setRadarTermStatus = (id, status) => api.patch(`/radar/terms/${id}`, { status });
export const removeRadarTerm = (id) => api.delete(`/radar/terms/${id}`);
export const triggerRadar = () => api.post('/radar/run');
```

- [ ] **Step 2: Extend the imports** in `client/src/pages/SuggestedAccountsTab.js` — add the new functions to the existing `import { ... } from '../api';` line (line 2):

```js
import { getSuggestedAccounts, approveSuggested, dismissSuggested, snoozeSuggested, triggerJob, approveSuggestedBulk, scrapeTrackedBulk, getRadarTerms, addRadarTerm, removeRadarTerm, triggerRadar } from '../api';
```

- [ ] **Step 3: Add radar state + handlers** — inside `export default function SuggestedAccountsTab()`, after the existing `useState`/`load` declarations (after the `load`/`useEffect` block ~`:94-106`), add:

```js
  // ── Reel Radar ──
  const [radarTerms, setRadarTerms] = useState([]);
  const [newTerm, setNewTerm] = useState('');
  const [radarRunning, setRadarRunning] = useState(false);

  const loadRadarTerms = useCallback(async () => {
    try {
      const { data } = await getRadarTerms();
      setRadarTerms(data.terms || []);
    } catch (e) { /* non-fatal */ }
  }, []);

  useEffect(() => { loadRadarTerms(); }, [loadRadarTerms]);

  const handleAddTerm = async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    const t = newTerm.trim();
    if (!t) return;
    try {
      await addRadarTerm(t);
      setNewTerm('');
      await loadRadarTerms();
    } catch (err) { console.error('Failed to add radar term:', err); }
  };

  const handleRemoveTerm = async (id) => {
    try { await removeRadarTerm(id); await loadRadarTerms(); }
    catch (err) { console.error('Failed to remove radar term:', err); }
  };

  const handleRunRadar = async () => {
    setRadarRunning(true);
    try { await triggerRadar(); } catch (e) { /* keep polling anyway */ }
    // Radar makes several Apify calls; poll the suggestions list every 15s
    // until it grows or a 5-minute cap, mirroring Run Discovery.
    const startLen = suggestions.length;
    let elapsed = 0;
    const poll = setInterval(async () => {
      elapsed += 15;
      try {
        const { data } = await getSuggestedAccounts({ status: 'pending', sort });
        if (data.length > startLen || elapsed >= 300) {
          clearInterval(poll);
          setSuggestions(data);
          setRadarRunning(false);
          loadRadarTerms(); // refresh last_run_at
        }
      } catch (e) { /* keep polling */ }
    }, 15000);
  };
```

- [ ] **Step 4: Add the panel JSX** — locate the controls panel `<div className="bg-gray-900 rounded-xl border border-gray-800 p-5">` (~`:294`) that holds the Run Discovery button, and its closing `</div>`. Immediately AFTER that closing `</div>`, insert the Reel Radar panel:

```jsx
      {/* Reel Radar — keyword-driven creator discovery */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold text-white">Reel Radar</h3>
            <p className="text-xs text-gray-500">Find fresh creators by keyword. New creators land in the list below.</p>
          </div>
          <button
            onClick={handleRunRadar}
            disabled={radarRunning}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              radarRunning
                ? 'bg-gold/20 border border-gold/40 text-gold animate-pulse'
                : 'bg-gold hover:bg-gold-light text-gray-950 font-semibold'
            }`}
          >
            {radarRunning ? 'Scanning...' : 'Run Radar'}
          </button>
        </div>
        <form onSubmit={handleAddTerm} className="flex gap-2 mb-3">
          <input
            type="text"
            value={newTerm}
            onChange={(e) => setNewTerm(e.target.value)}
            placeholder="Add a keyword (e.g. blonde)"
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
          />
          <button
            type="submit"
            className="px-3 py-2 rounded-lg text-sm font-medium bg-gray-800 border border-gray-700 text-white hover:bg-gray-700 transition-colors"
          >
            Add
          </button>
        </form>
        <div className="flex flex-wrap gap-2">
          {radarTerms.length === 0 && (
            <span className="text-xs text-gray-500 italic">No keywords yet — add one to start.</span>
          )}
          {radarTerms.map((t) => (
            <span
              key={t.id}
              className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium border ${
                t.status === 'active'
                  ? 'bg-gold/10 text-gold border-gold/30'
                  : 'bg-gray-800 text-gray-400 border-gray-700'
              }`}
            >
              {t.term}
              <button
                onClick={() => handleRemoveTerm(t.id)}
                className="text-gray-400 hover:text-white"
                title="Remove"
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      </div>
```

- [ ] **Step 5: Verify the client builds**

Run: `cd client && npm run build`
Expected: build succeeds (no syntax/lint-breaking errors). If ESLint blocks the build on an unused import, remove the offending name.

- [ ] **Step 6: Commit**

```bash
git add client/src/api.js client/src/pages/SuggestedAccountsTab.js
git commit -m "feat(radar): Reel Radar panel in Suggested tab (add/list/remove terms, Run Radar)"
```

---

## Task 8: Merge, deploy, seed keywords, and verify (post-implementation ops)

> This task runs AFTER Tasks 1–7 are reviewed and the branch is merged. It is operational, not code. It fulfils the user's "seed watch_terms + manual radar run + verify creators land in Suggested" request.

**Prerequisite:** the exact keyword list from the user (handoff examples: `blonde`, `petite`, `domination`, …). Do NOT invent terms — confirm the full list first.

- [ ] **Step 1: Finish the branch** — use superpowers:finishing-a-development-branch. Squash-merge `feat/reel-radar-keyword` into `main` via `gh` (the local `git` merge step errors because `main` is checked out in another worktree — delete the remote branch manually after, per the handoff).

- [ ] **Step 2: Confirm deploy** — Railway auto-deploys `main` (project `brilliant-tranquility`). Verify the new build is live and `initDB` created `watch_terms` (a fresh `GET /radar/terms` returns `{ terms: [] }`).

- [ ] **Step 3: Seed the keywords** — one `POST /radar/terms` per confirmed keyword against the deployed app, authenticated with the `x-api-key` header (the `API_KEY` env value). Example:
```bash
for kw in blonde petite domination; do
  curl -s -XPOST "$APP_URL/radar/terms" -H "x-api-key: $API_KEY" \
    -H 'Content-Type: application/json' -d "{\"term\":\"$kw\"}"; echo
done
```
(Fallback if the app isn't reachable externally: `railway ssh` + a small base64'd node script into `/app/server` that inserts the rows — the internal `DATABASE_URL` only resolves in-container, per the handoff.)
Verify: `GET /radar/terms` lists all seeded terms with `status:"active"`.

- [ ] **Step 4: Manual radar run** — `curl -s -XPOST "$APP_URL/radar/run" -H "x-api-key: $API_KEY"` → expect `{ ok:true, started:true }`. Watch logs for the `[Metric] radar terms=.. authors=.. added=.. reels=..` line and any `[Radar]` warnings. Confirm no `radar_budget_stop` unless the Apify budget was genuinely near the ceiling.

- [ ] **Step 5: Verify in the Suggested tab** — open the app's Suggested tab; confirm new creators appear with a reel-performance `suggestion_score`, a 3-reel preview strip, and a `found via '<term>' — <N> view reel` relevance line. Spot-check one creator's handle on Instagram to confirm relevance. Confirm the seeded keywords show as active chips in the Reel Radar panel.

- [ ] **Step 6: Record the outcome** — note the run's metric numbers (terms/authors/added/reels) and any actor-quality issues (e.g. error-stub skips) for the next handoff; if the third-party actor misbehaved, the `RADAR_ACTOR_ID` env is the swap point.

---

## Self-Review (completed against the spec)

- **Spec coverage:** `watch_terms` table (Task 1) ✓; `radar.js` pure helpers `radarConfig`/`selectWatchTerms`/`dedupeReels`/`excludeAuthors`/`selectRollupAuthors`/`passesFloors` (Tasks 2–3) ✓; new `harvestKeyword`/`normalizeSearchReel`/`runRadar`/`getRadarStatus`/`radarState` (Tasks 2 & 4) ✓; routes GET/POST/PATCH/DELETE `/radar/terms` + POST `/radar/run` (Task 5) ✓; weekly cron `0 6 * * 1` (Task 6) ✓; frontend Reel Radar panel + user-managed empty-start term list (Task 7) ✓; env-tunable config with all six fields (Task 2) ✓; one-time post-deploy seed, not hardcoded (Task 8) ✓; TDD test list — `normalizeSearchReel`, `radarConfig`, `selectWatchTerms`/`dedupeReels`/`selectRollupAuthors`/`passesFloors`, `watch_terms` insert contract, `runRadar` re-entrancy (Tasks 1–4) ✓; integration/harvest verified by manual prod run (Task 8) ✓.
- **Out-of-scope respected:** no `radar_reels` table, no reel-browser, no `/radar/reels*` routes, no auto-seed-from-hashtags, no follower cap, no multi-actor fallback (env-swap only). ✓
- **Type consistency:** the normalized reel shape (`shortcode`, `ownerUsername`, `viewCount`, `postedAt`, `term`) is used identically by `passesFloors`, `dedupeReels`, `excludeAuthors`, `selectRollupAuthors`, and `runRadar`. `radarConfig` field names (`authorsMax`, `minViews`, `maxAgeDays`, `actorId`, `maxPages`, `termsPerCycle`) match every consumer. Route/`api.js`/handler names align (`triggerRadar` → `POST /radar/run`; `addRadarTerm` → `POST /radar/terms`).
- **Deviation from spec, noted:** the spec's route list mentioned `getRadarStatus()`/`radarState` "for the status endpoint" but did not enumerate a `GET /radar/status` route; the frontend mirrors Run Discovery (polls list growth), so no status route is added. `getRadarStatus()` is still used by `POST /radar/run` for the re-entrancy guard.
