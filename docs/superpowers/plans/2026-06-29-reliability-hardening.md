# Reliability Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make InstaScraper survive DB outages without crash-looping, keep thumbnails durable (and heal broken ones), and gate Railway deploys on real readiness.

**Architecture:** New focused server modules (`thumbnails.js`, `db-health.js`, `health.js`) hold testable units with injected dependencies; `db.js`, `index.js`, `scraper.js`, `scheduler.js` are wired to use them. TDD with the built-in `node:test` runner — no new dependencies.

**Tech Stack:** Node.js 20+ (runtime is 25), Express 4, `pg` (Postgres) / `better-sqlite3` (local) via the dual-mode `db.js`, `node-cron`, `node-fetch@2`. Tests: `node:test` + `node:assert`, `better-sqlite3` in-memory for DB tests.

## Global Constraints

- Backend + Railway config only — **no client/UI changes**.
- Dual-mode DB must keep working: every SQL change must run on **both** Postgres and SQLite (`db.query` is the only DB interface; `USE_PG = !!process.env.DATABASE_URL`).
- Preserve user-owned post fields on re-scrape: `tag`, `notes`, `content_type`, `archived`, `soft_deleted` are **never** overwritten by scrape upserts.
- New columns added only via the existing idempotent migration pattern in `initDB` (`ADD COLUMN IF NOT EXISTS` for PG; try/catch `ADD COLUMN` for SQLite).
- Thumbnail downloads: bounded timeout, never retry `403`/`404`, atomic write (temp → rename), reject zero-byte/non-image responses.
- Test runner: `cd server && npm test` (`node --test`). All test files end in `.test.js` and live in `server/`.

---

## File Structure

**Create:**
- `server/thumbnails.js` — `downloadThumbnail(post, deps)`, `sweepThumbnails(opts, deps)`. Owns all thumbnail fetch/cache/atomic-write logic.
- `server/db-health.js` — `classifyDbError(err)`, `isTransientDbError(err)`, `asyncHandler(fn)`, `dbErrorMiddleware(err,req,res,next)`, `initWithRetry(initFn, opts)`.
- `server/health.js` — readiness latch (`markReady()`, `isReady()`, `resetForTest()`), `liveHandler`, `readyHandler`, `assertThumbDirWritable(dir)`.
- Test files: `server/thumbnails.test.js`, `server/upsert.test.js`, `server/db-health.test.js`, `server/health.test.js`, `server/integration.test.js`.

**Modify:**
- `server/db.js` — add cache-state columns in `initDB`; export `initDB`; remove the fire-and-forget `initDB().catch(...)` (moves to `index.js` with retry); add `pool.on('error', ...)`.
- `server/scraper.js` — change posts upsert from `DO NOTHING` to `DO UPDATE`; trigger sweep after a scrape.
- `server/scheduler.js` — add once-daily sweep cron.
- `server/index.js` — call `initWithRetry`; mark ready; mount `/live` `/ready`; wrap async routes with `asyncHandler`; replace inline `/thumb` body with `downloadThumbnail`; add `dbErrorMiddleware` last; export `app` and guard `app.listen`; boot-time volume sanity check.
- `server/package.json` — add `"test": "node --test"`.

---

### Task 1: Durable thumbnail download helper

**Files:**
- Create: `server/thumbnails.js`
- Create: `server/thumbnails.test.js`
- Modify: `server/package.json` (add test script)

**Interfaces:**
- Produces: `downloadThumbnail(post, deps) -> Promise<{status: 'cached'|'expired'|'error', path?: string, error?: string}>` where `post = {shortcode, thumbnail_url}` and `deps = {fetch, fs, thumbDir, inflight}` (all optional; real defaults used in production). `status: 'cached'` means a valid file exists at `path`.

- [ ] **Step 1: Add the test script**

In `server/package.json`, add to `"scripts"`:
```json
"test": "node --test"
```

- [ ] **Step 2: Write the failing test**

Create `server/thumbnails.test.js`:
```js
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { downloadThumbnail } = require('./thumbnails');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'thumbtest-'));
}
function okFetch(bytes = Buffer.from('JPEGDATA')) {
  return async () => ({ ok: true, status: 200, headers: { get: () => 'image/jpeg' }, buffer: async () => bytes });
}

test('downloads and caches a fresh thumbnail atomically', async () => {
  const dir = tmpDir();
  const r = await downloadThumbnail({ shortcode: 'abc', thumbnail_url: 'http://x/a.jpg' },
    { fetch: okFetch(), thumbDir: dir, inflight: new Map() });
  assert.equal(r.status, 'cached');
  assert.ok(fs.existsSync(path.join(dir, 'abc.jpg')));
  assert.ok(fs.readdirSync(dir).every(f => !f.includes('.tmp')), 'no temp files left behind');
});

test('returns cached without refetching when a valid file already exists', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'abc.jpg'), 'EXISTING');
  let called = false;
  const r = await downloadThumbnail({ shortcode: 'abc', thumbnail_url: 'http://x/a.jpg' },
    { fetch: async () => { called = true; return {}; }, thumbDir: dir, inflight: new Map() });
  assert.equal(r.status, 'cached');
  assert.equal(called, false);
});

test('marks expired on 403 and does not write a file', async () => {
  const dir = tmpDir();
  const r = await downloadThumbnail({ shortcode: 'gone', thumbnail_url: 'http://x/g.jpg' },
    { fetch: async () => ({ ok: false, status: 403, headers: { get: () => null } }), thumbDir: dir, inflight: new Map() });
  assert.equal(r.status, 'expired');
  assert.equal(fs.existsSync(path.join(dir, 'gone.jpg')), false);
});

test('rejects a zero-byte body as error', async () => {
  const dir = tmpDir();
  const r = await downloadThumbnail({ shortcode: 'empty', thumbnail_url: 'http://x/e.jpg' },
    { fetch: okFetch(Buffer.alloc(0)), thumbDir: dir, inflight: new Map() });
  assert.equal(r.status, 'error');
  assert.equal(fs.existsSync(path.join(dir, 'empty.jpg')), false);
});

test('dedups concurrent downloads of the same shortcode', async () => {
  const dir = tmpDir();
  let calls = 0;
  const slow = async () => { calls++; await new Promise(r => setTimeout(r, 20)); return { ok: true, status: 200, headers: { get: () => 'image/jpeg' }, buffer: async () => Buffer.from('X') }; };
  const inflight = new Map();
  const post = { shortcode: 'dup', thumbnail_url: 'http://x/d.jpg' };
  const [a, b] = await Promise.all([
    downloadThumbnail(post, { fetch: slow, thumbDir: dir, inflight }),
    downloadThumbnail(post, { fetch: slow, thumbDir: dir, inflight }),
  ]);
  assert.equal(a.status, 'cached');
  assert.equal(b.status, 'cached');
  assert.equal(calls, 1, 'fetch should run once for two concurrent callers');
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `Cannot find module './thumbnails'`.

- [ ] **Step 4: Write minimal implementation**

Create `server/thumbnails.js`:
```js
const path = require('path');
const realFs = require('fs');
const realFetch = require('node-fetch');

const DEFAULT_THUMB_DIR = path.join(__dirname, 'thumbnails');
const sharedInflight = new Map();
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

async function downloadThumbnail(post, deps = {}) {
  const fs = deps.fs || realFs;
  const fetch = deps.fetch || realFetch;
  const thumbDir = deps.thumbDir || DEFAULT_THUMB_DIR;
  const inflight = deps.inflight || sharedInflight;

  if (!post || !post.thumbnail_url) return { status: 'error', error: 'no thumbnail_url' };
  const file = path.join(thumbDir, `${post.shortcode}.jpg`);

  try {
    const st = fs.statSync(file);
    if (st.size > 0) return { status: 'cached', path: file };
  } catch { /* not cached yet */ }

  if (inflight.has(post.shortcode)) return inflight.get(post.shortcode);

  const job = (async () => {
    try {
      const res = await fetch(post.thumbnail_url, { headers: { 'User-Agent': UA }, timeout: 15000 });
      if (res.status === 403 || res.status === 404) return { status: 'expired', error: `HTTP ${res.status}` };
      if (!res.ok) return { status: 'error', error: `HTTP ${res.status}` };
      const ctype = res.headers.get('content-type') || '';
      if (ctype && !ctype.startsWith('image/')) return { status: 'error', error: `bad content-type ${ctype}` };
      const buf = await res.buffer();
      if (!buf || buf.length === 0) return { status: 'error', error: 'empty body' };
      fs.mkdirSync(thumbDir, { recursive: true });
      const tmp = path.join(thumbDir, `${post.shortcode}.${process.pid}.${Date.now()}.tmp`);
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, file);
      return { status: 'cached', path: file };
    } catch (err) {
      return { status: 'error', error: err.message };
    } finally {
      inflight.delete(post.shortcode);
    }
  })();

  inflight.set(post.shortcode, job);
  return job;
}

module.exports = { downloadThumbnail, DEFAULT_THUMB_DIR };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && npm test`
Expected: PASS (5 tests in `thumbnails.test.js`).

- [ ] **Step 6: Commit**

```bash
git add server/thumbnails.js server/thumbnails.test.js server/package.json
git commit -m "feat: durable thumbnail download helper with atomic write + dedup"
```

---

### Task 2: Cache-state columns + heal-on-rescrape upsert

**Files:**
- Modify: `server/db.js` (add columns in `initDB`)
- Modify: `server/scraper.js:279-289` (upsert)
- Create: `server/upsert.test.js`

**Interfaces:**
- Produces: `posts` table gains `thumbnail_cache_status TEXT` and `thumbnail_cache_error TEXT`. The scrape insert uses `ON CONFLICT (shortcode) DO UPDATE` setting scrape-derived fields + `thumbnail_cache_status='pending'`, never touching `tag`/`notes`/`content_type`/`archived`/`soft_deleted`.

- [ ] **Step 1: Write the failing test**

Create `server/upsert.test.js` (uses SQLite in-memory to prove dual-mode correctness):
```js
const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');

// The exact upsert SQL the scraper will use (kept in sync with scraper.js).
const UPSERT = `
  INSERT INTO posts (shortcode, thumbnail_url, like_count, view_count, tag, notes, thumbnail_cache_status)
  VALUES (@shortcode, @thumbnail_url, @like_count, @view_count, NULL, NULL, 'pending')
  ON CONFLICT (shortcode) DO UPDATE SET
    thumbnail_url = excluded.thumbnail_url,
    like_count = excluded.like_count,
    view_count = excluded.view_count,
    thumbnail_cache_status = 'pending'`;

test('re-scrape refreshes thumbnail_url + counts but preserves user fields', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE posts (
    shortcode TEXT UNIQUE, thumbnail_url TEXT, like_count INTEGER, view_count INTEGER,
    tag TEXT, notes TEXT, thumbnail_cache_status TEXT)`);

  db.prepare(UPSERT).run({ shortcode: 'p1', thumbnail_url: 'OLD', like_count: 10, view_count: 5 });
  // user tags + notes it, and it gets cached
  db.prepare(`UPDATE posts SET tag='recreate', notes='great hook', thumbnail_cache_status='cached' WHERE shortcode='p1'`).run();

  // re-scrape with a fresh URL + new counts
  db.prepare(UPSERT).run({ shortcode: 'p1', thumbnail_url: 'FRESH', like_count: 99, view_count: 50 });

  const row = db.prepare(`SELECT * FROM posts WHERE shortcode='p1'`).get();
  assert.equal(row.thumbnail_url, 'FRESH', 'thumbnail_url refreshed');
  assert.equal(row.like_count, 99, 'counts refreshed');
  assert.equal(row.tag, 'recreate', 'user tag preserved');
  assert.equal(row.notes, 'great hook', 'user notes preserved');
  assert.equal(row.thumbnail_cache_status, 'pending', 'cache status reset so sweep re-downloads');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — the test currently passes only if the upsert is correct; run it first against a `DO NOTHING` variant by temporarily changing the test's `UPSERT` to `DO NOTHING` to confirm it would catch the bug, then restore to `DO UPDATE`. (Sanity check that the assertion is meaningful.)

- [ ] **Step 3: Add columns in `initDB`**

In `server/db.js`, inside `initDB`, add to the PG migrations array:
```js
`ALTER TABLE posts ADD COLUMN IF NOT EXISTS thumbnail_cache_status TEXT`,
`ALTER TABLE posts ADD COLUMN IF NOT EXISTS thumbnail_cache_error TEXT`,
```
and to the SQLite migrations array:
```js
`ALTER TABLE posts ADD COLUMN thumbnail_cache_status TEXT`,
`ALTER TABLE posts ADD COLUMN thumbnail_cache_error TEXT`,
```

- [ ] **Step 4: Change the scraper upsert**

In `server/scraper.js`, replace the insert at lines 279-289. Change the trailing `ON CONFLICT (shortcode) DO NOTHING` to:
```sql
ON CONFLICT (shortcode) DO UPDATE SET
  thumbnail_url = EXCLUDED.thumbnail_url,
  video_url = EXCLUDED.video_url,
  like_count = EXCLUDED.like_count,
  comment_count = EXCLUDED.comment_count,
  view_count = EXCLUDED.view_count,
  followers_at_scrape = EXCLUDED.followers_at_scrape,
  er_percent = EXCLUDED.er_percent,
  er_label = EXCLUDED.er_label,
  thumbnail_cache_status = 'pending'
```
Leave the column list, `VALUES`, and params array unchanged. Note: `insertResult.rowCount` will now be > 0 for updates too; keep the existing `if (insertResult.rowCount > 0) count++;` — "count" now means "new or refreshed," which is acceptable for the job message.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && npm test`
Expected: PASS (`upsert.test.js`).

- [ ] **Step 6: Commit**

```bash
git add server/db.js server/scraper.js server/upsert.test.js
git commit -m "feat: heal-on-rescrape upsert + thumbnail cache-state columns"
```

---

### Task 3: Thumbnail sweep

**Files:**
- Modify: `server/thumbnails.js` (add `sweepThumbnails`)
- Modify: `server/thumbnails.test.js` (add sweep tests)

**Interfaces:**
- Consumes: `downloadThumbnail` (Task 1); a `db` with `query(sql, params) -> {rows}`.
- Produces: `sweepThumbnails(opts, deps) -> Promise<{attempted, cached, expired, errored}>`. `opts = {maxAgeDays=14, batchLimit=200, concurrency=4}`. `deps = {db, download, thumbDir, now}`.

- [ ] **Step 1: Write the failing test**

Add to `server/thumbnails.test.js`:
```js
const { sweepThumbnails } = require('./thumbnails');

test('sweep downloads only pending/null recent posts and tallies outcomes', async () => {
  const rows = [
    { id: 1, shortcode: 'a', thumbnail_url: 'http://x/a' },
    { id: 2, shortcode: 'b', thumbnail_url: 'http://x/b' },
  ];
  const updates = [];
  const db = {
    query: async (sql, params) => {
      if (/SELECT/i.test(sql)) return { rows };
      updates.push({ sql, params });
      return { rows: [] };
    },
  };
  const download = async (post) => post.shortcode === 'a'
    ? { status: 'cached' } : { status: 'expired', error: 'HTTP 403' };

  const res = await sweepThumbnails({ batchLimit: 10 }, { db, download });
  assert.equal(res.attempted, 2);
  assert.equal(res.cached, 1);
  assert.equal(res.expired, 1);
  assert.equal(updates.length, 2, 'writes a cache-status update per post');
});

test('sweep never throws when a download rejects', async () => {
  const db = { query: async (sql) => /SELECT/i.test(sql) ? { rows: [{ id: 1, shortcode: 'a', thumbnail_url: 'u' }] } : { rows: [] } };
  const download = async () => { throw new Error('boom'); };
  const res = await sweepThumbnails({}, { db, download });
  assert.equal(res.errored, 1);
});

test('sweep skips posts older than maxAgeDays (age filter actually applied)', async () => {
  const Database = require('better-sqlite3');
  const sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE posts (id INTEGER PRIMARY KEY, shortcode TEXT, thumbnail_url TEXT,
    thumbnail_cache_status TEXT, thumbnail_cache_error TEXT, scraped_at TEXT)`);
  sqlite.prepare(`INSERT INTO posts (id,shortcode,thumbnail_url,thumbnail_cache_status,scraped_at) VALUES (?,?,?,?,?)`)
    .run(1, 'old', 'u', 'pending', '2020-01-01T00:00:00Z');
  sqlite.prepare(`INSERT INTO posts (id,shortcode,thumbnail_url,thumbnail_cache_status,scraped_at) VALUES (?,?,?,?,?)`)
    .run(2, 'new', 'u', 'pending', '2026-06-28T00:00:00Z');
  const db = { query: async (sql, params = []) => {
    const conv = sql.replace(/\$(\d+)/g, '?');
    if (/^\s*SELECT/i.test(sql)) return { rows: sqlite.prepare(conv).all(...params) };
    sqlite.prepare(conv).run(...params); return { rows: [] };
  }};
  const seen = [];
  const download = async (p) => { seen.push(p.shortcode); return { status: 'cached' }; };
  const res = await sweepThumbnails({ maxAgeDays: 14 },
    { db, download, now: () => Date.parse('2026-06-29T00:00:00Z') });
  assert.deepEqual(seen, ['new'], 'only the recent pending post is swept; the 2020 one is skipped');
  assert.equal(res.cached, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `sweepThumbnails is not a function`.

- [ ] **Step 3: Implement `sweepThumbnails`**

Add to `server/thumbnails.js` (and add to exports):
```js
async function sweepThumbnails(opts = {}, deps = {}) {
  const { maxAgeDays = 14, batchLimit = 200, concurrency = 4 } = opts;
  const db = deps.db || require('./db');
  const download = deps.download || ((p) => downloadThumbnail(p, { thumbDir: deps.thumbDir }));

  // Only recent posts: stored scraped_at is ISO 'YYYY-MM-DDThh:mm:ssZ' which sorts
  // lexicographically = chronologically, so a string compare is PG/SQLite-safe.
  const now = deps.now ? deps.now() : Date.now();
  const cutoff = new Date(now - maxAgeDays * 86400000).toISOString().slice(0, 19) + 'Z';
  const sel = await db.query(
    `SELECT id, shortcode, thumbnail_url FROM posts
     WHERE (thumbnail_cache_status IS NULL OR thumbnail_cache_status = 'pending')
       AND thumbnail_url IS NOT NULL
       AND scraped_at >= $1
     ORDER BY id DESC LIMIT $2`,
    [cutoff, batchLimit]
  );
  const posts = sel.rows || [];
  const tally = { attempted: 0, cached: 0, expired: 0, errored: 0 };

  async function worker(queue) {
    while (queue.length) {
      const post = queue.shift();
      tally.attempted++;
      let outcome;
      try {
        const r = await download(post);
        outcome = r.status;
        await db.query(`UPDATE posts SET thumbnail_cache_status = $1, thumbnail_cache_error = $2 WHERE id = $3`,
          [r.status, r.error || null, post.id]);
      } catch (err) {
        outcome = 'error';
        try { await db.query(`UPDATE posts SET thumbnail_cache_status = 'error', thumbnail_cache_error = $1 WHERE id = $2`, [err.message, post.id]); } catch { /* ignore */ }
      }
      if (outcome === 'cached') tally.cached++;
      else if (outcome === 'expired') tally.expired++;
      else tally.errored++;
      await new Promise(r => setTimeout(r, 100 + Math.floor(Math.random() * 200))); // jitter
    }
  }

  const queue = posts.slice();
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker(queue)));
  return tally;
}
```
Update the export line to: `module.exports = { downloadThumbnail, sweepThumbnails, DEFAULT_THUMB_DIR };`

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/thumbnails.js server/thumbnails.test.js
git commit -m "feat: bounded-concurrency thumbnail sweep with outcome tallying"
```

---

### Task 4: Wire sweep triggers (after-scrape + daily cron)

**Files:**
- Modify: `server/scraper.js` (after `_fetchAndStoreResults` completes)
- Modify: `server/scheduler.js` (`startScheduler` cron + new `runThumbnailSweep`)

**Interfaces:**
- Consumes: `sweepThumbnails` (Task 3).
- Produces: `scheduler.runThumbnailSweep()`; a daily cron entry; a non-blocking sweep call at the end of a scrape.

- [ ] **Step 1: Trigger after scrape (non-blocking)**

In `server/scraper.js`, at the top add: `const { sweepThumbnails } = require('./thumbnails');`
After the job is marked `completed` (right after the `UPDATE scrape_jobs SET status='completed'...` at line ~305), add:
```js
// Fire-and-forget: cache thumbnails for the just-scraped posts while URLs are fresh.
sweepThumbnails({ batchLimit: 80 }).catch(err => console.error('[Sweep] post-scrape sweep failed:', err.message));
```

- [ ] **Step 2: Add daily cron + runner in scheduler**

In `server/scheduler.js`, add near the other runners:
```js
async function runThumbnailSweep() {
  const { sweepThumbnails } = require('./thumbnails');
  jobStatus.thumbnailSweep = jobStatus.thumbnailSweep || {};
  jobStatus.thumbnailSweep.status = 'running';
  try {
    const t = await sweepThumbnails({ maxAgeDays: 14, batchLimit: 200 });
    jobStatus.thumbnailSweep.message = `Swept: ${t.cached} cached, ${t.expired} expired, ${t.errored} errored`;
  } catch (err) {
    jobStatus.thumbnailSweep.message = `Failed: ${err.message}`;
  }
  jobStatus.thumbnailSweep.status = 'idle';
}
```
In `startScheduler`, add a cron line (daily 05:00):
```js
cron.schedule('0 5 * * *', () => runThumbnailSweep());
```
Export `runThumbnailSweep` in `module.exports`.

- [ ] **Step 3: Write a focused test for the runner**

Create `server/sweep-trigger.test.js`:
```js
const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

test('runThumbnailSweep swallows sweep errors and records status', async () => {
  // stub ./thumbnails before requiring scheduler
  const orig = Module._load;
  Module._load = function (req, parent, isMain) {
    if (req === './thumbnails') return { sweepThumbnails: async () => { throw new Error('x'); } };
    return orig.apply(this, arguments);
  };
  delete require.cache[require.resolve('./scheduler')];
  const sched = require('./scheduler');
  await assert.doesNotReject(() => sched.runThumbnailSweep());
  Module._load = orig;
  delete require.cache[require.resolve('./scheduler')];
});
```

- [ ] **Step 4: Run tests**

Run: `cd server && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/scraper.js server/scheduler.js server/sweep-trigger.test.js
git commit -m "feat: trigger thumbnail sweep after each scrape and once daily"
```

---

### Task 5: DB error classification + async handler + error middleware

**Files:**
- Create: `server/db-health.js`
- Create: `server/db-health.test.js`

**Interfaces:**
- Produces:
  - `isTransientDbError(err) -> boolean` (true for `ENOTFOUND`, `ECONNREFUSED`, `ETIMEDOUT`, `ECONNRESET`, `57P03` cannot_connect_now, `08*` connection exceptions).
  - `classifyDbError(err) -> 'transient' | 'auth' | 'other'` (`auth` for `28P01`/`28000`/`3D000`).
  - `asyncHandler(fn) -> (req,res,next)` that catches rejections and calls `next(err)`.
  - `dbErrorMiddleware(err, req, res, next)` → 503 for transient DB errors, else 500.

- [ ] **Step 1: Write the failing test**

Create `server/db-health.test.js`:
```js
const { test } = require('node:test');
const assert = require('node:assert');
const { isTransientDbError, classifyDbError, asyncHandler, dbErrorMiddleware } = require('./db-health');

test('classifies transient vs auth vs other', () => {
  assert.equal(isTransientDbError({ code: 'ENOTFOUND' }), true);
  assert.equal(isTransientDbError({ code: 'ECONNREFUSED' }), true);
  assert.equal(isTransientDbError({ code: '28P01' }), false);
  assert.equal(classifyDbError({ code: 'ENOTFOUND' }), 'transient');
  assert.equal(classifyDbError({ code: '28P01' }), 'auth');
  assert.equal(classifyDbError({ message: 'syntax error' }), 'other');
});

test('asyncHandler forwards rejections to next', async () => {
  const err = new Error('boom');
  let passed;
  const handler = asyncHandler(async () => { throw err; });
  await handler({}, {}, (e) => { passed = e; });
  assert.equal(passed, err);
});

test('dbErrorMiddleware maps transient DB errors to 503 else 500', () => {
  const mk = () => { let code, body; return { status(c){code=c;return this;}, json(b){body=b;return this;}, get code(){return code;}, get body(){return body;} }; };
  let res = mk();
  dbErrorMiddleware({ code: 'ECONNREFUSED' }, {}, res, () => {});
  assert.equal(res.code, 503);
  res = mk();
  dbErrorMiddleware({ message: 'real bug' }, {}, res, () => {});
  assert.equal(res.code, 500);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `Cannot find module './db-health'`.

- [ ] **Step 3: Implement**

Create `server/db-health.js`:
```js
const TRANSIENT_CODES = new Set(['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', '57P03']);
const AUTH_CODES = new Set(['28P01', '28000', '3D000']);

function isTransientDbError(err) {
  if (!err) return false;
  if (TRANSIENT_CODES.has(err.code)) return true;
  if (typeof err.code === 'string' && err.code.startsWith('08')) return true; // connection exceptions
  return false;
}
function classifyDbError(err) {
  if (isTransientDbError(err)) return 'transient';
  if (err && AUTH_CODES.has(err.code)) return 'auth';
  return 'other';
}
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
function dbErrorMiddleware(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (isTransientDbError(err)) {
    console.error('[DB] transient error on request:', err.code || err.message);
    return res.status(503).json({ error: 'temporarily unavailable' });
  }
  console.error('[Error]', err && err.stack ? err.stack : err);
  return res.status(500).json({ error: 'internal error' });
}
module.exports = { isTransientDbError, classifyDbError, asyncHandler, dbErrorMiddleware };
```

- [ ] **Step 4: Run tests**

Run: `cd server && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/db-health.js server/db-health.test.js
git commit -m "feat: DB error classification, async handler, 503/500 error middleware"
```

---

### Task 6: Readiness latch + bounded boot retry + pool error handler

**Files:**
- Create: `server/health.js`
- Create: `server/health.test.js`
- Modify: `server/db-health.js` (add `initWithRetry`)
- Modify: `server/db.js` (remove fire-and-forget init; add `pool.on('error')`; export `initDB`)

**Interfaces:**
- Produces:
  - `health.markReady()`, `health.isReady() -> boolean`, `health.resetForTest()`.
  - `initWithRetry(initFn, opts) -> Promise<void>` — retries while `classifyDbError === 'transient'` up to `opts.maxAttempts` with backoff; throws immediately on `auth`/`other`.

- [ ] **Step 1: Write failing tests**

Create `server/health.test.js`:
```js
const { test } = require('node:test');
const assert = require('node:assert');
const health = require('./health');
const { initWithRetry } = require('./db-health');

test('readiness latch starts false, flips true, stays true', () => {
  health.resetForTest();
  assert.equal(health.isReady(), false);
  health.markReady();
  assert.equal(health.isReady(), true);
});

test('initWithRetry retries transient then succeeds', async () => {
  let n = 0;
  await initWithRetry(async () => { n++; if (n < 3) { const e = new Error('dns'); e.code = 'ENOTFOUND'; throw e; } },
    { maxAttempts: 5, baseDelayMs: 1 });
  assert.equal(n, 3);
});

test('initWithRetry fails fast on auth error', async () => {
  let n = 0;
  await assert.rejects(() => initWithRetry(async () => { n++; const e = new Error('bad pw'); e.code = '28P01'; throw e; },
    { maxAttempts: 5, baseDelayMs: 1 }));
  assert.equal(n, 1, 'should not retry auth errors');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `Cannot find module './health'`.

- [ ] **Step 3: Implement health latch**

Create `server/health.js`:
```js
const fs = require('fs');
let ready = false;

function markReady() { ready = true; }
function isReady() { return ready; }
function resetForTest() { ready = false; }

function assertThumbDirWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = require('path').join(dir, `.write-probe-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    console.log(`[Boot] THUMB_DIR writable: ${dir}`);
    return true;
  } catch (err) {
    console.error(`[Boot] WARNING: THUMB_DIR not writable (${dir}): ${err.message}`);
    return false;
  }
}

const liveHandler = (req, res) => res.status(200).json({ status: 'live' });
const readyHandler = (deps = {}) => async (req, res) => {
  if (!isReady()) return res.status(503).json({ ready: false });
  // informational only — does not affect the latch
  let db = 'up';
  try { await (deps.db || require('./db')).query('SELECT 1'); } catch { db = 'down'; }
  return res.status(200).json({ ready: true, db });
};

module.exports = { markReady, isReady, resetForTest, assertThumbDirWritable, liveHandler, readyHandler };
```

- [ ] **Step 4: Implement `initWithRetry`**

Add to `server/db-health.js` (and export it):
```js
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function initWithRetry(initFn, opts = {}) {
  const { maxAttempts = 30, baseDelayMs = 1000, maxDelayMs = 15000 } = opts;
  for (let attempt = 1; ; attempt++) {
    try { return await initFn(); }
    catch (err) {
      const kind = classifyDbError(err);
      if (kind !== 'transient' || attempt >= maxAttempts) {
        console.error(`[Boot] DB init failed (${kind}, attempt ${attempt}):`, err.code || err.message);
        throw err;
      }
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      console.warn(`[Boot] DB not ready (${err.code || err.message}); retry ${attempt} in ${delay}ms`);
      await sleep(delay);
    }
  }
}
```
Add `initWithRetry` to `module.exports`.

- [ ] **Step 5: Make `db.js` export `initDB` and stop auto-running it; add pool error handler**

In `server/db.js`:
- In the `USE_PG` branch, after creating `pool`, add: `pool.on('error', (err) => console.error('[DB] idle client error:', err.code || err.message));`
- Replace the line `initDB().catch(console.error);` with nothing (delete it).
- Change `module.exports = db;` to `module.exports = db; module.exports.initDB = initDB;`

- [ ] **Step 6: Run tests**

Run: `cd server && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/health.js server/health.test.js server/db-health.js server/db.js
git commit -m "feat: readiness latch, bounded classified boot retry, pool error handler"
```

---

### Task 7: Wire boot + health endpoints + async routes into index.js

**Files:**
- Modify: `server/index.js`
- Create: `server/integration.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1, 5, 6. `index.js` now exports `app`.

- [ ] **Step 1: Write the failing integration test**

Create `server/integration.test.js`:
```js
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const health = require('./health');

function get(server, path) {
  const { port } = server.address();
  return new Promise((resolve) => {
    http.get({ port, path }, (res) => { let b = ''; res.on('data', d => b += d); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
  });
}

test('/live always 200, /ready reflects latch', async () => {
  process.env.AUTH_PASSWORD = ''; // disable auth for the smoke test
  health.resetForTest();
  const app = require('./index'); // must export app without listening
  const server = app.listen(0);
  try {
    let r = await get(server, '/live');
    assert.equal(r.status, 200);
    r = await get(server, '/ready');
    assert.equal(r.status, 503, 'not ready before init');
    health.markReady();
    r = await get(server, '/ready');
    assert.equal(r.status, 200, 'ready after latch');
  } finally { server.close(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `app.listen is not a function` (index.js doesn't export app yet) or `/live` 404.

- [ ] **Step 3: Refactor index.js boot**

In `server/index.js`:
- Add imports near the top:
```js
const { asyncHandler, dbErrorMiddleware, initWithRetry } = require('./db-health');
const health = require('./health');
const { downloadThumbnail, DEFAULT_THUMB_DIR } = require('./thumbnails');
```
- Add health routes **before** `requireAuth` is applied to other paths (place near `/auth/check`):
```js
app.get('/live', health.liveHandler);
app.get('/ready', health.readyHandler());
```
- Replace the body of `app.get('/thumb/:postId', ...)` so the fetch/cache uses the shared helper:
```js
app.get('/thumb/:postId', asyncHandler(async (req, res) => {
  const result = await pool.query('SELECT thumbnail_url, shortcode FROM posts WHERE id = $1', [Number(req.params.postId)]);
  const post = result.rows[0];
  if (!post || !post.thumbnail_url) return res.status(404).send('No thumbnail');
  const r = await downloadThumbnail(post);
  if (r.status === 'cached') return res.sendFile(r.path);
  return res.status(502).json({ error: `thumbnail ${r.status}: ${r.error || ''}` });
}));
```
- At the very end of the file, replace the bare `app.listen(...)` block with:
```js
app.use(dbErrorMiddleware); // must be last

async function boot() {
  health.assertThumbDirWritable(DEFAULT_THUMB_DIR);
  try {
    await initWithRetry(() => pool.initDB());
    health.markReady();
    console.log('Database ready');
  } catch (err) {
    console.error('[Boot] fatal DB init error; exiting:', err.code || err.message);
    process.exit(1); // fail the deploy rather than promote a broken release
  }
}

if (require.main === module) {
  boot();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
    if (passwordHash) console.log('Auth enabled — password required'); else console.log('Auth disabled — no AUTH_PASSWORD set');
  });
}

module.exports = app;
```
- Note: `startScheduler(scraper)` at line 87 stays as-is for runtime; in test mode (`require.main !== module`) the app still imports but doesn't boot/listen.

- [ ] **Step 4: Run tests**

Run: `cd server && npm test`
Expected: PASS (`integration.test.js`).

- [ ] **Step 5: Smoke-run locally (SQLite mode)**

Run: `cd server && node index.js` then in another shell `curl -s localhost:4000/live` and `curl -s localhost:4000/ready`.
Expected: `/live` → `{"status":"live"}`; `/ready` → `{"ready":true,"db":"up"}` shortly after boot. Stop the server.

- [ ] **Step 6: Commit**

```bash
git add server/index.js server/integration.test.js
git commit -m "feat: wire health endpoints, boot retry, async error handling into app"
```

---

### Task 8: Observability counters

**Files:**
- Modify: `server/thumbnails.js` (counter logging in sweep)
- Modify: `server/db-health.js` (log DB-unavailable transitions)

**Interfaces:**
- Produces: structured `console.log` lines: `[Metric] thumbnail_sweep cached=.. expired=.. errored=.. ms=..` and `[Metric] db_unavailable` / `[Metric] db_recovered`.

- [ ] **Step 1: Write the failing test**

Add to `server/thumbnails.test.js`:
```js
test('sweep logs a metric line with timing', async () => {
  const db = { query: async (sql) => /SELECT/i.test(sql) ? { rows: [] } : { rows: [] } };
  const logs = [];
  const orig = console.log; console.log = (...a) => logs.push(a.join(' '));
  try { await sweepThumbnails({}, { db, download: async () => ({ status: 'cached' }) }); }
  finally { console.log = orig; }
  assert.ok(logs.some(l => l.includes('[Metric] thumbnail_sweep')), 'emits a metric line');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — no metric line emitted.

- [ ] **Step 3: Implement**

In `server/thumbnails.js` `sweepThumbnails`, capture `const started = Date.now();` at the start and before `return tally;` add:
```js
console.log(`[Metric] thumbnail_sweep cached=${tally.cached} expired=${tally.expired} errored=${tally.errored} attempted=${tally.attempted} ms=${Date.now() - started}`);
```
In `server/db-health.js`, add a module-level `let dbDown = false;` and in `dbErrorMiddleware`, when a transient error is seen and `!dbDown`, set `dbDown = true; console.log('[Metric] db_unavailable');`. (Recovery logging can be added when a later query succeeds; for now log on entry only — keep YAGNI.)

- [ ] **Step 4: Run tests**

Run: `cd server && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/thumbnails.js server/db-health.js
git commit -m "feat: observability metrics for sweep + db-unavailable"
```

---

### Task 9: Railway config + backups + restore drill (ops, no code)

**Files:** none (Railway dashboard / CLI). This task is a verified checklist, not a TDD cycle.

- [ ] **Step 1: Set the healthcheck path**

In the Railway dashboard → `instascraper` service → Settings → Deploy → Healthcheck Path = `/ready`; set Healthcheck Timeout to at least 60s (covers the boot-retry window).

- [ ] **Step 2: Verify after deploy**

After the next deploy completes, run:
```bash
curl -s -o /dev/null -w "%{http_code}\n" https://instascraper-production-7281.up.railway.app/ready
```
Expected: `200`. Confirm in deploy logs that a deploy with the DB intact promotes, and that `Database ready` is logged.

- [ ] **Step 3: Enable Postgres backups**

In the dashboard → `Postgres` service → Backups tab → enable scheduled (daily) backups. If the plan does not offer scheduled backups, instead add a daily `pg_dump` cron that uploads off-platform (R2/S3) — out of scope to build here; note it as a follow-up if unavailable.

- [ ] **Step 4: Restore drill**

Trigger one manual backup, then restore it into a throwaway Railway environment (or a local Postgres) and confirm row counts match production for `posts` and `tracked_accounts`. Document the result in the PR description.

- [ ] **Step 5: Commit any notes**

```bash
git commit --allow-empty -m "chore: railway healthcheck=/ready, backups enabled, restore drill done"
```

---

## Self-Review

- **Spec coverage:** 1 durable thumbnails → Tasks 1,3,4; cache columns + upsert heal → Task 2; DB resilience → Tasks 5,6; `/live`+`/ready` latch + volume check → Tasks 6,7; backups + restore → Task 9; observability → Task 8. All spec sections mapped.
- **Placeholder scan:** none — every code step shows code; Task 9 is explicitly ops with exact dashboard/CLI steps.
- **Type consistency:** `downloadThumbnail` returns `{status,path,error}` used consistently by `/thumb` (Task 7) and `sweepThumbnails` (Task 3); `initWithRetry(initFn,opts)` signature matches Task 6 use; `health.markReady/isReady/resetForTest` consistent across Tasks 6,7; `pool.initDB()` exported in Task 6 and called in Task 7.
