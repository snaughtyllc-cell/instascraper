# Suggested-Account Reel Previews Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each Suggested-Accounts card the creator's top 3 reels by views as glanceable, cached thumbnails that play inline on click, so the team can vibe-check a creator without leaving the app.

**Architecture:** At discovery time, for each newly-inserted suggestion (bounded per cycle), run the reel actor, pick the top 3 reels by views (pure `pickTopReels`), persist them to a new `suggested_reels` table, and cache their thumbnails via the existing `downloadThumbnail`. The `/suggested` API joins those reels onto each account; the frontend renders a 3-thumbnail strip that swaps to an inline `<video>` on click, falling back to Instagram if the stored video URL has expired.

**Tech Stack:** Node/Express, dual-mode SQL (Postgres prod / better-sqlite3 local via `server/db.js`), React (CRA), `node --test`, Apify reel actor (`apify~instagram-reel-scraper`).

## Global Constraints

- Dual-mode SQL: placeholders `$1..$n` each appear once in ascending order (the sqlite shim strips `$n → ?` positionally); use `NOW_DEFAULT`/`SERIAL` template vars in `initDB`; new tables are a single `CREATE TABLE IF NOT EXISTS` block (the shim converts for sqlite) — only `ADD COLUMN` migrations need PG+sqlite twins.
- Config helper: extend `discoveryConfig(env)` using the existing local `num(v, d)` helper.
- Ranking is **top 3 by views** using the existing `extractViews(item)`.
- Cost bound: `DISCOVERY_REELS_MAX` (default **8**) reel-actor calls per discovery cycle; reel fetch uses `resultsLimit: 12`.
- Reuse existing infra: `downloadThumbnail` (shortcode-keyed cache) and `isErrorStubResponse` (skip blocked/not-found responses).
- Base off `main`. Keep the full server suite green: `cd server && npm test`. **Do NOT merge to main without the user's explicit OK.**

---

### Task 1: `pickTopReels` pure helper

**Files:**
- Modify: `server/scraper.js` (add top-level function near `isErrorStubResponse` ~line 24; add to exports ~line 1041)
- Test: `server/suggested-reels.test.js` (create)

**Interfaces:**
- Consumes: existing `extractViews(item)` and `isErrorStubResponse(items)` (already in `server/scraper.js`).
- Produces: `pickTopReels(items, n = 3) → Array<{ shortcode, thumbnailUrl, videoUrl, viewCount, likeCount, commentCount, permalink, postedAt, rank }>` — filters to reels/videos that have a shortcode, sorts by views desc, returns top `n` with `rank` 1..n. Returns `[]` for an error-stub or non-array input.

- [ ] **Step 1: Write the failing test**

Create `server/suggested-reels.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { pickTopReels } = require('./scraper');

const reel = (shortCode, views, extra = {}) => ({
  type: 'Video', shortCode, videoPlayCount: views, videoUrl: `https://x/${shortCode}.mp4`,
  displayUrl: `https://x/${shortCode}.jpg`, url: `https://www.instagram.com/reel/${shortCode}/`,
  likesCount: 10, commentsCount: 2, ...extra,
});

test('pickTopReels: keeps videos, sorts by views desc, caps at n, ranks 1..n', () => {
  const items = [reel('a', 100), reel('b', 900), reel('c', 500), reel('d', 700)];
  const out = pickTopReels(items, 3);
  assert.deepStrictEqual(out.map(r => r.shortcode), ['b', 'd', 'c']);
  assert.deepStrictEqual(out.map(r => r.rank), [1, 2, 3]);
  assert.strictEqual(out[0].viewCount, 900);
  assert.strictEqual(out[0].thumbnailUrl, 'https://x/b.jpg');
  assert.strictEqual(out[0].videoUrl, 'https://x/b.mp4');
});

test('pickTopReels: drops non-videos (images/carousels)', () => {
  const items = [reel('v', 300), { type: 'Image', shortCode: 'img', displayUrl: 'x' }, { type: 'Sidecar', shortCode: 'car' }];
  assert.deepStrictEqual(pickTopReels(items, 3).map(r => r.shortcode), ['v']);
});

test('pickTopReels: fewer than n reels returns what exists', () => {
  assert.strictEqual(pickTopReels([reel('a', 5)], 3).length, 1);
});

test('pickTopReels: missing views treated as 0 (sorts last)', () => {
  const items = [{ type: 'Video', shortCode: 'noview', videoUrl: 'x' }, reel('has', 50)];
  assert.deepStrictEqual(pickTopReels(items, 3).map(r => r.shortcode), ['has', 'noview']);
});

test('pickTopReels: permalink falls back to /reel/<shortcode>/ when url missing', () => {
  const [r] = pickTopReels([{ type: 'Video', shortCode: 'zz', videoUrl: 'x', videoPlayCount: 1 }], 1);
  assert.strictEqual(r.permalink, 'https://www.instagram.com/reel/zz/');
});

test('pickTopReels: drops items with no shortcode (cannot be stored)', () => {
  const items = [{ type: 'Video', videoUrl: 'x', videoPlayCount: 999 }, reel('ok', 1)];
  assert.deepStrictEqual(pickTopReels(items, 3).map(r => r.shortcode), ['ok']);
});

test('pickTopReels: error-stub / non-array input returns []', () => {
  assert.deepStrictEqual(pickTopReels([{ requestErrorMessages: ['BLOCKED'] }], 3), []);
  assert.deepStrictEqual(pickTopReels(null, 3), []);
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd server && node --test suggested-reels.test.js`
Expected: FAIL — `TypeError: pickTopReels is not a function`.

- [ ] **Step 3: Implement `pickTopReels`**

In `server/scraper.js`, immediately after the `isErrorStubResponse` / `errorStubReason` block (~line 24), add:

```js
// Top reels for a suggested-account preview: keep reels/videos that have a shortcode,
// rank by real view count (extractViews), take the top n with a 1..n rank. Returns []
// for an error-stub or non-array response. Pure — unit-tested.
function pickTopReels(items, n = 3) {
  if (!Array.isArray(items) || isErrorStubResponse(items)) return [];
  const reels = items.filter(it =>
    it && (it.type === 'Video' || it.productType === 'clips' || it.videoUrl) && (it.shortCode || it.id));
  reels.sort((a, b) => (extractViews(b) || 0) - (extractViews(a) || 0));
  return reels.slice(0, n).map((it, i) => {
    const shortcode = it.shortCode || it.id;
    let postedAt = null;
    if (it.timestamp) postedAt = typeof it.timestamp === 'string' ? it.timestamp : new Date(it.timestamp * 1000).toISOString();
    else if (it.takenAtTimestamp) postedAt = new Date(it.takenAtTimestamp * 1000).toISOString();
    return {
      shortcode,
      thumbnailUrl: it.displayUrl || (it.images && it.images[0]) || null,
      videoUrl: it.videoUrl || null,
      viewCount: extractViews(it) || 0,
      likeCount: (it.likesCount != null && it.likesCount >= 0) ? it.likesCount : (it.likes || 0),
      commentCount: (it.commentsCount != null && it.commentsCount >= 0) ? it.commentsCount : (it.comments || 0),
      permalink: it.url || `https://www.instagram.com/reel/${shortcode}/`,
      postedAt,
      rank: i + 1,
    };
  });
}
```

Add to the exports block (near `module.exports.isErrorStubResponse = ...`):

```js
module.exports.pickTopReels = pickTopReels;
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd server && node --test suggested-reels.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add server/scraper.js server/suggested-reels.test.js
git commit -m "feat(suggested): pickTopReels — top-3 reels by views (pure)"
```

---

### Task 2: `suggested_reels` table

**Files:**
- Modify: `server/db.js` (add a `CREATE TABLE` block in `initDB`, after the `suggested_accounts` block ~line 201)
- Test: `server/suggested-reels-db.test.js` (create)

**Interfaces:**
- Produces: table `suggested_reels(id, username, shortcode UNIQUE, thumbnail_url, video_url, view_count, like_count, comment_count, permalink, posted_at, rank, captured_at)`. Insert contract used by Task 3:
  `INSERT INTO suggested_reels (username, shortcode, thumbnail_url, video_url, view_count, like_count, comment_count, permalink, posted_at, rank) VALUES ($1..$10) ON CONFLICT (shortcode) DO NOTHING`.

- [ ] **Step 1: Write the failing test** (validates the dual-mode insert shape against in-memory sqlite, mirroring `discovery-reach.test.js`)

Create `server/suggested-reels-db.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');

// Mirrors the suggested_reels schema + insert with $n → ? (dual-mode shim).
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE suggested_reels (
    id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, shortcode TEXT UNIQUE NOT NULL,
    thumbnail_url TEXT, video_url TEXT, view_count INTEGER DEFAULT 0, like_count INTEGER DEFAULT 0,
    comment_count INTEGER DEFAULT 0, permalink TEXT, posted_at TEXT, rank INTEGER DEFAULT 0,
    captured_at TEXT DEFAULT (datetime('now'))
  )`);
  return db;
}
const INS = `INSERT INTO suggested_reels (username, shortcode, thumbnail_url, video_url, view_count, like_count, comment_count, permalink, posted_at, rank)
   VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT (shortcode) DO NOTHING`;
const ins = (db, r) => db.prepare(INS).run(r.username, r.shortcode, r.thumbnailUrl, r.videoUrl, r.viewCount, r.likeCount, r.commentCount, r.permalink, r.postedAt, r.rank);
const R = (o) => ({ username: 'u', shortcode: 's', thumbnailUrl: 't', videoUrl: 'v', viewCount: 100, likeCount: 5, commentCount: 1, permalink: 'p', postedAt: null, rank: 1, ...o });

test('suggested_reels: 10-column insert round-trips', () => {
  const db = makeDb();
  ins(db, R({ shortcode: 'abc', viewCount: 900, rank: 1 }));
  const row = db.prepare("SELECT * FROM suggested_reels WHERE shortcode='abc'").get();
  assert.strictEqual(row.username, 'u');
  assert.strictEqual(row.view_count, 900);
  assert.strictEqual(row.rank, 1);
});

test('suggested_reels: ON CONFLICT (shortcode) DO NOTHING is idempotent', () => {
  const db = makeDb();
  ins(db, R({ shortcode: 'dup', viewCount: 100 }));
  ins(db, R({ shortcode: 'dup', viewCount: 999 })); // same shortcode → ignored
  const rows = db.prepare("SELECT view_count FROM suggested_reels WHERE shortcode='dup'").all();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].view_count, 100);
});
```

- [ ] **Step 2: Run the test, verify it passes for the shape, then confirm the real schema exists**

Run: `cd server && node --test suggested-reels-db.test.js`
Expected: PASS (this test defines the schema inline; it locks the insert contract). The real table is added next so `initDB` creates it in both engines.

- [ ] **Step 3: Add the real table to `initDB`**

In `server/db.js`, immediately after the `CREATE TABLE IF NOT EXISTS suggested_accounts (...)` block (~line 201), add:

```js
  await db.query(`
    CREATE TABLE IF NOT EXISTS suggested_reels (
      id ${SERIAL},
      username TEXT NOT NULL,
      shortcode TEXT UNIQUE NOT NULL,
      thumbnail_url TEXT,
      video_url TEXT,
      view_count INTEGER DEFAULT 0,
      like_count INTEGER DEFAULT 0,
      comment_count INTEGER DEFAULT 0,
      permalink TEXT,
      posted_at TEXT,
      rank INTEGER DEFAULT 0,
      captured_at TEXT DEFAULT ${NOW_DEFAULT}
    )
  `);
```

- [ ] **Step 4: Verify the whole suite still boots the DB cleanly**

Run: `cd server && npm test`
Expected: PASS (all existing tests + the 2 new ones). The `db-health`/`upsert`/`integration` tests exercise `initDB`; they must stay green, proving the new `CREATE TABLE` is valid in sqlite.

- [ ] **Step 5: Commit**

```bash
git add server/db.js server/suggested-reels-db.test.js
git commit -m "feat(suggested): add suggested_reels table (dual-mode)"
```

---

### Task 3: `_fetchTopReels` + `captureTopReels` (scraper)

**Files:**
- Modify: `server/scraper.js` — add two methods to the `InstagramScraper` class (near `_fetchProfileQuick` ~line 842); ensure `downloadThumbnail` is imported.

**Interfaces:**
- Consumes: `pickTopReels` (Task 1), `suggested_reels` insert (Task 2), `REEL_ACTOR_ID`, `this._startApifyRun`, `this._waitForRun`, `pool`, `downloadThumbnail`, `BudgetExceededError`.
- Produces: `async _fetchTopReels(username) → reels[]` (rethrows `BudgetExceededError`, swallows other errors → `[]`); `async captureTopReels(username) → number` (persists reels, fire-and-forget thumbnail cache, returns count; rethrows `BudgetExceededError`).

- [ ] **Step 1: Ensure `downloadThumbnail` is imported**

In `server/scraper.js`, find the thumbnails import (it already imports `sweepThumbnails`). Change it to also import `downloadThumbnail`:

```js
const { sweepThumbnails, downloadThumbnail } = require('./thumbnails');
```

(If the file currently imports only `sweepThumbnails`, add `downloadThumbnail`. If it imports via a different line, add `downloadThumbnail` to that destructure.)

- [ ] **Step 2: Add the two methods**

In `server/scraper.js`, inside the `InstagramScraper` class, right after `_fetchProfileQuick(...) { ... }`, add:

```js
  // Fetch a suggested account's top reels (by views) for the preview strip. One reel-actor
  // call. Rethrows BudgetExceededError so the caller can stop the cycle; other errors → [].
  async _fetchTopReels(username) {
    try {
      const run = await this._startApifyRun(REEL_ACTOR_ID, {
        username: [String(username).replace('@', '')],
        resultsLimit: 12,
      }, { purpose: 'suggested-reels', query: username });
      const items = await this._waitForRun(run.id, 20);
      return pickTopReels(items || [], 3);
    } catch (err) {
      if (err instanceof BudgetExceededError) throw err;
      console.log(`[Discovery] top-reels fetch failed for @${username}: ${err.message}`);
      return [];
    }
  }

  // Fetch + persist a suggested account's top reels, then cache their thumbnails
  // (fire-and-forget, URLs are freshest now). Returns how many reels were captured.
  async captureTopReels(username) {
    const reels = await this._fetchTopReels(username); // may throw BudgetExceededError
    for (const r of reels) {
      try {
        await pool.query(
          `INSERT INTO suggested_reels (username, shortcode, thumbnail_url, video_url, view_count, like_count, comment_count, permalink, posted_at, rank)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (shortcode) DO NOTHING`,
          [username, r.shortcode, r.thumbnailUrl, r.videoUrl, r.viewCount, r.likeCount, r.commentCount, r.permalink, r.postedAt, r.rank]
        );
      } catch (e) { console.error(`[Discovery] reel insert failed for @${username}:`, e.message); }
    }
    for (const r of reels) {
      if (r.thumbnailUrl && r.shortcode) {
        downloadThumbnail({ shortcode: r.shortcode, thumbnail_url: r.thumbnailUrl }).catch(() => {});
      }
    }
    return reels.length;
  }
```

- [ ] **Step 3: Verify the module still loads and the suite is green**

Run: `cd server && npm test`
Expected: PASS (no behavior change to existing paths; this only adds methods). This is network glue over the already-tested `pickTopReels` and the already-tested insert shape, so no new unit test — it is exercised manually in Task 6/verification.

- [ ] **Step 4: Commit**

```bash
git add server/scraper.js
git commit -m "feat(suggested): _fetchTopReels + captureTopReels (reel actor + persist + cache)"
```

---

### Task 4: `discoveryConfig.reelsMax`

**Files:**
- Modify: `server/scheduler.js` (`discoveryConfig`, ~line 58-65)
- Test: `server/discovery-reach.test.js` (extend the existing `discoveryConfig` test ~line 6)

**Interfaces:**
- Produces: `discoveryConfig(env).reelsMax` — `Math.floor(num(env.DISCOVERY_REELS_MAX, 8))`.

- [ ] **Step 1: Extend the failing test**

In `server/discovery-reach.test.js`, in the `discoveryConfig` test, add assertions:

```js
  assert.strictEqual(d.reelsMax, 8); // default reel-preview capture cap
  assert.strictEqual(discoveryConfig({ DISCOVERY_REELS_MAX: '3' }).reelsMax, 3);
  assert.strictEqual(discoveryConfig({ DISCOVERY_REELS_MAX: 'nope' }).reelsMax, 8); // bad → default
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd server && node --test discovery-reach.test.js`
Expected: FAIL — `reelsMax` is `undefined`, expected `8`.

- [ ] **Step 3: Add the field**

In `server/scheduler.js`, in `discoveryConfig`'s returned object, add:

```js
    reelsMax: Math.floor(num(env.DISCOVERY_REELS_MAX, 8)),
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd server && node --test discovery-reach.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/scheduler.js server/discovery-reach.test.js
git commit -m "feat(discovery): DISCOVERY_REELS_MAX config (default 8)"
```

---

### Task 5: Capture reels during discovery

**Files:**
- Modify: `server/scheduler.js` (`runDiscovery`, the newly-inserted-suggestion loop where `if (ins.rowCount > 0) added++;`)

**Interfaces:**
- Consumes: `scraperInstance.captureTopReels` (Task 3), `dcfg.reelsMax` (Task 4), `BudgetExceededError` (already imported in scheduler.js).

- [ ] **Step 1: Add a bounded reel-capture counter before the insert loop**

In `server/scheduler.js` `runDiscovery`, just before the `for (const item of freshKept.slice(0, 50)) {` loop, add:

```js
    let reelsCaptured = 0;
    let reelsBudgetStop = false;
```

- [ ] **Step 2: Capture reels for each newly-inserted suggestion**

Replace the existing success line inside that loop:

```js
        if (ins.rowCount > 0) added++;
```

with:

```js
        if (ins.rowCount > 0) {
          added++;
          if (!reelsBudgetStop && reelsCaptured < dcfg.reelsMax) {
            try {
              await scraperInstance.captureTopReels(item.username);
              reelsCaptured++;
            } catch (e) {
              if (e instanceof BudgetExceededError) { reelsBudgetStop = true; console.log(`[Discovery] reel capture stopped at budget (captured ${reelsCaptured})`); }
              else console.error(`[Discovery] reel capture failed for @${item.username}:`, e.message);
            }
          }
        }
```

- [ ] **Step 3: Add `reelsCaptured` to the discovery metric line**

Find the `[Metric] discovery ...` console.log in `runDiscovery` and append ` reels=${reelsCaptured}` to it, e.g.:

```js
    console.log(`[Metric] discovery sources=${sources.length} candidates=${aggregated.length} enriched=${freshCandidates.length} female=${female} added=${added} bumped=${bumped} reels=${reelsCaptured}`);
```

- [ ] **Step 4: Verify the suite is still green**

Run: `cd server && npm test`
Expected: PASS (existing discovery tests don't invoke Apify; this adds a bounded call in the live path only). Manual end-to-end capture is verified in the Verification section.

- [ ] **Step 5: Commit**

```bash
git add server/scheduler.js
git commit -m "feat(discovery): capture top reels for new suggestions (bounded by reelsMax)"
```

---

### Task 6: Serve reels — `attachTopReels`, `/suggested` join, thumb route

**Files:**
- Modify: `server/scraper.js` (add pure `attachTopReels` + export)
- Modify: `server/index.js` (`/suggested` handler ~line 347; add `/suggested/reels/:id/thumb` route near the `/thumb/:postId` route ~line 823; ensure `downloadThumbnail` is imported — it already is at line 15)
- Test: `server/suggested-reels.test.js` (extend)

**Interfaces:**
- Produces: `attachTopReels(accounts, reels) → accounts` with a `top_reels` array per account (grouped by `username`, ordered by `rank`). `GET /suggested` returns accounts each with `top_reels`. `GET /suggested/reels/:id/thumb` serves the cached reel thumbnail.

- [ ] **Step 1: Write the failing test for `attachTopReels`**

Append to `server/suggested-reels.test.js`:

```js
const { attachTopReels } = require('./scraper');

test('attachTopReels: groups reels by username, ordered by rank; empty when none', () => {
  const accounts = [{ username: 'alice' }, { username: 'bob' }];
  const reels = [
    { id: 2, username: 'alice', rank: 2, shortcode: 'a2' },
    { id: 1, username: 'alice', rank: 1, shortcode: 'a1' },
    { id: 9, username: 'carol', rank: 1, shortcode: 'c1' },
  ];
  const out = attachTopReels(accounts, reels);
  assert.deepStrictEqual(out[0].top_reels.map(r => r.shortcode), ['a1', 'a2']); // rank order
  assert.deepStrictEqual(out[1].top_reels, []); // bob has none
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd server && node --test suggested-reels.test.js`
Expected: FAIL — `attachTopReels is not a function`.

- [ ] **Step 3: Implement `attachTopReels`**

In `server/scraper.js`, after `pickTopReels`, add:

```js
// Attach each account's reels (grouped by username, ordered by rank) as `top_reels`.
// Pure — unit-tested.
function attachTopReels(accounts, reels) {
  const byUser = new Map();
  for (const r of (reels || [])) {
    if (!byUser.has(r.username)) byUser.set(r.username, []);
    byUser.get(r.username).push(r);
  }
  for (const list of byUser.values()) list.sort((a, b) => (a.rank || 0) - (b.rank || 0));
  return (accounts || []).map(a => ({ ...a, top_reels: byUser.get(a.username) || [] }));
}
```

Add to exports:

```js
module.exports.attachTopReels = attachTopReels;
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd server && node --test suggested-reels.test.js`
Expected: PASS.

- [ ] **Step 5: Wire `attachTopReels` into `GET /suggested`**

In `server/index.js`, add `attachTopReels` to the `require('./scraper')` destructure at the top of the file (wherever `suggestionsOrderClause` / other scraper exports are imported). Then, in the `/suggested` handler, after the accounts query returns `result`, replace `res.json(result.rows)` (or equivalent) with:

```js
  const accounts = result.rows;
  let reels = [];
  if (accounts.length) {
    const names = accounts.map(a => a.username);
    const ph = names.map((_, i) => `$${i + 1}`).join(',');
    reels = (await pool.query(
      `SELECT id, username, shortcode, view_count, video_url, permalink, rank
       FROM suggested_reels WHERE username IN (${ph}) ORDER BY rank`,
      names
    )).rows;
  }
  res.json(attachTopReels(accounts, reels));
```

(`$1..$k` are generated once each in ascending order — dual-mode safe.)

- [ ] **Step 6: Add the reel thumbnail route**

In `server/index.js`, right after the `app.get('/thumb/:postId', ...)` handler (~line 830), add:

```js
app.get('/suggested/reels/:id/thumb', asyncHandler(async (req, res) => {
  const result = await pool.query('SELECT thumbnail_url, shortcode FROM suggested_reels WHERE id = $1', [Number(req.params.id)]);
  const reel = result.rows[0];
  if (!reel || !reel.thumbnail_url) return res.status(404).send('No thumbnail');
  const r = await downloadThumbnail(reel);
  if (r.status === 'cached') return res.sendFile(r.path);
  return res.status(502).json({ error: `thumbnail ${r.status}: ${r.error || ''}` });
}));
```

(The `/suggested` prefix already requires auth via `app.use('/suggested', requireAuth)`.)

- [ ] **Step 7: Verify the suite is green**

Run: `cd server && npm test`
Expected: PASS (new `attachTopReels` test + all existing; the route/query are verified manually in Verification).

- [ ] **Step 8: Commit**

```bash
git add server/scraper.js server/index.js server/suggested-reels.test.js
git commit -m "feat(suggested): serve top_reels on /suggested + reel thumbnail route"
```

---

### Task 7: Frontend reel strip in the Suggested card

**Files:**
- Modify: `client/src/pages/SuggestedAccountsTab.js` (add `API_URL` const, `SuggestedReel` + `SuggestedReelStrip` components, render in `renderCard`)

**Interfaces:**
- Consumes: `/suggested` response `s.top_reels` (`{ id, shortcode, view_count, video_url, permalink }`), `GET /suggested/reels/:id/thumb`, existing `formatCount`, `useState` (already imported).

- [ ] **Step 1: Add `API_URL` and the reel components**

In `client/src/pages/SuggestedAccountsTab.js`, add below the imports:

```js
const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:4000';
```

Add these components above `export default function SuggestedAccountsTab()`:

```js
function SuggestedReel({ reel }) {
  const [playing, setPlaying] = useState(false);
  const openIG = () => window.open(reel.permalink || `https://instagram.com/reel/${reel.shortcode}/`, '_blank', 'noopener');
  if (playing && reel.video_url) {
    return (
      <video
        src={reel.video_url}
        controls
        autoPlay
        onError={() => { setPlaying(false); openIG(); }}
        className="w-full aspect-[9/16] object-cover rounded-lg bg-black"
      />
    );
  }
  return (
    <button
      onClick={() => (reel.video_url ? setPlaying(true) : openIG())}
      className="relative w-full aspect-[9/16] rounded-lg overflow-hidden bg-gray-800 group/reel"
    >
      <img
        src={`${API_URL}/suggested/reels/${reel.id}/thumb`}
        alt=""
        loading="lazy"
        className="w-full h-full object-cover"
      />
      <span className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 group-hover/reel:opacity-100 transition-opacity">
        <svg className="w-6 h-6 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
      </span>
      <span className="absolute bottom-1 left-1 bg-black/70 text-white text-[10px] px-1.5 py-0.5 rounded">
        {formatCount(reel.view_count)}
      </span>
    </button>
  );
}

function SuggestedReelStrip({ reels }) {
  if (!reels || reels.length === 0) return null;
  return (
    <div className="grid grid-cols-3 gap-1.5">
      {reels.map((r) => <SuggestedReel key={r.id} reel={r} />)}
    </div>
  );
}
```

- [ ] **Step 2: Render the strip in the card**

In `renderCard`, immediately after the closing `</div>` of the `{/* Stats */}` grid (before the `{/* Content breakdown */}` block), add:

```jsx
      {/* Top reels */}
      <SuggestedReelStrip reels={s.top_reels} />
```

- [ ] **Step 3: Build the client to verify it compiles**

Run: `cd client && npm run build`
Expected: build succeeds with no errors (warnings OK).

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/SuggestedAccountsTab.js
git commit -m "feat(suggested): reel preview strip in the Suggested card"
```

---

## Verification (manual, after all tasks)

1. **Server suite green:** `cd server && npm test` → all pass (Tasks 1–6 tests + existing).
2. **DB:** confirm `suggested_reels` exists (local sqlite via a fresh `initDB`, or prod via a read-only `railway ssh` query).
3. **End-to-end (local or prod):** trigger discovery; confirm `[Metric] discovery ... reels=N` logs, that `suggested_reels` rows appear (≤ `DISCOVERY_REELS_MAX` accounts/cycle), and that `/suggested` returns `top_reels` per account.
4. **UI:** open the Suggested tab — cards show up to 3 thumbnails with view badges; clicking a thumbnail plays the reel inline; an account with no reels shows no strip (card unchanged).
5. **Expiry fallback:** for an older suggestion whose `video_url` has expired, clicking opens the reel on Instagram instead of erroring.

## Self-Review notes

- **Spec coverage:** capture (Tasks 1,3,5) · storage (Task 2) · config bound (Task 4) · serving (Task 6) · UI (Task 7) · thumbnail reuse (Tasks 3,6) · error-stub skip (Task 1) · video fallback (Task 7). All spec sections mapped.
- **Type consistency:** `pickTopReels`/`captureTopReels` object keys (`shortcode`, `thumbnailUrl`, `videoUrl`, `viewCount`, `likeCount`, `commentCount`, `permalink`, `postedAt`, `rank`) are consumed verbatim by the Task 3 INSERT param order; `top_reels` item fields (`id`, `shortcode`, `view_count`, `video_url`, `permalink`, `rank`) match the Task 6 SELECT and the Task 7 UI.
- **Placeholders:** none — every step shows complete code and exact commands.
