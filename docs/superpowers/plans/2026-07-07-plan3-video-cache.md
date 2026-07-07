# Plan 3 — Rolling Video Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make library videos play instantly and reliably for the models by caching the MP4s on the persistent Railway volume for a rolling 30-day window (auto-deleting older ones), instead of streaming Instagram's short-lived signed URLs that expire and show gray screens.

**Architecture:** Mirror the existing **thumbnail** cache exactly (`server/thumbnails.js`). A scrape marks a post's video `'pending'` the moment it refreshes the `video_url`; a **backgrounded, batched, low-concurrency** `sweepVideos` worker downloads the MP4 to the volume with per-item status + error tracking (never inline on the scrape path). A new `GET /video/:id` streams the cached file with HTTP range support; the client points `<video src>` at it. A daily `pruneOldVideos` cron deletes cached files older than 30 days ("recycle, don't stack"). This supersedes the earlier "re-resolve on demand" idea, which had 15–60s per-tap latency.

**Tech Stack:** Node + Express + `node-fetch` + `fs` (volume at `/app/server/thumbnails`) + `pg`/`better-sqlite3` (tests); React (CRA).

## Global Constraints

- **Backend tests:** `node --test` only, on extracted pure logic + fake `fs`/`fetch`/in-memory `better-sqlite3` — the exact style of `server/thumbnails.js` (which is dependency-injected: `deps.fs`, `deps.fetch`, `deps.db`, `deps.thumbDir`). Do NOT boot Express or hit the network in tests.
- **Frontend has NO test harness** — do NOT add one. Gate = `cd client && npm run build` compiles + manual check.
- **Storage:** files live on the persistent volume mounted at `/app/server/thumbnails` (50 GB). Videos go under a `videos/` subdir there: `DEFAULT_VIDEO_DIR = path.join(DEFAULT_THUMB_DIR, 'videos')`. **Never store video bytes in Postgres** (its volume is 500 MB).
- **Never download on the scrape path.** Scrape only sets `video_cache_status = 'pending'`; a fire-and-forget `sweepVideos` (batched, `concurrency ≤ 3`, jittered delay, retry-next-sweep on error) does the fetching — same shape as `sweepThumbnails`.
- **Bound the window:** only cache posts within the last 30 days; `pruneOldVideos` deletes files past that. A per-file **size guard** (skip > `VIDEO_MAX_MB`, default 60) prevents a rogue huge file.
- **Auth:** `GET /video/:id` sits behind `requireAuth` (like `/thumb`), so both admin and — once Plan 2 lands — model sessions can stream. Not `requireAdmin`.
- **Migrations:** idempotent `ADD COLUMN IF NOT EXISTS`, per `server/db.js` (with its SQLite fallback branch).
- **Base branch:** `video-cache` off `main` (the deploy branch). Commits: one per task.

---

### Task 1: Schema — video cache status columns

**Files:**
- Modify: `server/db.js` (add to the `ADD COLUMN IF NOT EXISTS` migration lists near `db.js:312` Postgres branch + the SQLite fallback branch)
- Test: `server/video-schema.test.js`

**Interfaces:**
- Produces: `posts.video_cache_status TEXT`, `posts.video_cache_error TEXT`, `posts.video_cached_at TEXT` (mirrors `thumbnail_cache_status`/`thumbnail_cache_error`).

- [ ] **Step 1: Write the failing test**

```js
// server/video-schema.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
test('video cache columns exist after the migration DDL', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE posts (id INTEGER PRIMARY KEY, shortcode TEXT)`);
  db.exec(`ALTER TABLE posts ADD COLUMN video_cache_status TEXT`);
  db.exec(`ALTER TABLE posts ADD COLUMN video_cache_error TEXT`);
  db.exec(`ALTER TABLE posts ADD COLUMN video_cached_at TEXT`);
  const cols = db.prepare(`PRAGMA table_info(posts)`).all().map(c => c.name);
  for (const c of ['video_cache_status', 'video_cache_error', 'video_cached_at']) assert.ok(cols.includes(c), `${c} missing`);
});
```

- [ ] **Step 2: Run → PASS** (`cd server && node --test video-schema.test.js`) — locks the DDL shape.

- [ ] **Step 3: Add the migrations to `db.js`**

In BOTH the `IF NOT EXISTS` Postgres list (~`db.js:312`) and the SQLite `ADD COLUMN` fallback list (~`db.js:328`), add the three columns following the existing `thumbnail_cache_status` lines exactly.

- [ ] **Step 4: Boot check** — `cd server && node -e "require('./db').initDB().then(()=>console.log('ok'))"` → `ok`.

- [ ] **Step 5: Commit** — `git commit -am "feat(video-cache): video_cache_status/error/cached_at columns"`

---

### Task 2: `videos.js` — pure helpers (path + range parser)

**Files:**
- Create: `server/videos.js`
- Test: `server/videos.test.js`

**Interfaces:**
- Produces:
  - `DEFAULT_VIDEO_DIR = path.join(DEFAULT_THUMB_DIR, 'videos')` (imported from `./thumbnails`).
  - `videoFilePath(post, videoDir?) : string` → `<videoDir>/<id>.mp4` (uses `post.id`; falls back to `post.shortcode` if no id).
  - `parseRangeHeader(header, size) : { start, end } | null` — parses `bytes=START-END` against a known `size`; supports open-ended (`bytes=1000-`) and suffix (`bytes=-500`); returns `null` for absent/invalid/unsatisfiable ranges.

- [ ] **Step 1: Write the failing test**

```js
// server/videos.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { videoFilePath, parseRangeHeader } = require('./videos');

test('videoFilePath uses id and .mp4 under the given dir', () => {
  assert.strictEqual(videoFilePath({ id: 42 }, '/data/videos'), '/data/videos/42.mp4');
});
test('parseRangeHeader: closed range', () => {
  assert.deepStrictEqual(parseRangeHeader('bytes=0-1023', 5000), { start: 0, end: 1023 });
});
test('parseRangeHeader: open-ended range clamps to size-1', () => {
  assert.deepStrictEqual(parseRangeHeader('bytes=1000-', 5000), { start: 1000, end: 4999 });
});
test('parseRangeHeader: suffix range', () => {
  assert.deepStrictEqual(parseRangeHeader('bytes=-500', 5000), { start: 4500, end: 4999 });
});
test('parseRangeHeader: absent/invalid/unsatisfiable → null', () => {
  assert.strictEqual(parseRangeHeader(undefined, 5000), null);
  assert.strictEqual(parseRangeHeader('bytes=abc', 5000), null);
  assert.strictEqual(parseRangeHeader('bytes=9999-', 5000), null); // start beyond EOF
});
```

- [ ] **Step 2: Run → FAIL** (`Cannot find module './videos'`).

- [ ] **Step 3: Implement the pure helpers in `server/videos.js`**

```js
const path = require('path');
const realFs = require('fs');
const realFetch = require('node-fetch');
const { DEFAULT_THUMB_DIR } = require('./thumbnails');

const DEFAULT_VIDEO_DIR = path.join(DEFAULT_THUMB_DIR, 'videos');
const VIDEO_MAX_MB = Number(process.env.VIDEO_MAX_MB || 60);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

function videoFilePath(post, videoDir = DEFAULT_VIDEO_DIR) {
  const key = post.id != null ? post.id : post.shortcode;
  return path.join(videoDir, `${key}.mp4`);
}

function parseRangeHeader(header, size) {
  if (!header || typeof header !== 'string') return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, a, b] = m;
  let start, end;
  if (a === '' && b === '') return null;
  if (a === '') { // suffix: last N bytes
    const n = Number(b);
    if (!n) return null;
    start = Math.max(0, size - n); end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Number(b);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return null; // unsatisfiable
  return { start, end: Math.min(end, size - 1) };
}

module.exports = { DEFAULT_VIDEO_DIR, VIDEO_MAX_MB, videoFilePath, parseRangeHeader };
```

- [ ] **Step 4: Run → PASS** (6 tests).

- [ ] **Step 5: Commit** — `git commit -am "feat(video-cache): videos.js path + range-header helpers"`

---

### Task 3: `downloadVideo` — fetch one MP4 to the volume (size-guarded, status)

**Files:**
- Modify: `server/videos.js`
- Test: `server/videos-download.test.js`

**Interfaces:**
- Consumes: `videoFilePath`, `VIDEO_MAX_MB`.
- Produces: `downloadVideo(post, deps?) : Promise<{ status: 'cached'|'expired'|'error'|'skipped', path?, error? }>` — dependency-injected (`deps.fs`, `deps.fetch`, `deps.videoDir`, `deps.inflight`), mirroring `downloadThumbnail`: return `cached` if already on disk; `expired` on 403/404; `error` on other failures; `skipped` if `content-length` > `VIDEO_MAX_MB`; dedup concurrent fetches of the same key via an in-flight map; write to a temp file then rename.

- [ ] **Step 1: Write the failing test (fake fs + fetch)**

```js
// server/videos-download.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { downloadVideo } = require('./videos');

function fakeFs(existing = {}) {
  const files = { ...existing };
  return {
    _files: files,
    statSync: (f) => { if (files[f] == null) { const e = new Error('nope'); e.code = 'ENOENT'; throw e; } return { size: files[f].length }; },
    mkdirSync: () => {}, writeFileSync: (f, buf) => { files[f] = buf; }, renameSync: (a, b) => { files[b] = files[a]; delete files[a]; },
  };
}
const okFetch = (bodyLen, headers = {}) => async () => ({
  status: 200, ok: true, headers: { get: (k) => headers[k.toLowerCase()] },
  buffer: async () => Buffer.alloc(bodyLen, 1),
});

test('downloadVideo writes the file and returns cached', async () => {
  const fs = fakeFs();
  const r = await downloadVideo({ id: 7, video_url: 'http://x/v.mp4' }, { fs, fetch: okFetch(1000, { 'content-type': 'video/mp4' }), videoDir: '/v', inflight: new Map() });
  assert.strictEqual(r.status, 'cached');
  assert.ok(fs._files['/v/7.mp4']);
});
test('downloadVideo returns expired on 403', async () => {
  const r = await downloadVideo({ id: 7, video_url: 'http://x' }, { fs: fakeFs(), fetch: async () => ({ status: 403, ok: false, headers: { get: () => null } }), videoDir: '/v', inflight: new Map() });
  assert.strictEqual(r.status, 'expired');
});
test('downloadVideo skips a file over the size cap', async () => {
  const big = String((require('./videos').VIDEO_MAX_MB + 5) * 1024 * 1024);
  const r = await downloadVideo({ id: 7, video_url: 'http://x' }, { fs: fakeFs(), fetch: okFetch(10, { 'content-length': big, 'content-type': 'video/mp4' }), videoDir: '/v', inflight: new Map() });
  assert.strictEqual(r.status, 'skipped');
});
test('downloadVideo returns cached without refetching if file exists', async () => {
  const fs = fakeFs({ '/v/7.mp4': Buffer.alloc(5) });
  let fetched = false;
  const r = await downloadVideo({ id: 7, video_url: 'http://x' }, { fs, fetch: async () => { fetched = true; return {}; }, videoDir: '/v', inflight: new Map() });
  assert.strictEqual(r.status, 'cached');
  assert.strictEqual(fetched, false);
});
```

- [ ] **Step 2: Run → FAIL.** **Step 3: implement `downloadVideo`** in `videos.js` mirroring `downloadThumbnail` (`thumbnails.js:9-48`): stat-check the file first; in-flight dedup on the key; fetch with UA + `timeout: 30000`; 403/404 → `expired`; check `content-length` header against `VIDEO_MAX_MB` → `skipped`; verify `content-type` startsWith `video/` (or empty); buffer, `mkdirSync`, temp-write, rename; return status; `finally` delete from in-flight. Add `downloadVideo` to `module.exports`.

- [ ] **Step 4: Run → PASS** (4 tests). **Step 5: Commit** — `git commit -am "feat(video-cache): downloadVideo (size-guarded, status, in-flight dedup)"`

---

### Task 4: `sweepVideos` — batched background worker (30-day window)

**Files:**
- Modify: `server/videos.js`
- Test: `server/videos-sweep.test.js`

**Interfaces:**
- Consumes: `downloadVideo`.
- Produces: `sweepVideos(opts?, deps?) : Promise<{attempted,cached,expired,skipped,errored}>` — mirrors `sweepThumbnails` (`thumbnails.js:50-106`): selects posts with `video_url IS NOT NULL AND (video_cache_status = 'pending' OR (video_cache_status IS NULL AND posted_at >= <cutoff>))`, bounded to the **last `maxAgeDays` (default 30)** and `batchLimit` (default 60), `concurrency` default **3**; updates `video_cache_status`/`video_cache_error`/`video_cached_at` per item; jittered delay between items.

- [ ] **Step 1: Write the failing test (in-memory adapter + fake download)** — assert that a `'pending'` row gets downloaded and its status updated to `'cached'`, an already-`'cached'` row is not reselected, and a NULL-status row older than the window is skipped. (Use the `db.query`→sqlite adapter pattern from `content-types-seed.test.js`; inject `deps.download` returning a canned status; inject `deps.now`.)

- [ ] **Step 2: Run → FAIL. Step 3: implement `sweepVideos`** by copying `sweepThumbnails`' structure (cutoff computation for the PG/SQLite `posted_at` format, the SELECT, the concurrency-worker pool, the per-item UPDATE, the `[Metric] video_sweep ...` log) — swapping thumbnail columns for video ones, `maxAgeDays` default 30, `concurrency` 3, and setting `video_cached_at` when status is `cached`. Add to exports.

- [ ] **Step 4: Run → PASS. Step 5: Commit** — `git commit -am "feat(video-cache): sweepVideos batched background worker"`

---

### Task 5: `pruneOldVideos` — rolling 30-day recycle

**Files:**
- Modify: `server/videos.js`
- Test: `server/videos-prune.test.js`

**Interfaces:**
- Produces: `pruneOldVideos(opts?, deps?) : Promise<{deleted}>` — deletes cached files for posts whose `posted_at < now - maxAgeDays` (default 30) OR that are soft-deleted, then clears their `video_cache_status`/`video_cached_at` (so they'd re-cache only if they re-enter the window via a fresh scrape). Dependency-injected `fs`/`db`/`videoDir`/`now`.

- [ ] **Step 1: Write the failing test** — seed two posts (one 40 days old with a cached file present in fake fs, one 5 days old); run `pruneOldVideos({maxAgeDays:30})`; assert the old file was `unlinkSync`'d and its `video_cache_status` cleared, the recent one untouched.

- [ ] **Step 2: Run → FAIL. Step 3: implement** — SELECT ids of posts past the window (or `soft_deleted = 1`) with `video_cache_status IS NOT NULL`; for each, `fs.unlinkSync(videoFilePath(post, videoDir))` (ignore ENOENT), then `UPDATE posts SET video_cache_status = NULL, video_cached_at = NULL`. Log `[Metric] video_prune deleted=N`. Add to exports.

- [ ] **Step 4: Run → PASS. Step 5: Commit** — `git commit -am "feat(video-cache): pruneOldVideos rolling recycle"`

---

### Task 6: `GET /video/:id` — stream cached file with range support

**Files:**
- Modify: `server/index.js` (register `app.use('/video', requireAuth)` alongside `/thumb` at ~`index.js:106`; add the handler near the `/thumb/:postId` handler)

**Interfaces:**
- Consumes: `videoFilePath`, `parseRangeHeader`, `DEFAULT_VIDEO_DIR`.
- Produces: `GET /video/:id` — if the cached file exists: stream it, honoring `Range` (206 + `Content-Range`/`Accept-Ranges: bytes` when ranged, else 200 with `Content-Length`), `Content-Type: video/mp4`. If not cached but the post has a `video_url`: `302` redirect to it (best-effort while the cache fills). Else `404`.

- [ ] **Step 1: Add the auth prefix + handler.** Register `app.use('/video', requireAuth);`. Handler:

```js
const { videoFilePath, parseRangeHeader, DEFAULT_VIDEO_DIR } = require('./videos');
app.get('/video/:id', asyncHandler(async (req, res) => {
  const r = await pool.query('SELECT id, video_url FROM posts WHERE id = $1', [Number(req.params.id)]);
  const post = r.rows[0];
  if (!post) return res.status(404).send('not found');
  const file = videoFilePath(post, DEFAULT_VIDEO_DIR);
  let size = 0;
  try { size = fs.statSync(file).size; } catch { size = 0; }
  if (!size) { // not cached yet → best-effort fall back to the (maybe still fresh) source
    if (post.video_url) return res.redirect(302, post.video_url);
    return res.status(404).send('no video');
  }
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Accept-Ranges', 'bytes');
  const range = parseRangeHeader(req.headers.range, size);
  if (range) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    res.setHeader('Content-Length', range.end - range.start + 1);
    fs.createReadStream(file, { start: range.start, end: range.end }).pipe(res);
  } else {
    res.setHeader('Content-Length', size);
    fs.createReadStream(file).pipe(res);
  }
}));
```

(`fs` and `asyncHandler`/`pool` already exist in `index.js`.)

- [ ] **Step 2: Manual verify** — cache one video (run a sweep locally against a seeded post, or drop a small mp4 at `videos/<id>.mp4`), then `curl -s -D- -o /dev/null "localhost:4000/video/<id>" -H 'Range: bytes=0-99'` → `206 Partial Content` with `Content-Range: bytes 0-99/<size>`; a plain GET → `200` with `Content-Length`; an uncached id with a `video_url` → `302`. Document.

- [ ] **Step 3: Commit** — `git commit -am "feat(video-cache): GET /video/:id with HTTP range support"`

---

### Task 7: Enqueue at scrape time + post-scrape sweep

**Files:**
- Modify: `server/scraper.js` (the posts INSERT/upsert at ~`scraper.js:549-569`; the post-scrape sweep call at ~`scraper.js:602`)

**Interfaces:**
- Produces: a scrape sets `video_cache_status = 'pending'` whenever it writes a fresh `video_url` (insert AND `ON CONFLICT DO UPDATE`), and fires `sweepVideos({batchLimit:60})` fire-and-forget after the scrape — mirroring the existing `thumbnail_cache_status = 'pending'` + `sweepThumbnails(...)` lines.

- [ ] **Step 1:** In the posts `INSERT ... ON CONFLICT (shortcode) DO UPDATE` (`scraper.js:549`), add `video_cache_status = 'pending'` to the `DO UPDATE SET` list (next to the existing `thumbnail_cache_status = 'pending'`), and include it in the INSERT column list/values so new rows start `'pending'`. **Step 2:** after the existing `sweepThumbnails(...)` fire-and-forget (`scraper.js:602`), add `require('./videos').sweepVideos({ batchLimit: 60 }).catch(err => console.error('[Sweep] post-scrape video sweep failed:', err.message));`.
- [ ] **Step 3: Verify** the full backend suite still passes (`cd server && node --test` → green; the scraper's existing tests must not regress). **Step 4: Commit** — `git commit -am "feat(video-cache): enqueue video caching on scrape + post-scrape sweep"`

---

### Task 8: Daily prune cron

**Files:**
- Modify: `server/scheduler.js` (add a cron alongside the existing `cron.schedule('0 3 * * *', ...)` at ~`scheduler.js:347`)

**Interfaces:**
- Produces: a daily job calling `pruneOldVideos({ maxAgeDays: 30 })`.

- [ ] **Step 1:** Add `cron.schedule('30 3 * * *', () => require('./videos').pruneOldVideos({ maxAgeDays: 30 }).catch(e => console.error('[Cron] video prune failed:', e.message)));` near the existing daily cron. **Step 2:** boot check the scheduler module loads (`node -e "require('./scheduler')"`). **Step 3: Commit** — `git commit -am "feat(video-cache): daily rolling prune cron"`

---

### Task 9: Frontend — serve video from the cache

**Files:**
- Modify: `client/src/components/ContentCard.js`

**Interfaces:**
- Produces: the autoplay/tap-to-play `<video src>` points at `${API_URL}/video/${cardId}` (with credentials via the existing cookie session) instead of the raw `post.video_url`. The poster/`videoFailed` fallback (already shipped) stays — a not-yet-cached video that also has a dead source `video_url` will 302→403→`onError`→thumbnail, exactly as now.

- [ ] **Step 1:** Compute `const videoSrc = cardId ? \`${API_URL}/video/${cardId}\` : post.video_url;` near `thumbnailSrc`, and set the `<video src={videoSrc}>`. Keep `poster={thumbnailSrc}` and `onError`. **Step 2:** `cd client && npm run build` → compiles. **Step 3: Manual (mobile):** with a few videos cached, confirm they play instantly from `/video/:id` (Network tab shows `206`s), and uncached-but-fresh ones still play via the 302 fallback, dead ones show the thumbnail. **Step 4: Commit** — `git commit -am "feat(video-cache): play video from /video/:id cache"`

---

## Self-Review

**Spec coverage:** cache-at-scrape-time (enqueue) → Task 7; background batched download → Tasks 3–4; serve with range → Task 6; rolling 30-day recycle → Tasks 5, 8; client uses the cache → Task 9; schema → Task 1; pure helpers → Task 2. Codex CX-001 (don't download inline) is honored: Task 7 only marks `'pending'`; all fetching is in the backgrounded `sweepVideos`.

**Placeholder scan:** none — pure-logic tasks carry full code; the sweep/prune tasks point at the exact `thumbnails.js` structure to copy plus the concrete column/param changes; endpoint + frontend carry full code and concrete manual checks.

**Type consistency:** `video_cache_status`/`video_cache_error`/`video_cached_at` (Task 1) are written by `sweepVideos` (4), cleared by `pruneOldVideos` (5), set `'pending'` by the scraper (7); `videoFilePath`/`parseRangeHeader` (2) are consumed by `downloadVideo` (3) and `/video/:id` (6); `DEFAULT_VIDEO_DIR` is one definition imported everywhere.

## Verification (end-to-end)

- Backend `node --test` green (new video-* suites + no regression). 
- Trigger a scrape (or set a recent post's `video_cache_status='pending'`), run `sweepVideos`, confirm an `.mp4` lands under `/app/server/thumbnails/videos/` and `video_cache_status='cached'`.
- `curl` `/video/:id` with and without a `Range` header → `206`/`200`; uncached-with-url → `302`.
- On a phone: cached videos play **instantly** (no gray, no warm-up); scrolling is smooth; after 30 days (or a manual `pruneOldVideos({maxAgeDays:0})` in a dev DB) the files are deleted and status cleared.
- Watch volume usage (`railway volume` / `df`) stays bounded across a few scrape+prune cycles.

## Execution Handoff

Plan 3 saved. Optionally run `/codex-review` (it touches storage, a streaming endpoint, and a background worker) before executing subagent-driven like Plan 1. Targets branch `video-cache` off `main` (the deploy branch).
