# Reel Radar — Content-First Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a content-first discovery source that harvests top reels from niche hashtags, scores them by breakout magnitude (views ÷ author median), surfaces the reels in a new Radar tab, and rolls repeat-breakout authors into the existing Suggested tab.

**Architecture:** A new `server/radar.js` module (pure helpers + an Apify-backed pipeline) mirrors the existing `scraper.js`/`scheduler.js` patterns. Every Apify call routes through the existing `InstagramScraper._startApifyRun` (ledgered + budget-gated). Two new additive tables (`watch_terms`, `radar_reels`); `suggested_accounts` is reused for the author rollup with the same accumulation-upsert semantics as Thrust 3 discovery. Frontend adds a `RadarTab` reusing `ContentCard`/`BulkActionBar`.

**Tech Stack:** Node/Express (CommonJS), dual-mode DB (`pg` prod / `better-sqlite3` dev+test), `node-cron`, `node:test`; React + Tailwind + Axios client (no JS unit-test runner — frontend gate is `npm run build` clean + browser smoke).

## Global Constraints

- **Backend test runner:** `node --test` from `server/` (`npm test`). Pure helpers exported from `server/radar.js`. DB-semantics tests use `new Database(':memory:')` with SQLite DDL (match `cadence-recording.test.js`).
- **Frontend gate:** `cd client && npm run build` must compile clean; verify each UI task with a browser smoke (no client unit tests exist).
- **Timestamps:** use the DB's `NOW_DEFAULT` / `isoNoMillis` ISO-8601-no-millis format. Never introduce a different format (lexicographic comparisons depend on it).
- **Additive schema only:** add `watch_terms` + `radar_reels`; do NOT alter existing table shapes. New `CREATE TABLE IF NOT EXISTS` blocks go in `db.js#initDB`.
- **Apify:** actor `apify~instagram-scraper` (`GENERIC_ACTOR_ID`), always via `scraper._startApifyRun(actorId, input, {purpose, query})` → `scraper._waitForRun(run.id, maxPolls)`. `purpose:'radar'` for harvest, `'radar-enrich'` for author fetch. Reuse `extractViews` (scraper export) for views and `median` (engagement-metrics export) for the author median.
- **Budget:** never bypass the gate; `runRadar` stops launching new term-runs when `_startApifyRun` throws `BudgetExceededError` (catch, log `[Metric] radar_budget_stop`, return partial).
- **Config defaults (verbatim):** `RADAR_TERMS_PER_CYCLE=10`, `RADAR_RESULTS_PER_TERM=50`, `RADAR_AUTHORS_ENRICH_MAX=20`, `RADAR_MIN_VIEWS=50000`, `RADAR_MIN_LIKES=1000`, `RADAR_MAX_AGE_DAYS=14`, `RADAR_VIEW_FLOOR=1000`, `RADAR_BREAKOUT_CAP=50`, `RADAR_ROLLUP_MIN_BREAKOUTS=2`, `RADAR_ROLLUP_SOLO_BREAKOUT=10`, `RADAR_W_BREAKOUT=0.7`, `RADAR_W_NICHE=0.3`.
- **FROZEN API CONTRACT (the backend↔frontend interface — both tracks code to this):**

```
GET  /radar/reels?term&min_breakout&since&status=new&limit=60&offset=0
  → { reels: [ { shortcode, account_handle, video_url, thumbnail_url, caption,
       like_count, comment_count, view_count, posted_at, post_url, discovered_via,
       author_followers, author_median_views, breakout_score, niche_fit_score,
       total_score, status, discovered_at } ], total }
POST /radar/reels/:shortcode/save     → { ok:true, post_id }
POST /radar/reels/:shortcode/dismiss  → { ok:true }
POST /radar/reels/bulk { shortcodes:[], action:'save'|'dismiss' } → { ok:true, updated }
GET  /radar/terms → { terms:[ { id, term, kind, source, status, last_run_at, reels_surfaced } ] }
POST /radar/terms { term, kind:'hashtag' } → { ok:true, id }     // pin → source='admin', status='active'
PATCH /radar/terms/:id { status:'active'|'excluded'|'paused' }   → { ok:true }
POST /radar/run → { ok:true, started:true } | { ok:true, started:false, reason:'already_running' }
```
- `breakout_score` is the multiplier the UI renders as “12× median”. `total_score` is the default sort key (DESC).

---

# Track A — Backend (`server/`, `db.js`) — owner: Claude

### Task A1: Schema — `watch_terms` + `radar_reels`

**Files:**
- Modify: `server/db.js` (add two `CREATE TABLE` blocks inside `initDB`, after the `apify_runs` block ~line 265)
- Test: `server/radar.test.js` (create)

**Interfaces:**
- Produces: tables `watch_terms(id, term, kind, source, status, model_id, added_at, last_run_at, notes)` UNIQUE(term,kind); `radar_reels(id, shortcode UNIQUE, account_handle, video_url, thumbnail_url, caption, like_count, comment_count, view_count, posted_at, post_url, discovered_via, author_followers, author_median_views, breakout_score, niche_fit_score, total_score, status, discovered_at)`.

- [ ] **Step 1: Write the failing test** — `server/radar.test.js`

```js
const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');

// Mirror of the SQLite DDL initDB will create (asserts the shape is creatable & insertable).
function makeSchema(db) {
  db.exec(`CREATE TABLE watch_terms (
    id INTEGER PRIMARY KEY AUTOINCREMENT, term TEXT, kind TEXT, source TEXT,
    status TEXT DEFAULT 'active', model_id INTEGER DEFAULT NULL,
    added_at TEXT, last_run_at TEXT DEFAULT NULL, notes TEXT DEFAULT '',
    UNIQUE(term, kind))`);
  db.exec(`CREATE TABLE radar_reels (
    id INTEGER PRIMARY KEY AUTOINCREMENT, shortcode TEXT UNIQUE NOT NULL, account_handle TEXT,
    video_url TEXT, thumbnail_url TEXT, caption TEXT,
    like_count INTEGER, comment_count INTEGER, view_count INTEGER,
    posted_at TEXT, post_url TEXT, discovered_via TEXT,
    author_followers INTEGER DEFAULT NULL, author_median_views INTEGER DEFAULT NULL,
    breakout_score REAL DEFAULT 0, niche_fit_score REAL DEFAULT 0, total_score REAL DEFAULT 0,
    status TEXT DEFAULT 'new', discovered_at TEXT)`);
}

test('schema: watch_terms enforces UNIQUE(term,kind) and radar_reels UNIQUE(shortcode)', () => {
  const db = new Database(':memory:');
  makeSchema(db);
  db.prepare("INSERT INTO watch_terms (term,kind,source) VALUES ('fitgirl','hashtag','auto')").run();
  assert.throws(() => db.prepare("INSERT INTO watch_terms (term,kind,source) VALUES ('fitgirl','hashtag','admin')").run());
  db.prepare("INSERT INTO radar_reels (shortcode,account_handle) VALUES ('ABC','x')").run();
  assert.throws(() => db.prepare("INSERT INTO radar_reels (shortcode,account_handle) VALUES ('ABC','y')").run());
});
```

- [ ] **Step 2: Run test to verify it passes** (this test validates the DDL shape directly)

Run: `cd server && node --test radar.test.js`
Expected: PASS (1 test). If it fails, fix the DDL in the test until the shape is valid, then mirror it exactly into `db.js`.

- [ ] **Step 3: Add the tables to `db.js#initDB`** — insert after the `apify_runs` block (~line 265), using `${SERIAL}` / `${NOW_DEFAULT}`:

```js
  await db.query(`
    CREATE TABLE IF NOT EXISTS watch_terms (
      id ${SERIAL},
      term TEXT NOT NULL,
      kind TEXT DEFAULT 'hashtag',
      source TEXT DEFAULT 'auto',
      status TEXT DEFAULT 'active',
      model_id INTEGER DEFAULT NULL,
      added_at TEXT DEFAULT ${NOW_DEFAULT},
      last_run_at TEXT DEFAULT NULL,
      notes TEXT DEFAULT '',
      UNIQUE(term, kind)
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS radar_reels (
      id ${SERIAL},
      shortcode TEXT UNIQUE NOT NULL,
      account_handle TEXT,
      video_url TEXT,
      thumbnail_url TEXT,
      caption TEXT,
      like_count INTEGER DEFAULT 0,
      comment_count INTEGER DEFAULT 0,
      view_count INTEGER,
      posted_at TEXT,
      post_url TEXT,
      discovered_via TEXT,
      author_followers INTEGER DEFAULT NULL,
      author_median_views INTEGER DEFAULT NULL,
      breakout_score REAL DEFAULT 0,
      niche_fit_score REAL DEFAULT 0,
      total_score REAL DEFAULT 0,
      status TEXT DEFAULT 'new',
      discovered_at TEXT DEFAULT ${NOW_DEFAULT}
    )
  `);
```

- [ ] **Step 4: Boot once to confirm `initDB` runs clean**

Run: `cd server && node -e "require('./db').initDB().then(()=>{console.log('OK');process.exit(0)})"`
Expected: prints `Database initialized (SQLite)` then `OK`, no error.

- [ ] **Step 5: Commit**

```bash
git add server/db.js server/radar.test.js
git commit -m "feat(radar): add watch_terms + radar_reels schema"
```

---

### Task A2: `radarConfig` + `selectWatchTerms`

**Files:**
- Create: `server/radar.js`
- Test: `server/radar.test.js` (append)

**Interfaces:**
- Produces: `radarConfig(env) → {termsPerCycle, resultsPerTerm, authorsEnrichMax, minViews, minLikes, maxAgeDays, viewFloor, breakoutCap, rollupMinBreakouts, rollupSoloBreakout, wBreakout, wNiche}`; `selectWatchTerms(terms, max) → term[]` — keep `status==='active'`, drop any whose `term` has an `excluded` twin (any kind), order by `last_run_at ASC` (NULL first), tie-break `term ASC`, take `max`.

- [ ] **Step 1: Write the failing test**

```js
const radar = require('./radar');

test('radarConfig: defaults and env override', () => {
  const d = radar.radarConfig({});
  assert.strictEqual(d.termsPerCycle, 10);
  assert.strictEqual(d.minViews, 50000);
  assert.strictEqual(d.wBreakout, 0.7);
  const o = radar.radarConfig({ RADAR_TERMS_PER_CYCLE: '3', RADAR_MIN_VIEWS: '1000' });
  assert.strictEqual(o.termsPerCycle, 3);
  assert.strictEqual(o.minViews, 1000);
});

test('selectWatchTerms: active only, excluded suppresses twin, NULL-first ordering, cap', () => {
  const terms = [
    { id: 1, term: 'a', kind: 'hashtag', status: 'active',  last_run_at: '2026-06-01T00:00:00Z' },
    { id: 2, term: 'b', kind: 'hashtag', status: 'active',  last_run_at: null },
    { id: 3, term: 'c', kind: 'hashtag', status: 'paused',  last_run_at: null },
    { id: 4, term: 'd', kind: 'hashtag', status: 'active',  last_run_at: '2026-05-01T00:00:00Z' },
    { id: 5, term: 'd', kind: 'hashtag', status: 'excluded',last_run_at: null }, // excludes term 'd'
  ];
  const out = radar.selectWatchTerms(terms, 10).map(t => t.term);
  assert.deepStrictEqual(out, ['b', 'a']);
});
```
> Expected `['b','a']`: `b` first (NULL `last_run_at` sorts first), then `a`; `c` dropped (paused), `d` dropped (its `excluded` twin suppresses it).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test radar.test.js`
Expected: FAIL — `Cannot find module './radar'`.

- [ ] **Step 3: Write minimal implementation** — `server/radar.js`

```js
const pool = require('./db');
const { median } = require('./engagement-metrics');

function radarConfig(env = process.env) {
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
  return {
    termsPerCycle: Math.floor(num(env.RADAR_TERMS_PER_CYCLE, 10)),
    resultsPerTerm: Math.floor(num(env.RADAR_RESULTS_PER_TERM, 50)),
    authorsEnrichMax: Math.floor(num(env.RADAR_AUTHORS_ENRICH_MAX, 20)),
    minViews: num(env.RADAR_MIN_VIEWS, 50000),
    minLikes: num(env.RADAR_MIN_LIKES, 1000),
    maxAgeDays: num(env.RADAR_MAX_AGE_DAYS, 14),
    viewFloor: num(env.RADAR_VIEW_FLOOR, 1000),
    breakoutCap: num(env.RADAR_BREAKOUT_CAP, 50),
    rollupMinBreakouts: Math.floor(num(env.RADAR_ROLLUP_MIN_BREAKOUTS, 2)),
    rollupSoloBreakout: num(env.RADAR_ROLLUP_SOLO_BREAKOUT, 10),
    wBreakout: num(env.RADAR_W_BREAKOUT, 0.7),
    wNiche: num(env.RADAR_W_NICHE, 0.3),
  };
}

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

module.exports = { radarConfig, selectWatchTerms };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test radar.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/radar.js server/radar.test.js
git commit -m "feat(radar): radarConfig + selectWatchTerms helper"
```

---

### Task A3: `passesFloors` + dedup helpers

**Files:** Modify `server/radar.js`; Test `server/radar.test.js` (append)

**Interfaces:**
- Produces: `passesFloors(reel, cfg, nowMs) → bool` (view_count ≥ minViews AND like_count ≥ minLikes AND age ≤ maxAgeDays); `dedupeReels(reels, {knownShortcodes:Set}) → reel[]` (drop known shortcodes + intra-batch dupes); `excludeAuthors(reels, {blockedHandles:Set}) → reel[]`.
- Consumes: `radarConfig` (A2).

- [ ] **Step 1: Write the failing test**

```js
test('passesFloors: views/likes/age boundaries', () => {
  const cfg = radar.radarConfig({});
  const now = Date.parse('2026-06-30T00:00:00Z');
  const ok = { view_count: 60000, like_count: 2000, posted_at: '2026-06-25T00:00:00Z' };
  assert.strictEqual(radar.passesFloors(ok, cfg, now), true);
  assert.strictEqual(radar.passesFloors({ ...ok, view_count: 40000 }, cfg, now), false);
  assert.strictEqual(radar.passesFloors({ ...ok, like_count: 10 }, cfg, now), false);
  assert.strictEqual(radar.passesFloors({ ...ok, posted_at: '2026-01-01T00:00:00Z' }, cfg, now), false);
  assert.strictEqual(radar.passesFloors({ ...ok, view_count: null }, cfg, now), false);
});

test('dedupeReels / excludeAuthors', () => {
  const reels = [
    { shortcode: 'A', account_handle: 'x' },
    { shortcode: 'A', account_handle: 'x' },
    { shortcode: 'B', account_handle: 'y' },
    { shortcode: 'C', account_handle: 'z' },
  ];
  const d = radar.dedupeReels(reels, { knownShortcodes: new Set(['C']) });
  assert.deepStrictEqual(d.map(r => r.shortcode), ['A', 'B']);
  const e = radar.excludeAuthors(d, { blockedHandles: new Set(['x']) });
  assert.deepStrictEqual(e.map(r => r.shortcode), ['B']);
});
```

- [ ] **Step 2: Run to verify it fails** — `cd server && node --test radar.test.js` → FAIL (`passesFloors is not a function`).

- [ ] **Step 3: Implement** (add to `radar.js`, export them):

```js
function passesFloors(reel, cfg, nowMs = Date.now()) {
  const v = Number(reel.view_count);
  const l = Number(reel.like_count) || 0;
  if (!Number.isFinite(v) || v < cfg.minViews) return false;
  if (l < cfg.minLikes) return false;
  const t = reel.posted_at ? Date.parse(reel.posted_at) : NaN;
  if (!Number.isFinite(t)) return false;
  const ageDays = (nowMs - t) / (24 * 60 * 60 * 1000);
  return ageDays <= cfg.maxAgeDays;
}

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

function excludeAuthors(reels, { blockedHandles = new Set() } = {}) {
  return (reels || []).filter(r => !blockedHandles.has((r.account_handle || '').toLowerCase()));
}
```
Add `passesFloors, dedupeReels, excludeAuthors` to `module.exports`.

- [ ] **Step 4: Run to verify it passes** — `cd server && node --test radar.test.js` → PASS.

- [ ] **Step 5: Commit**

```bash
git add server/radar.js server/radar.test.js
git commit -m "feat(radar): passesFloors + dedup/exclude helpers"
```

---

### Task A4: `scoreReel` (breakout + niche-fit blend)

**Files:** Modify `server/radar.js`; Test append.

**Interfaces:**
- Produces: `scoreReel(reel, author, cfg) → {breakout_score, niche_fit_score, total_score}`. `author` is `{median_views}` (or null/`{median_views:0}` when unknown). breakout = `min(views ÷ denom, breakoutCap)` where `denom = median_views>0 ? max(median_views, viewFloor) : minViews`; niche_fit = `1` baseline (term-matched) + `0.1 × min(hashtagOverlap,5)`; total = `wBreakout×breakout + wNiche×niche_fit`, all rounded to 2dp.
- Consumes: `radarConfig` (A2).

- [ ] **Step 1: Write the failing test**

```js
test('scoreReel: breakout vs known median, cap, unknown-median fallback', () => {
  const cfg = radar.radarConfig({});
  const known = radar.scoreReel({ view_count: 500000, _hashtagOverlap: 0 }, { median_views: 50000 }, cfg);
  assert.strictEqual(known.breakout_score, 10);      // 500k / 50k
  const capped = radar.scoreReel({ view_count: 999000000 }, { median_views: 1000 }, cfg);
  assert.strictEqual(capped.breakout_score, 50);     // breakoutCap
  const unknown = radar.scoreReel({ view_count: 50000 }, null, cfg);
  assert.strictEqual(unknown.breakout_score, 1);     // 50k / minViews(50k)
  assert.ok(known.total_score > unknown.total_score);
});

test('scoreReel: niche overlap raises niche_fit', () => {
  const cfg = radar.radarConfig({});
  const a = radar.scoreReel({ view_count: 50000, _hashtagOverlap: 0 }, null, cfg).niche_fit_score;
  const b = radar.scoreReel({ view_count: 50000, _hashtagOverlap: 3 }, null, cfg).niche_fit_score;
  assert.ok(b > a);
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL (`scoreReel is not a function`).

- [ ] **Step 3: Implement**

```js
const round2 = (n) => Math.round(n * 100) / 100;

function scoreReel(reel, author, cfg) {
  const views = Number(reel.view_count) || 0;
  const med = author && Number(author.median_views) > 0 ? Number(author.median_views) : 0;
  const denom = med > 0 ? Math.max(med, cfg.viewFloor) : cfg.minViews;
  const breakout = Math.min(views / denom, cfg.breakoutCap);
  const overlap = Math.min(Number(reel._hashtagOverlap) || 0, 5);
  const nicheFit = 1 + 0.1 * overlap;
  const total = cfg.wBreakout * breakout + cfg.wNiche * nicheFit;
  return { breakout_score: round2(breakout), niche_fit_score: round2(nicheFit), total_score: round2(total) };
}
```
Export `scoreReel`.

- [ ] **Step 4: Run to verify it passes** — PASS.

- [ ] **Step 5: Commit**

```bash
git add server/radar.js server/radar.test.js
git commit -m "feat(radar): scoreReel breakout + niche-fit blend"
```

---

### Task A5: Hashtag harvest (feasibility spike + `normalizeHashtagItem` + `harvestHashtag`)

**Files:** Modify `server/radar.js`; Test append.

**Interfaces:**
- Produces: `normalizeHashtagItem(item, term) → reel|null` (maps an Apify post item → the `radar_reels` reel shape; returns null for non-video); `harvestHashtag(scraper, term, cfg) → reel[]` (one Apify run via `scraper._startApifyRun`/`_waitForRun`, mapped + video-filtered).
- Consumes: `scraper._startApifyRun`, `scraper._waitForRun`, `extractViews` (scraper export).

- [ ] **Step 1: FEASIBILITY SPIKE (R-1/R-2) — run before writing harvest. No commit.**

Run (needs a real `APIFY_API_KEY` in env):
```bash
cd server && APIFY_API_KEY=<key> node -e '
const S = require("./scraper");
const s = new S(process.env.APIFY_API_KEY);
s._startApifyRun("apify~instagram-scraper",
  { directUrls:["https://www.instagram.com/explore/tags/fitness/"], resultsType:"posts", resultsLimit:5 },
  { purpose:"radar", query:"#fitness" })
 .then(r => s._waitForRun(r.id, 30))
 .then(items => { console.log("count", items && items.length);
   console.log(JSON.stringify((items||[])[0], null, 2).slice(0, 1200)); })
 .catch(e => { console.error("SPIKE FAIL", e.message); process.exit(1); });'
```
Confirm the first item exposes: `shortCode`, `ownerUsername`, `caption`, `likesCount`, `commentsCount`, a views field (`videoPlayCount`/`videoViewCount`), `type`/`productType`, `displayUrl`, `url`, `timestamp`.
- **If views are present** → proceed as written.
- **If `directUrls` to a tag page returns nothing** → switch the input to `{ search:'fitness', searchType:'hashtag', resultsType:'posts', resultsLimit }` and re-run the spike; use whichever returns items in `normalizeHashtagItem`/`harvestHashtag`.
- **If views are absent on hashtag items** → record it; v1 will drop view-less reels at `passesFloors` (acceptable). Note the R-2 likes-percentile fallback as a follow-up; do NOT build it now.

Write the confirmed input shape as a comment at the top of `harvestHashtag`.

- [ ] **Step 2: Write the failing test** (pure mapper, offline):

```js
const { extractViews } = require('./scraper');

test('normalizeHashtagItem: maps video item, drops non-video', () => {
  const item = {
    shortCode: 'XYZ', ownerUsername: 'Creator1', caption: 'leg day #fitness #gym',
    likesCount: 5000, commentsCount: 120, videoPlayCount: 300000,
    type: 'Video', displayUrl: 'https://cdn/x.jpg', url: 'https://instagram.com/reel/XYZ/',
    timestamp: '2026-06-20T12:00:00Z',
  };
  const r = radar.normalizeHashtagItem(item, 'fitness');
  assert.strictEqual(r.shortcode, 'XYZ');
  assert.strictEqual(r.account_handle, 'creator1');  // lowercased
  assert.strictEqual(r.view_count, 300000);
  assert.strictEqual(r.like_count, 5000);
  assert.strictEqual(r.discovered_via, 'fitness');
  assert.ok(Array.isArray(r._hashtags) && r._hashtags.includes('#fitness'));
  assert.strictEqual(radar.normalizeHashtagItem({ ...item, type: 'Image', productType: undefined }, 'fitness'), null);
});
```

- [ ] **Step 3: Run to verify it fails** — FAIL (`normalizeHashtagItem is not a function`).

- [ ] **Step 4: Implement**

```js
const { extractViews } = require('./scraper');
const GENERIC_ACTOR_ID = 'apify~instagram-scraper';

function normalizeHashtagItem(item, term) {
  if (!item) return null;
  const isVideo = item.type === 'Video' || item.productType === 'clips';
  if (!isVideo) return null;
  const shortcode = item.shortCode || item.shortcode;
  if (!shortcode) return null;
  const caption = item.caption || '';
  const hashtags = (caption.match(/#([a-zA-Z0-9_]+)/g) || []).map(h => h.toLowerCase());
  return {
    shortcode,
    account_handle: String(item.ownerUsername || '').toLowerCase(),
    video_url: item.videoUrl || item.url || null,
    thumbnail_url: item.displayUrl || item.thumbnailUrl || null,
    caption,
    like_count: Number(item.likesCount) || 0,
    comment_count: Number(item.commentsCount) || 0,
    view_count: extractViews(item),
    posted_at: item.timestamp || null,
    post_url: item.url || (shortcode ? `https://www.instagram.com/reel/${shortcode}/` : null),
    discovered_via: term,
    _hashtags: hashtags,
  };
}

// Apify hashtag input shape confirmed by the Task A5 spike (YYYY-MM-DD):
async function harvestHashtag(scraper, term, cfg) {
  const run = await scraper._startApifyRun(GENERIC_ACTOR_ID, {
    directUrls: [`https://www.instagram.com/explore/tags/${term}/`],
    resultsType: 'posts',
    resultsLimit: cfg.resultsPerTerm,
  }, { purpose: 'radar', query: `#${term}` });
  const items = await scraper._waitForRun(run.id, 30);
  if (!items) return [];
  return items.map(it => normalizeHashtagItem(it, term)).filter(Boolean);
}
```
Export `normalizeHashtagItem, harvestHashtag`.

- [ ] **Step 5: Run to verify it passes** — `cd server && node --test radar.test.js` → PASS.

- [ ] **Step 6: Commit**

```bash
git add server/radar.js server/radar.test.js
git commit -m "feat(radar): hashtag harvest + item normalizer (spike-verified input)"
```

---

### Task A6: Author enrichment (`authorMedianFromReels` + `enrichAuthors`)

**Files:** Modify `server/radar.js`; Test append.

**Interfaces:**
- Produces: `authorMedianFromReels(reelViews[]) → number|null` (reuses `median`); `enrichAuthors(scraper, handles, cfg) → Map<handle,{median_views, followers}>` — for ≤ `authorsEnrichMax` handles, one `_fetchProfileQuick`-style run each to read recent reels' views; pure median via `median()`.
- Consumes: `median` (engagement-metrics), `scraper._startApifyRun/_waitForRun`, `extractViews`.

- [ ] **Step 1: Write the failing test** (pure median helper):

```js
test('authorMedianFromReels: median of positive view counts', () => {
  assert.strictEqual(radar.authorMedianFromReels([100, 300, 200]), 200);
  assert.strictEqual(radar.authorMedianFromReels([100, 300]), 200);
  assert.strictEqual(radar.authorMedianFromReels([]), null);
  assert.strictEqual(radar.authorMedianFromReels([0, -5, null]), null);
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL.

- [ ] **Step 3: Implement**

```js
function authorMedianFromReels(views) {
  return median(views || []);
}

// One Apify "details" run per author (capped) → median of recent reel views.
async function enrichAuthors(scraper, handles, cfg) {
  const out = new Map();
  const unique = [...new Set((handles || []).filter(Boolean))].slice(0, cfg.authorsEnrichMax);
  for (const handle of unique) {
    try {
      const run = await scraper._startApifyRun(GENERIC_ACTOR_ID, {
        directUrls: [`https://www.instagram.com/${handle}/`],
        resultsType: 'details', resultsLimit: 1,
      }, { purpose: 'radar-enrich', query: handle });
      const items = await scraper._waitForRun(run.id, 12);
      const profile = items && items[0];
      if (!profile) { out.set(handle, { median_views: null, followers: 0 }); continue; }
      const followers = profile.followersCount || profile.followedByCount || 0;
      const views = (profile.latestPosts || [])
        .filter(p => p.type === 'Video' || p.productType === 'clips')
        .map(p => extractViews(p)).filter(v => Number.isFinite(v));
      out.set(handle, { median_views: authorMedianFromReels(views), followers });
    } catch (e) {
      if (e && e.name === 'BudgetExceededError') throw e;
      out.set(handle, { median_views: null, followers: 0 });
    }
  }
  return out;
}
```
Export `authorMedianFromReels, enrichAuthors`.

- [ ] **Step 4: Run to verify it passes** — PASS.

- [ ] **Step 5: Commit**

```bash
git add server/radar.js server/radar.test.js
git commit -m "feat(radar): author enrichment + median-from-reels"
```

---

### Task A7: Author rollup into `suggested_accounts` (accumulation upsert)

**Files:** Modify `server/radar.js`; Test append.

**Interfaces:**
- Produces: `selectRolloupAuthors(scoredReels, cfg) → [{username, bestBreakout, count, reason}]` (authors with `count ≥ rollupMinBreakouts` OR any `breakout ≥ rollupSoloBreakout`); `rollupAuthors(pool, authors)` writes to `suggested_accounts` (`source='radar:<term>'`) via the Thrust-3 accumulation upsert (insert `DO NOTHING`; bump pending rows: `suggestion_score=MAX`, merge source token, refresh reason — never demote/resurrect reviewed rows).
- Consumes: scored reels from A4.

- [ ] **Step 1: Write the failing test** (selection pure + accumulation SQL on `:memory:`):

```js
test('selectRolloupAuthors: threshold + solo-breakout', () => {
  const cfg = radar.radarConfig({});
  const scored = [
    { account_handle: 'a', breakout_score: 3, discovered_via: 'x' },
    { account_handle: 'a', breakout_score: 4, discovered_via: 'x' }, // count 2 → in
    { account_handle: 'b', breakout_score: 12, discovered_via: 'y' }, // solo ≥10 → in
    { account_handle: 'c', breakout_score: 3, discovered_via: 'z' },  // count 1, <10 → out
  ];
  const out = radar.selectRolloupAuthors(scored, cfg).map(a => a.username).sort();
  assert.deepStrictEqual(out, ['a', 'b']);
});

test('accumulation upsert: bump pending, never demote reviewed (sqlite)', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE suggested_accounts (username TEXT UNIQUE, source TEXT, suggestion_score REAL DEFAULT 0,
           relevance_reason TEXT DEFAULT '', status TEXT DEFAULT 'pending')`);
  db.prepare("INSERT INTO suggested_accounts (username,source,suggestion_score,status) VALUES ('a','radar:x',5,'pending')").run();
  db.prepare("INSERT INTO suggested_accounts (username,source,suggestion_score,status) VALUES ('b','radar:x',5,'dismissed')").run();
  const bump = db.prepare(`UPDATE suggested_accounts
     SET suggestion_score = CASE WHEN ? > suggestion_score THEN ? ELSE suggestion_score END,
         source = CASE WHEN (','||source||',') LIKE ('%,'||?||',%') THEN source ELSE source||','||? END,
         relevance_reason = ?
     WHERE username = ? AND status = 'pending'`);
  bump.run(9, 9, 'radar:y', 'radar:y', 'reason', 'a');
  bump.run(9, 9, 'radar:y', 'radar:y', 'reason', 'b');
  const a = db.prepare("SELECT * FROM suggested_accounts WHERE username='a'").get();
  const b = db.prepare("SELECT * FROM suggested_accounts WHERE username='b'").get();
  assert.strictEqual(a.suggestion_score, 9);
  assert.strictEqual(a.source, 'radar:x,radar:y');
  assert.strictEqual(b.suggestion_score, 5); // reviewed row untouched
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL (`selectRolloupAuthors is not a function`).

- [ ] **Step 3: Implement** — `selectRolloupAuthors` pure + `rollupAuthors(pool, authors)` using the exact dual-mode-safe upsert (placeholders once, ascending order — see `scheduler.js#runDiscovery`). Insert with `ON CONFLICT (username) DO NOTHING`, then the pending-bump UPDATE shown above. `suggestion_score = round2(bestBreakout)`, `source = 'radar:' + discovered_via`, `reason = '<count> breakout reels via #<term> (best <bestBreakout>× median)'`.

```js
function selectRolloupAuthors(scoredReels, cfg) {
  const byAuthor = new Map();
  for (const r of scoredReels || []) {
    const h = (r.account_handle || '').toLowerCase();
    if (!h) continue;
    const cur = byAuthor.get(h) || { username: h, count: 0, bestBreakout: 0, term: r.discovered_via };
    cur.count += 1;
    if (r.breakout_score > cur.bestBreakout) { cur.bestBreakout = r.breakout_score; cur.term = r.discovered_via; }
    byAuthor.set(h, cur);
  }
  return [...byAuthor.values()].filter(a =>
    a.count >= cfg.rollupMinBreakouts || a.bestBreakout >= cfg.rollupSoloBreakout
  ).map(a => ({
    username: a.username, bestBreakout: a.bestBreakout, count: a.count,
    source: `radar:${a.term}`,
    reason: `${a.count} breakout reel${a.count > 1 ? 's' : ''} via #${a.term} (best ${a.bestBreakout}× median)`,
  }));
}

async function rollupAuthors(pool, authors) {
  let added = 0, bumped = 0;
  for (const a of authors || []) {
    try {
      const ins = await pool.query(
        `INSERT INTO suggested_accounts (username, source, relevance_reason, suggestion_score, gender)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (username) DO NOTHING`,
        [a.username, a.source, a.reason, a.bestBreakout, 'unknown']);
      if (ins.rowCount > 0) { added++; continue; }
      const upd = await pool.query(
        `UPDATE suggested_accounts
           SET suggestion_score = CASE WHEN $1 > suggestion_score THEN $2 ELSE suggestion_score END,
               source = CASE WHEN (',' || source || ',') LIKE ('%,' || $3 || ',%') THEN source ELSE source || ',' || $4 END,
               relevance_reason = $5
         WHERE username = $6 AND status = 'pending'`,
        [a.bestBreakout, a.bestBreakout, a.source, a.source, a.reason, a.username]);
      if (upd.rowCount > 0) bumped++;
    } catch (e) { console.error(`[Radar] rollup failed for @${a.username}:`, e.message); }
  }
  return { added, bumped };
}
```
> Gender note: rollup inserts `gender:'unknown'` (parks at read time, consistent with discovery). A later task may gender-classify; not required for v1.
Export `selectRolloupAuthors, rollupAuthors`.

- [ ] **Step 4: Run to verify it passes** — PASS.

- [ ] **Step 5: Commit**

```bash
git add server/radar.js server/radar.test.js
git commit -m "feat(radar): author rollup into suggested_accounts (accumulation upsert)"
```

---

### Task A8: `runRadar` orchestration + cron registration

**Files:** Modify `server/radar.js` (add `runRadar`, `radarState`); Modify `server/scheduler.js` (register cron + pass to it); Test append.

**Interfaces:**
- Produces: `runRadar(scraper, { env } = {}) → {terms, harvested, survivors, enriched, reels, authors, started}`; `radarState` `{running, lastRun, message}`; `getRadarStatus()`.
- Consumes: A2–A7 helpers; reads/writes `watch_terms`, `radar_reels`, `posts`, `tracked_accounts`, `suggested_accounts` via `pool`.

- [ ] **Step 1: Write the failing test** (orchestration with an injected fake scraper + `:memory:`-backed fake pool is heavy; instead unit-test the guard + the persisted-reel mapper). Add:

```js
test('runRadar: re-entrancy guard returns started:false when already running', async () => {
  radar.__setRunning(true);
  const res = await radar.runRadar({ /* scraper unused when guarded */ });
  assert.strictEqual(res.started, false);
  assert.strictEqual(res.reason, 'already_running');
  radar.__setRunning(false);
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL (`__setRunning is not a function`).

- [ ] **Step 3: Implement `runRadar`** in `radar.js` (re-entrancy guard first; then the pipeline). Pseudocode→real:

```js
const radarState = { running: false, lastRun: null, message: '' };
function __setRunning(v) { radarState.running = v; }       // test hook
function getRadarStatus() { return radarState; }

async function runRadar(scraper, { env = process.env } = {}) {
  if (radarState.running) return { started: false, reason: 'already_running' };
  if (!scraper || !scraper.apiKey) return { started: false, reason: 'no_api_key' };
  radarState.running = true; radarState.lastRun = new Date().toISOString();
  const cfg = radarConfig(env);
  const now = Date.now();
  const stats = { terms: 0, harvested: 0, survivors: 0, enriched: 0, reels: 0, authors: 0, started: true };
  try {
    const termsRes = await pool.query("SELECT id, term, kind, source, status, last_run_at FROM watch_terms");
    const chosen = selectWatchTerms(termsRes.rows, cfg.termsPerCycle);
    stats.terms = chosen.length;

    // dedup context
    const known = new Set();
    for (const t of ['posts', 'radar_reels']) {
      const r = await pool.query(`SELECT shortcode FROM ${t}`);
      r.rows.forEach(x => known.add(x.shortcode));
    }
    const trackedRes = await pool.query("SELECT username FROM tracked_accounts");
    const reviewedRes = await pool.query("SELECT username FROM suggested_accounts WHERE status IN ('approved','dismissed')");
    const blocked = new Set([...trackedRes.rows, ...reviewedRes.rows].map(x => x.username.toLowerCase()));

    let allScored = [];
    for (const term of chosen) {
      let harvested = [];
      try { harvested = await harvestHashtag(scraper, term.term, cfg); }
      catch (e) { if (e.name === 'BudgetExceededError') { console.log(`[Metric] radar_budget_stop term=${term.term}`); break; }
                  console.error(`[Radar] harvest failed for #${term.term}:`, e.message); }
      stats.harvested += harvested.length;
      // stamp last_run_at best-effort
      try { await pool.query(`UPDATE watch_terms SET last_run_at = TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') WHERE id = $1`, [term.id]); } catch (e) {}

      let survivors = harvested.filter(r => passesFloors(r, cfg, now));
      survivors = excludeAuthors(dedupeReels(survivors, { knownShortcodes: known }), { blockedHandles: blocked });
      survivors.forEach(r => known.add(r.shortcode)); // avoid intra-cycle dupes across terms
      stats.survivors += survivors.length;
      if (survivors.length === 0) continue;

      const authorsMap = await enrichAuthors(scraper, survivors.map(r => r.account_handle), cfg);
      stats.enriched += authorsMap.size;
      for (const r of survivors) {
        const author = authorsMap.get(r.account_handle) || null;
        r._hashtagOverlap = (r._hashtags || []).filter(h => h !== `#${term.term}`).length;
        const s = scoreReel(r, author, cfg);
        Object.assign(r, s, {
          author_followers: author ? author.followers : null,
          author_median_views: author ? author.median_views : null,
        });
        await persistRadarReel(pool, r);
        stats.reels++;
        allScored.push(r);
      }
    }
    const rollup = selectRolloupAuthors(allScored, cfg);
    const { added, bumped } = await rollupAuthors(pool, rollup);
    stats.authors = added + bumped;
    console.log(`[Metric] radar terms=${stats.terms} harvested=${stats.harvested} survivors=${stats.survivors} reels=${stats.reels} authors=${stats.authors}`);
    radarState.message = `Reels ${stats.reels}, authors +${added}/~${bumped}`;
  } catch (err) {
    radarState.message = err.message; console.error('[Radar] run failed:', err.message);
  } finally { radarState.running = false; }
  return stats;
}

async function persistRadarReel(pool, r) {
  await pool.query(
    `INSERT INTO radar_reels (shortcode, account_handle, video_url, thumbnail_url, caption,
       like_count, comment_count, view_count, posted_at, post_url, discovered_via,
       author_followers, author_median_views, breakout_score, niche_fit_score, total_score)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (shortcode) DO UPDATE SET breakout_score=$14, niche_fit_score=$15, total_score=$16,
       author_median_views=$13, author_followers=$12`,
    [r.shortcode, r.account_handle, r.video_url, r.thumbnail_url, r.caption,
     r.like_count, r.comment_count, r.view_count, r.posted_at, r.post_url, r.discovered_via,
     r.author_followers, r.author_median_views, r.breakout_score, r.niche_fit_score, r.total_score]);
}
```
> ⚠ The `persistRadarReel` `DO UPDATE` reuses `$12..$16` out of ascending order, which breaks the SQLite positional shim. **Write two variants** like the codebase does elsewhere, OR (simpler) for v1 keep `ON CONFLICT (shortcode) DO NOTHING` (re-discovered reels keep their first score) — choose `DO NOTHING` to stay dual-mode-safe and delete the SET clause. Update the test for persistence accordingly if you add one.
Export `runRadar, getRadarStatus, __setRunning, persistRadarReel`.

- [ ] **Step 4: Register the cron** in `server/scheduler.js#startScheduler` (after the discovery cron, line ~350):

```js
  const radar = require('./radar');
  cron.schedule('0 6 * * 1', () => radar.runRadar(scraper));
```
Add `radar` job to the `jobStatus` surface is optional; `getRadarStatus()` is separate.

- [ ] **Step 5: Run tests** — `cd server && node --test radar.test.js` → PASS (guard test). Then full suite: `cd server && npm test` → all pass (no regressions).

- [ ] **Step 6: Commit**

```bash
git add server/radar.js server/scheduler.js server/radar.test.js
git commit -m "feat(radar): runRadar orchestration + weekly cron"
```

---

### Task A9: Routes `/radar/*`

**Files:** Modify `server/index.js` (add `app.use('/radar', requireAuth)` near line 112 and the route handlers near the other feature routes; require `radar` + reuse `scraper`).

**Interfaces:**
- Consumes: `radar.runRadar`, `pool`, `scraper` (for save→thumbnail). Implements the FROZEN API CONTRACT verbatim.
- Produces: the HTTP endpoints the frontend (Track B) consumes.

- [ ] **Step 1: Add auth guard + requires**

```js
app.use('/radar', requireAuth);
const radar = require('./radar');
```

- [ ] **Step 2: Implement read + mutation routes** (match contract; reuse the existing `pool` and post-upsert/thumbnail helpers used by `/scrape`):

```js
app.get('/radar/reels', async (req, res) => {
  const { term, min_breakout, since, status = 'new', limit = 60, offset = 0 } = req.query;
  const where = ['status = $1']; const params = [status];
  if (term) { params.push(term); where.push(`discovered_via = $${params.length}`); }
  if (min_breakout) { params.push(Number(min_breakout)); where.push(`breakout_score >= $${params.length}`); }
  if (since) { params.push(since); where.push(`posted_at >= $${params.length}`); }
  params.push(Number(limit)); params.push(Number(offset));
  const rows = await pool.query(
    `SELECT * FROM radar_reels WHERE ${where.join(' AND ')} ORDER BY total_score DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  const count = await pool.query(`SELECT COUNT(*) AS n FROM radar_reels WHERE ${where.join(' AND ')}`, params.slice(0, -2));
  res.json({ reels: rows.rows, total: Number(count.rows[0].n) });
});

app.post('/radar/reels/:shortcode/dismiss', async (req, res) => {
  await pool.query(`UPDATE radar_reels SET status='dismissed' WHERE shortcode = $1`, [req.params.shortcode]);
  res.json({ ok: true });
});

app.post('/radar/reels/:shortcode/save', async (req, res) => {
  const r = (await pool.query(`SELECT * FROM radar_reels WHERE shortcode=$1`, [req.params.shortcode])).rows[0];
  if (!r) return res.status(404).json({ ok: false, error: 'not_found' });
  // promote into posts via the existing upsert path (reuse scraper's store helper or a direct ON CONFLICT insert):
  const ins = await pool.query(
    `INSERT INTO posts (shortcode, video_url, thumbnail_url, caption, like_count, comment_count, view_count, posted_at, account_handle, post_url, source_query)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (shortcode) DO UPDATE SET caption=$4 RETURNING id`,
    [r.shortcode, r.video_url, r.thumbnail_url, r.caption, r.like_count, r.comment_count, r.view_count, r.posted_at, r.account_handle, r.post_url, `radar:${r.discovered_via}`]);
  await pool.query(`UPDATE radar_reels SET status='saved' WHERE shortcode=$1`, [r.shortcode]);
  // best-effort thumbnail cache (reuse thumbnails.js as /scrape does):
  try { const { cacheThumbnail } = require('./thumbnails'); await cacheThumbnail(r.shortcode, r.thumbnail_url); } catch (e) {}
  res.json({ ok: true, post_id: ins.rows[0] && ins.rows[0].id });
});

app.post('/radar/reels/bulk', async (req, res) => {
  const { shortcodes = [], action } = req.body || {};
  if (!['save', 'dismiss'].includes(action)) return res.status(400).json({ ok: false, error: 'bad_action' });
  let updated = 0;
  for (const sc of shortcodes) {
    if (action === 'dismiss') { await pool.query(`UPDATE radar_reels SET status='dismissed' WHERE shortcode=$1`, [sc]); updated++; }
    else { await new Promise(r => r()); /* reuse the save handler logic via a shared fn */ }
  }
  res.json({ ok: true, updated });
});

app.get('/radar/terms', async (req, res) => {
  const rows = await pool.query(`SELECT id, term, kind, source, status, last_run_at,
    (SELECT COUNT(*) FROM radar_reels rr WHERE rr.discovered_via = wt.term) AS reels_surfaced
    FROM watch_terms wt ORDER BY status, term`);
  res.json({ terms: rows.rows });
});
app.post('/radar/terms', async (req, res) => {
  const { term, kind = 'hashtag' } = req.body || {};
  if (!term) return res.status(400).json({ ok: false, error: 'term_required' });
  const ins = await pool.query(
    `INSERT INTO watch_terms (term, kind, source, status) VALUES ($1,$2,'admin','active')
     ON CONFLICT (term, kind) DO UPDATE SET status='active', source='admin' RETURNING id`,
    [term.replace(/^#/, '').toLowerCase(), kind]);
  res.json({ ok: true, id: ins.rows[0] && ins.rows[0].id });
});
app.patch('/radar/terms/:id', async (req, res) => {
  const { status } = req.body || {};
  if (!['active', 'excluded', 'paused'].includes(status)) return res.status(400).json({ ok: false });
  await pool.query(`UPDATE watch_terms SET status=$1 WHERE id=$2`, [status, req.params.id]);
  res.json({ ok: true });
});

app.post('/radar/run', async (req, res) => {
  const result = await radar.runRadar(scraper);
  res.json({ ok: true, started: result.started !== false, reason: result.reason });
});
```
> Refactor the save logic into a shared `saveRadarReel(shortcode)` fn so `/save` and bulk-save reuse it (DRY). Strip `RETURNING id` reliance for sqlite (the shim returns `rows:[{id}]` from `lastInsertRowid`).

- [ ] **Step 3: Manual verification** (local, sqlite): seed a `radar_reels` row, boot the server, hit the endpoints:

```bash
cd server && node -e "require('./db').initDB().then(async()=>{const p=require('./db');
  await p.query(\"INSERT INTO radar_reels (shortcode,account_handle,view_count,breakout_score,total_score,status,discovered_via) VALUES ('T1','x',300000,8,6,'new','fitness')\");
  console.log('seeded');process.exit(0)})"
# then: node index.js  &  curl -s localhost:4000/radar/reels (after logging in / with auth disabled locally)
```
Expected: `GET /radar/reels` returns the seeded reel; `POST /radar/reels/T1/dismiss` flips status.

- [ ] **Step 4: Run full backend suite** — `cd server && npm test` → all pass.

- [ ] **Step 5: Commit**

```bash
git add server/index.js
git commit -m "feat(radar): /radar/* routes (reels, save/dismiss/bulk, terms, run)"
```

---

# Track B — Frontend (`client/`) — owner: Codex

> **No client unit-test runner exists.** Gate every task with `cd client && npm run build` (must compile clean) **and** a browser smoke against a running server (`npm start` from repo root). Reuse `components/ContentCard.js` and `components/BulkActionBar.js` — do not rebuild card/bulk UI. Code strictly to the FROZEN API CONTRACT in Global Constraints; do not assume fields beyond it.

### Task B1: API client methods + Radar tab registration

**Files:** Modify `client/src/api.js`; Modify `client/src/App.js`; Create `client/src/pages/RadarTab.js` (stub).

- [ ] **Step 1:** Add to `client/src/api.js`:

```js
// Radar
export const getRadarReels = (params) => api.get('/radar/reels', { params });
export const saveRadarReel = (sc) => api.post(`/radar/reels/${sc}/save`);
export const dismissRadarReel = (sc) => api.post(`/radar/reels/${sc}/dismiss`);
export const bulkRadarReels = (shortcodes, action) => api.post('/radar/reels/bulk', { shortcodes, action });
export const getWatchTerms = () => api.get('/radar/terms');
export const addWatchTerm = (term, kind = 'hashtag') => api.post('/radar/terms', { term, kind });
export const setWatchTermStatus = (id, status) => api.patch(`/radar/terms/${id}`, { status });
export const runRadar = () => api.post('/radar/run');
```

- [ ] **Step 2:** In `client/src/App.js` add `{ id: 'radar', label: 'Radar' }` to `TABS` and `{activeTab === 'radar' && <RadarTab />}` to the render block; import `RadarTab`.

- [ ] **Step 3:** Create `RadarTab.js` stub rendering `<div>Radar</div>` that calls `getRadarReels({status:'new'})` in `useEffect` and logs the count.

- [ ] **Step 4:** Gate — `cd client && npm run build` clean; browser smoke shows the Radar tab and a network call to `/radar/reels`.

- [ ] **Step 5:** Commit `git add client/src/api.js client/src/App.js client/src/pages/RadarTab.js && git commit -m "feat(radar-ui): api methods + Radar tab scaffold"`

### Task B2: Radar reels grid (reuse ContentCard)

**Files:** Modify `client/src/pages/RadarTab.js`.

- [ ] **Step 1:** Fetch `getRadarReels({ status:'new', limit:60 })`; render a grid of `ContentCard` for each reel. Pass the reel through ContentCard's existing props (image=`thumbnail_url`, caption, like/view counts, link=`post_url`). Show three Radar-specific overlays per card: an **"untracked"** badge, a **breakout pill** `` `${reel.breakout_score}× median` ``, and a muted `via #${reel.discovered_via}`.
- [ ] **Step 2:** Add filter controls (term dropdown from distinct `discovered_via`, a `min_breakout` number input) that re-query the API. Default sort is server-side (`total_score DESC`); no client sort needed.
- [ ] **Step 3:** Empty + loading states (reuse the Library loading pattern).
- [ ] **Step 4:** Gate — build clean + browser smoke renders seeded reels with badges.
- [ ] **Step 5:** Commit `feat(radar-ui): reels grid with breakout/untracked badges`.

### Task B3: Per-card actions + bulk select

**Files:** Modify `RadarTab.js`; reuse `components/BulkActionBar.js`.

- [ ] **Step 1:** Per card: **Save** (`saveRadarReel` → optimistic remove from feed), **Dismiss** (`dismissRadarReel` → remove), **Track author** (call `addTrackedAccount(reel.account_handle)` from existing api OR route through Suggested — use `addTrackedAccount`).
- [ ] **Step 2:** Multi-select with `BulkActionBar`: select reels → **Bulk Save** / **Bulk Dismiss** via `bulkRadarReels(shortcodes, action)`; clear selection + refetch on success.
- [ ] **Step 3:** Gate — build clean + browser smoke: save/dismiss/bulk update the feed and persist across refresh.
- [ ] **Step 4:** Commit `feat(radar-ui): save/dismiss/track + bulk actions`.

### Task B4: Watchlist panel

**Files:** Modify `RadarTab.js` (a collapsible panel) or create `client/src/components/WatchlistPanel.js`.

- [ ] **Step 1:** `getWatchTerms()` → table of `{term, kind, source, status, last_run_at, reels_surfaced}`. Show source (auto/admin) + reels-surfaced count so dead tags are visible.
- [ ] **Step 2:** Controls: add term (`addWatchTerm`), set status pin/exclude/pause (`setWatchTermStatus`), and a **Run Radar now** button (`runRadar()` → toast the `started`/`already_running` result).
- [ ] **Step 3:** Gate — build clean + browser smoke: add a term, exclude one, trigger a run.
- [ ] **Step 4:** Commit `feat(radar-ui): watchlist panel + run-now`.

### Task B5: Suggested radar label + filter

**Files:** Modify `client/src/pages/SuggestedAccountsTab.js`.

- [ ] **Step 1:** When a suggestion's `source` contains `radar:`, render a “Radar” chip + the `relevance_reason` text.
- [ ] **Step 2:** Add a "Radar-sourced" filter toggle that shows only suggestions whose `source` includes `radar:`.
- [ ] **Step 3:** Gate — build clean + browser smoke: radar-sourced suggestions show the chip + filter works.
- [ ] **Step 4:** Commit `feat(radar-ui): Suggested radar label + filter`.

---

## Self-Review (completed by author)

- **Spec coverage:** watch_terms+radar_reels (A1) ✓ · hybrid watchlist resolve/exclude (A2) ✓ · floors+dedup funnel stage 1 (A3) ✓ · breakout+niche scoring incl. unknown-median fallback (A4) ✓ · hashtag harvest + R-1/R-2 spike (A5) ✓ · survivor-only author enrichment / stage 2 (A6) ✓ · account rollup w/ Thrust-3 accumulation (A7) ✓ · orchestration + budget-stop + weekly cron + manual guard (A8) ✓ · routes incl. save-to-Library promote + thumbnail-on-save (A9) ✓ · Radar tab + badges + bulk + watchlist + Suggested label (B1–B5) ✓ · cost caps via config + `_startApifyRun` gate ✓.
- **Deferred (spec §2 non-goals), intentionally no task:** audio/keyword/related-profiles sources, per-model `model_id` wiring, richer niche-fit, gender-classify on rollup (parks as `unknown`).
- **Known dual-mode footgun flagged in A8:** `persistRadarReel` `DO UPDATE` reuses placeholders out of order → use `DO NOTHING` for v1 (documented inline).
- **Type consistency:** `breakout_score`/`total_score`/`discovered_via`/`account_handle` names identical across A4→A7→A9→B2; API contract fields match `radar_reels` columns (A1).
