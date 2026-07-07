# Plan 3 — Rolling Video Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make library videos play instantly and reliably for the models by caching the MP4s on the persistent Railway volume for a rolling 30-day window (auto-deleting older ones), instead of streaming Instagram's short-lived signed URLs that expire and show gray screens.

**Architecture:** Mirror the existing **thumbnail** cache (`server/thumbnails.js`) closely, adapting three things for video's larger size and freshness semantics. A scrape marks a post's video `'pending'` the moment it refreshes the `video_url`; a **backgrounded, batched, low-concurrency** `sweepVideos` worker streams the MP4 to the volume with per-item status + error tracking (never inline on the scrape path). A new `GET /video/:id` serves the cached file via `res.sendFile` (Express handles Range/206/416/stream-errors natively); the client points `<video src>` at it. A daily `pruneOldVideos` cron deletes cached files for posts older than 30 days ("recycle, don't stack"). This supersedes the earlier "re-resolve on demand" idea, which had 15–60s per-tap latency.

**Tech Stack:** Node + Express (`res.sendFile`) + `node-fetch` (streamed body) + `fs` (volume at `/app/server/thumbnails`) + `pg`/`better-sqlite3` (tests); React (CRA).

> **↳ Codex-review (2 rounds) shaped this plan.** Round 1: 9 findings incorporated, 2 rejected. Round 2: 10 further findings, ALL incorporated (marked `[R2-n]` inline). Full argument in `2026-07-07-plan3-video-cache-REVIEW-LOG.md`. The only standing rejections are Round-1 #4 (cross-process DB lease — over-engineered for a single-instance deploy; the URL-guarded UPDATE removes the real harm) and #7's *removal* of the 302 fallback (kept but now gated to the genuinely-fresh case per R2-1).

## Global Constraints

- **Backend tests:** `node --test` only, on extracted pure logic + fake `fs`/`fetch`/in-memory `better-sqlite3` — the exact style of `server/thumbnails.js` (dependency-injected: `deps.fs`, `deps.fetch`, `deps.db`, `deps.videoDir`, `deps.now`, `deps.inflight`). Do NOT boot Express or hit the network in tests. Use the `db.query(sql, params)`→sqlite adapter from `server/content-types-seed.test.js` for DB-touching helpers. **One justified exception [R2-6]:** `downloadVideo`'s streaming path is tested against a REAL temp directory (`os.tmpdir()`, cleaned up) with a real `stream.Readable` body — a fake `fs` cannot faithfully model write-stream flush/backpressure, and getting rename-after-flush right is the whole point of that task.
- **Frontend has NO test harness** — do NOT add one. Gate = `cd client && npm run build` compiles + manual check.
- **Storage:** files live on the persistent volume mounted at `/app/server/thumbnails` (50 GB). Videos go under a `videos/` subdir there: `DEFAULT_VIDEO_DIR = path.join(DEFAULT_THUMB_DIR, 'videos')`. **Never store video bytes in Postgres** (its volume is 500 MB).
- **Never download on the scrape path.** Scrape only sets `video_cache_status = 'pending'`; a fire-and-forget `sweepVideos` (batched, `concurrency ≤ 3`, jittered delay, retry-next-sweep on error) does the fetching — same shape as `sweepThumbnails`.
- **Freshness vs. retention are two different windows [CX-1, CX-2, R2-3, R2-4, R3-2, R3-3]:**
  - **Freshness** governs whether a signed `video_url` is worth attempting or 302-ing to. The signal is a dedicated column **`video_url_refreshed_at`**, written = `new Date().toISOString()` at EVERY scrape enqueue (Task 7, both insert paths, insert AND on-conflict). **Why a new column and not `scraped_at` [R3-3]:** the main upsert does NOT update `scraped_at` on conflict (`scraper.js:671`), so a re-scraped post keeps a stale `scraped_at` while its `video_url` is fresh; and `scraped_at` has a downstream consumer (`scheduler.js:203` cleans up untagged posts older than 30d) that we must not perturb. **Why not "pending is fresh" [R3-2]:** an ineligible row (null/out-of-window `posted_at`) is marked `pending` by the scraper but never swept, so `pending` would read as fresh forever and 302 a long-dead URL indefinitely. `video_url_refreshed_at >= freshnessCutoff` is the correct, self-expiring signal used by BOTH the sweep's legacy-row gate and the route's 302 gate.
  - **Retention** bounds storage: only cache posts whose `posted_at` is within the last 30 days. Gate the selector by `posted_at IS NOT NULL AND posted_at >= retentionCutoff`. [R2-3] Rows with `posted_at IS NULL` are NOT cached at all — prune keys off `posted_at < cutoff` and could never reclaim a null-`posted_at` file, so caching one would leak forever. Null `posted_at` (a malformed/timestamp-less reel, rare) still plays via the 302-fresh fallback while its URL lives, then shows the poster. This keeps the cached set exactly equal to the prunable set.
  - **Both cutoffs are ISO-Z [R2-4 simplified]:** `posted_at` (scraper `.toISOString()`, `scraper.js:632`) and `video_url_refreshed_at` (JS `.toISOString()`, Task 7) are BOTH full ISO `…T…Z` in Postgres AND SQLite. So `retentionCutoff = new Date(now - maxAgeDays*86400000).toISOString()` and `freshnessCutoff = new Date(now - freshnessDays*86400000).toISOString()` — one format, both backends. (Switching freshness off `scraped_at` onto `video_url_refreshed_at` removed the earlier PG-vs-SQLite `scraped_at` format split entirely.)
- **Size guard streams, never buffers unbounded [CX-6]:** `downloadVideo` streams the response body to a temp file while counting bytes and aborts + unlinks the moment the running total exceeds `VIDEO_MAX_MB` (default 60). This enforces the cap even when `content-length` is absent or lies, and never loads a whole MP4 into memory. (Thumbnails buffer because images are tiny; videos must not.)
- **Serve via `res.sendFile`, not hand-rolled streaming [CX-8, CX-9, CX-15]:** the cached-file response uses `res.sendFile(file, { acceptRanges: true }, errCb)`. Express's `send` handles `Range` (206 + `Content-Range`/`Accept-Ranges`), unsatisfiable ranges (`416 bytes */size`), `Content-Type` from the `.mp4` extension, and passes any stream error (including a TOCTOU unlink between stat and open) to `errCb` so a missing file becomes a clean `404` instead of an uncaught crash. No custom `createReadStream` or range parser.
- **Auth:** `GET /video/:id` sits behind `requireAuth` via `app.use('/video', requireAuth)` (exactly like `/thumb` at `index.js:107`), so both admin and — once Plan 2 lands — model sessions can stream. Not `requireAdmin`. **Cookie flow [CX-12, R2-9]:** the client calls `${API_URL}/video/:id`, and in production the Docker build bakes `REACT_APP_API_URL=https://instascraper-production-7281.up.railway.app` — the **same host that serves the SPA** (`express.static(clientBuild)`, `index.js:928`). So the request is first-party/same-site and the session cookie flows automatically, exactly as it already does for the working `${API_URL}/thumb/:id` reference (`ContentCard.js:76`). No CORS/`crossorigin` needed. `<video>` sends cookies for same-origin `src` by default. (Locally, `API_URL` is `http://localhost:4000` = the dev API, so it works there too.)
- **Input validation [R2-10, R4-4]:** `GET /video/:id` validates `id` with `Number.isSafeInteger(id) && id > 0 && id <= 2147483647` before querying — rejecting both non-numeric (`/video/abc`) and out-of-int4-range values (which would overflow Postgres's integer comparison) with a `404`, never a DB error.
- **Migrations:** idempotent `ADD COLUMN IF NOT EXISTS`, per `server/db.js` (with its SQLite fallback branch).
- **Base branch:** `video-cache` off `main` (the deploy branch). Commits: one per task.

---

### Task 1: Schema — video cache columns (exported FULL migration array, in-memory-testable)

**Files:**
- Modify: `server/db.js` — (a) hoist the SQLite-branch migration array (currently inline at `db.js:335-347`) to a module-level `const SQLITE_MIGRATIONS` and export it; (b) add FOUR video columns to BOTH the Postgres `ADD COLUMN IF NOT EXISTS` list (after `db.js:323`) and that exported SQLite array.
- Test: `server/video-schema.test.js`

**Interfaces:**
- Produces: `posts.video_cache_status TEXT`, `posts.video_cache_error TEXT`, `posts.video_cached_at TEXT`, `posts.video_url_refreshed_at TEXT`; and `db.SQLITE_MIGRATIONS` (exported `string[]` — the EXACT statement list the else-branch of `initDB` iterates).

> **[R3-1] Export the WHOLE array, not a `posts`-only subset.** The inline SQLite `migrations` array (`db.js:335`) is MIXED-TABLE — it also migrates `scrape_jobs`, `suggested_accounts`, and `tracked_accounts`. A refactor that extracts a posts-only array would DROP those other-table migrations and break a fresh SQLite schema. Hoist the array **verbatim** (every line, same order) and only APPEND the four new posts lines.

> **[CX-13, R2-5] The test exercises the REAL statements, in-memory.** A test that writes its own DDL is vacuous (passes even if `db.js` is untouched); calling `initDB()` mutates the hardcoded on-disk dev DB `server/instascraper.db` (`db.js:23`). Instead run the exported array against a throwaway `:memory:` DB whose only real table is `posts` — the other-table `ALTER`s throw "no such table" and are tolerated alongside "duplicate column", so the test still meaningfully asserts the four `posts` video columns land. (`require('./db')` opens the dev DB connection as a pre-existing, harmless side effect — like `radar.test.js` — but runs no schema change.)

- [ ] **Step 1: Refactor `db.js` — hoist + export the full array verbatim.** Move the inline `const migrations = [ … ]` (all 11 lines at `db.js:335-347`) to module scope as `const SQLITE_MIGRATIONS = [ … ]` (do NOT drop or reorder any line — it spans four tables), point the else-branch loop at it (`for (const sql of SQLITE_MIGRATIONS)`), and export it: `module.exports.SQLITE_MIGRATIONS = SQLITE_MIGRATIONS;`.

- [ ] **Step 2: Write the failing test — runs the exported array against `:memory:`**

```js
// server/video-schema.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { SQLITE_MIGRATIONS } = require('./db');

test('SQLITE_MIGRATIONS adds the four video columns to posts', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE posts (id INTEGER PRIMARY KEY, shortcode TEXT)`);
  for (const sql of SQLITE_MIGRATIONS) {
    // Tolerate other-table statements (no such table) and re-runs (duplicate column).
    try { db.exec(sql); } catch (e) { if (!/duplicate column|no such table/i.test(e.message)) throw e; }
  }
  const cols = db.prepare(`PRAGMA table_info(posts)`).all().map(c => c.name);
  for (const c of ['video_cache_status', 'video_cache_error', 'video_cached_at', 'video_url_refreshed_at']) {
    assert.ok(cols.includes(c), `${c} missing from the real migration array`);
  }
});
```

- [ ] **Step 3: Run → FAIL** (`cd server && node --test video-schema.test.js`) — `video_cache_status missing…`, because Step 1 only hoisted the array. Proves the test is non-vacuous.

- [ ] **Step 4: Append the FOUR columns to BOTH lists.** In the exported `SQLITE_MIGRATIONS` (append) AND the Postgres `IF NOT EXISTS` list (after `db.js:323`):

```js
// SQLITE_MIGRATIONS (append — posts only):
`ALTER TABLE posts ADD COLUMN video_cache_status TEXT`,
`ALTER TABLE posts ADD COLUMN video_cache_error TEXT`,
`ALTER TABLE posts ADD COLUMN video_cached_at TEXT`,
`ALTER TABLE posts ADD COLUMN video_url_refreshed_at TEXT`,
// Postgres branch (near db.js:322):
`ALTER TABLE posts ADD COLUMN IF NOT EXISTS video_cache_status TEXT`,
`ALTER TABLE posts ADD COLUMN IF NOT EXISTS video_cache_error TEXT`,
`ALTER TABLE posts ADD COLUMN IF NOT EXISTS video_cached_at TEXT`,
`ALTER TABLE posts ADD COLUMN IF NOT EXISTS video_url_refreshed_at TEXT`,
```

- [ ] **Step 5: Run → PASS**. Also boot check: `cd server && node -e "delete process.env.DATABASE_URL; require('./db').initDB().then(()=>console.log('ok'))"` → `ok`.

- [ ] **Step 6: Commit** — `git commit -am "feat(video-cache): 4 video cache columns via exported full migration array (in-memory tested)"`

---

### Task 2: `videos.js` — pure path helper + unique temp path

**Files:**
- Create: `server/videos.js`
- Test: `server/videos.test.js`

**Interfaces:**
- Produces:
  - `DEFAULT_VIDEO_DIR = path.join(DEFAULT_THUMB_DIR, 'videos')` (imported from `./thumbnails`).
  - `VIDEO_MAX_MB` (env `VIDEO_MAX_MB`, default 60).
  - `videoFilePath(post, videoDir?) : string` → `<videoDir>/<id>.mp4` (uses `post.id`; falls back to `post.shortcode` if no id).
  - `tempVideoPath(key, videoDir?) : string` → a unique temp path `<videoDir>/<key>.<pid>.<ts>.<rand>.tmp`. [R2-7] Because in-flight keys now include the URL (Task 3), two same-`id`/different-`url` downloads can run concurrently and compute this in the same millisecond — so it MUST include `crypto.randomUUID()` (or `crypto.randomBytes(6).toString('hex')`), not just `pid + Date.now()`, or the two writers collide on one temp file.

> **[CX-8, CX-15] No `parseRangeHeader`.** The earlier draft hand-rolled a range parser; `res.sendFile` (Task 6) makes it dead code. Dropped. `videos.js` holds only the path helpers plus the download/sweep/prune functions added in Tasks 3–5.

- [ ] **Step 1: Write the failing test**

```js
// server/videos.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { videoFilePath, tempVideoPath, VIDEO_MAX_MB } = require('./videos');

test('videoFilePath uses id and .mp4 under the given dir', () => {
  assert.strictEqual(videoFilePath({ id: 42 }, '/data/videos'), '/data/videos/42.mp4');
});
test('videoFilePath falls back to shortcode when no id', () => {
  assert.strictEqual(videoFilePath({ shortcode: 'ABC' }, '/data/videos'), '/data/videos/ABC.mp4');
});
test('tempVideoPath is unique-ish and lives under the dir', () => {
  const a = tempVideoPath(42, '/data/videos');
  assert.ok(a.startsWith('/data/videos/42.'));
  assert.ok(a.endsWith('.tmp'));
});
test('VIDEO_MAX_MB defaults to 60', () => {
  assert.strictEqual(VIDEO_MAX_MB, 60);
});
```

- [ ] **Step 2: Run → FAIL** (`Cannot find module './videos'`).

- [ ] **Step 3: Implement the pure helpers in `server/videos.js`**

```js
const path = require('path');
const crypto = require('crypto');
const realFs = require('fs');
const realFetch = require('node-fetch');
const { DEFAULT_THUMB_DIR } = require('./thumbnails');

const DEFAULT_VIDEO_DIR = path.join(DEFAULT_THUMB_DIR, 'videos');
const VIDEO_MAX_MB = Number(process.env.VIDEO_MAX_MB || 60);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const sharedInflight = new Map();

function videoFilePath(post, videoDir = DEFAULT_VIDEO_DIR) {
  const key = post.id != null ? post.id : post.shortcode;
  return path.join(videoDir, `${key}.mp4`);
}

function tempVideoPath(key, videoDir = DEFAULT_VIDEO_DIR) {
  // [R2-7] crypto suffix: concurrent same-id/different-url writers must not collide.
  return path.join(videoDir, `${key}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`);
}

module.exports = { DEFAULT_VIDEO_DIR, VIDEO_MAX_MB, videoFilePath, tempVideoPath };
```

- [ ] **Step 4: Run → PASS** (4 tests).

- [ ] **Step 5: Commit** — `git commit -am "feat(video-cache): videos.js path + unique-temp helpers"`

---

### Task 3: `downloadVideo` — stream one MP4 to the volume (byte-capped, status)

**Files:**
- Modify: `server/videos.js`
- Test: `server/videos-download.test.js`

**Interfaces:**
- Consumes: `videoFilePath`, `tempVideoPath`, `VIDEO_MAX_MB`.
- Produces: `downloadVideo(post, deps?) : Promise<{ status: 'cached'|'expired'|'error'|'skipped', path?, error? }>` — dependency-injected (`deps.fs`, `deps.fetch`, `deps.videoDir`, `deps.inflight`), mirroring `downloadThumbnail` (`thumbnails.js:9-48`) with three video-specific changes:
  - **In-flight key includes the URL [CX-5]:** `inflightKey = \`${key}:${post.video_url}\`` so a re-scrape that swaps in a fresh `video_url` starts a NEW download instead of reusing the stale-URL promise.
  - **Streamed byte cap via `stream.pipeline` [CX-6, R2-6]:** pipe `res.body` through a byte-counting `Transform` into `fs.createWriteStream(tmp)` using `stream.pipeline` (so the promise resolves only after the write stream has flushed/closed — the rename happens AFTER flush, never before). The Transform errors the pipeline (`destroy(new Error('too_big'))`) the moment the running total exceeds `VIDEO_MAX_MB * 1024 * 1024`; catch that specific error, `unlinkSync` the temp, return `skipped`. Never `res.buffer()`. If `content-length` is present and already over the cap, short-circuit to `skipped` before streaming.
  - **Rename only after pipeline resolves:** `await pipeline(...)` then `fs.renameSync(tmp, final)`. On ANY pipeline error, `unlinkSync` the temp (ignore ENOENT) and return `error` (or `skipped` for the too_big sentinel).

  Behavior: return `cached` if the final file already exists on disk (stat > 0); `expired` on 403/404; `error` on other non-ok / stream failures; `skipped` if over the size cap (by header OR by streamed bytes); `finally` delete the in-flight entry.

> **[R2-6] Test against a REAL temp dir, not a fake fs.** A fake `createWriteStream` cannot model flush ordering or backpressure — the exact thing that must be correct here. Use `os.tmpdir()` (a fresh subdir per test, `rmSync` in cleanup) as `videoDir`, real `fs`, and a `fetch` mock whose `.body` is a real `stream.Readable.from([...buffers])`. Assert on the real bytes on disk. This is the sanctioned exception in Global Constraints.

- [ ] **Step 1: Write the failing tests (real temp dir + real Readable body)** — all four outcomes AND the risky paths [CX-14, R2-6]:

```js
// server/videos-download.test.js
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { downloadVideo, VIDEO_MAX_MB } = require('./videos');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vidtest-'));
after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} });

// fetch mock: body is a REAL Readable so pipeline/flush behave like production.
function fetchOf({ status = 200, headers = {}, chunks = [Buffer.alloc(1000, 1)] } = {}) {
  return async () => ({
    status, ok: status >= 200 && status < 300,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    body: Readable.from(chunks),
  });
}

test('downloadVideo streams to disk and returns cached (bytes present, flushed)', async () => {
  const r = await downloadVideo({ id: 1, video_url: 'http://x/v.mp4' },
    { fs, fetch: fetchOf({ headers: { 'content-type': 'video/mp4' }, chunks: [Buffer.alloc(1000, 1), Buffer.alloc(1000, 2)] }), videoDir: DIR, inflight: new Map() });
  assert.strictEqual(r.status, 'cached');
  assert.strictEqual(fs.statSync(path.join(DIR, '1.mp4')).size, 2000); // proves flush-before-rename
});
test('downloadVideo returns expired on 403', async () => {
  const r = await downloadVideo({ id: 2, video_url: 'http://x' },
    { fs, fetch: fetchOf({ status: 403 }), videoDir: DIR, inflight: new Map() });
  assert.strictEqual(r.status, 'expired');
});
test('downloadVideo skips when content-length exceeds the cap', async () => {
  const big = String((VIDEO_MAX_MB + 5) * 1024 * 1024);
  const r = await downloadVideo({ id: 3, video_url: 'http://x' },
    { fs, fetch: fetchOf({ headers: { 'content-length': big, 'content-type': 'video/mp4' } }), videoDir: DIR, inflight: new Map() });
  assert.strictEqual(r.status, 'skipped');
  assert.ok(!fs.existsSync(path.join(DIR, '3.mp4')));
});
test('downloadVideo skips a too-big body with NO content-length [CX-6, R2-6]', async () => {
  const oneMB = Buffer.alloc(1024 * 1024, 1);
  const chunks = Array.from({ length: VIDEO_MAX_MB + 2 }, () => oneMB); // exceeds cap, no header
  const r = await downloadVideo({ id: 4, video_url: 'http://x' },
    { fs, fetch: fetchOf({ headers: { 'content-type': 'video/mp4' }, chunks }), videoDir: DIR, inflight: new Map() });
  assert.strictEqual(r.status, 'skipped');
  assert.ok(!fs.existsSync(path.join(DIR, '4.mp4')), 'temp cleaned up, no final file');
});
test('downloadVideo returns error on an empty (0-byte) 200 body [R3-4]', async () => {
  const r = await downloadVideo({ id: 9, video_url: 'http://x' },
    { fs, fetch: fetchOf({ headers: { 'content-type': 'video/mp4' }, chunks: [] }), videoDir: DIR, inflight: new Map() });
  assert.strictEqual(r.status, 'error');
  assert.ok(!fs.existsSync(path.join(DIR, '9.mp4')), 'no 0-byte file left behind');
});
test('downloadVideo returns cached without refetching if file exists', async () => {
  fs.writeFileSync(path.join(DIR, '5.mp4'), Buffer.alloc(5));
  let fetched = false;
  const r = await downloadVideo({ id: 5, video_url: 'http://x' },
    { fs, fetch: async () => { fetched = true; return {}; }, videoDir: DIR, inflight: new Map() });
  assert.strictEqual(r.status, 'cached');
  assert.strictEqual(fetched, false);
});
test('downloadVideo dedups concurrent fetches of the same id+url [CX-5]', async () => {
  let calls = 0;
  const slow = async () => { calls++; await new Promise(r => setTimeout(r, 20)); return { status: 200, ok: true, headers: { get: () => null }, body: Readable.from([Buffer.alloc(10, 1)]) }; };
  const inflight = new Map();
  const post = { id: 6, video_url: 'http://x/v.mp4' };
  const [a, b] = await Promise.all([downloadVideo(post, { fs, fetch: slow, videoDir: DIR, inflight }), downloadVideo(post, { fs, fetch: slow, videoDir: DIR, inflight })]);
  assert.strictEqual(a.status, 'cached');
  assert.strictEqual(b.status, 'cached');
  assert.strictEqual(calls, 1, 'same id+url fetched once');
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `downloadVideo`** in `videos.js`. Skeleton (adapt to match `downloadThumbnail`'s deps handling):

```js
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');
// …inside downloadVideo, after the fetch + status/header checks:
const cap = VIDEO_MAX_MB * 1024 * 1024;
const cl = Number(res.headers.get('content-length'));
if (Number.isFinite(cl) && cl > cap) return { status: 'skipped', error: `content-length ${cl} > cap` };
const ctype = res.headers.get('content-type') || '';
if (ctype && !ctype.startsWith('video/')) return { status: 'error', error: `bad content-type ${ctype}` };
fs.mkdirSync(videoDir, { recursive: true });
const tmp = tempVideoPath(key, videoDir);
let seen = 0;
const cap$ = new Transform({ transform(chunk, _enc, cb) { seen += chunk.length; if (seen > cap) return cb(new Error('too_big')); cb(null, chunk); } });
try {
  await pipeline(res.body, cap$, fs.createWriteStream(tmp));
  if (seen === 0) {                    // [R3-4] empty-body guard (mirrors thumbnails.js:33)
    try { fs.unlinkSync(tmp); } catch { /* ENOENT ok */ }
    return { status: 'error', error: 'empty body' };
  }
  fs.renameSync(tmp, file);            // only after flush, only if non-empty
  return { status: 'cached', path: file };
} catch (err) {
  try { fs.unlinkSync(tmp); } catch { /* ENOENT ok */ }
  if (err.message === 'too_big') return { status: 'skipped', error: 'stream over cap' };
  return { status: 'error', error: err.message };
}
```

Wrap the whole thing in the in-flight-dedup IIFE from `downloadThumbnail` keyed on `inflightKey`, with `finally { inflight.delete(inflightKey); }`. Add `downloadVideo` to `module.exports`.

- [ ] **Step 4: Run → PASS** (7 tests). **Step 5: Commit** — `git commit -am "feat(video-cache): downloadVideo (pipeline byte-cap, url-scoped in-flight dedup)"`

---

### Task 4: `sweepVideos` — batched background worker (freshness + retention windows)

**Files:**
- Modify: `server/videos.js`
- Test: `server/videos-sweep.test.js`

**Interfaces:**
- Consumes: `downloadVideo`.
- Produces: `sweepVideos(opts?, deps?) : Promise<{attempted,cached,expired,skipped,errored}>` — mirrors `sweepThumbnails` (`thumbnails.js:50-106`) with the corrected selector and a URL-guarded update.

**Selector [CX-1, CX-2, R2-3, R3-3] — retention on `posted_at` (non-null), freshness on `video_url_refreshed_at`:**

```sql
SELECT id, shortcode, video_url FROM posts
WHERE video_url IS NOT NULL
  AND posted_at IS NOT NULL AND posted_at >= $retentionCutoff       -- retention: bound storage; null posted_at NEVER cached (unprunable)
  AND ( video_cache_status = 'pending'                              -- freshly re-scraped URL: always try
        OR (video_cache_status IS NULL AND video_url_refreshed_at >= $freshnessCutoff) )  -- legacy: only if URL still fresh
ORDER BY id DESC LIMIT $batchLimit
```

- **[R2-4, R3-3] Both cutoffs are JS-computed ISO-Z — one format, both backends:**
  - `retentionCutoff = new Date(now - maxAgeDays*86400000).toISOString()` — `posted_at` is stored via `.toISOString()` in both backends (scraper.js:632).
  - `freshnessCutoff = new Date(now - freshnessDays*86400000).toISOString()` — gates on `video_url_refreshed_at` (also a JS `.toISOString()` value, Task 7), NOT `scraped_at`. Legacy pre-migration rows have `video_url_refreshed_at IS NULL` → the NULL-status branch selects none of them (correct — their URLs are long expired); every current-scraped row is `pending` and swept via the first branch. This is why the old PG-vs-SQLite `scraped_at` format split is gone.
- `maxAgeDays` default 30, `freshnessDays` default 14, `concurrency` default **3**, `batchLimit` default **60**, jittered `delay` between items.

**Per-item UPDATE is URL-guarded [CX-3]:** capture the `video_url` used for each selected row; when writing status back, guard the UPDATE so a slow download can't clobber a row that was re-scraped (new URL) mid-flight:

```sql
UPDATE posts SET video_cache_status = $1, video_cache_error = $2,
  video_cached_at = CASE WHEN $1 = 'cached' THEN $3 ELSE video_cached_at END
WHERE id = $4 AND video_url = $5     -- $5 = the URL this worker actually downloaded
```

If `video_url` changed since selection, 0 rows update and the row stays `'pending'` → the next sweep re-downloads with the fresh URL. Log `[Metric] video_sweep cached=.. expired=.. skipped=.. errored=.. attempted=.. ms=..`.

- [ ] **Step 1: Write the failing test (in-memory adapter + fake download)** [CX-14] — assert:
  1. a `'pending'` row within retention gets downloaded and its status set to `'cached'` with `video_cached_at` populated;
  2. an already-`'cached'` row is not reselected;
  3. a `NULL`-status row with a `video_url_refreshed_at` older than `freshnessDays` (or NULL) is NOT selected;
  4. a `'pending'` row whose `posted_at` is older than `maxAgeDays` is NOT selected (retention gate);
  5. **[R2-3]** a `'pending'` row whose `posted_at IS NULL` is NOT selected (never cache the unprunable);
  6. **stale-URL race [CX-3]:** when the row's `video_url` is changed between selection and the status write (simulate by having the fake `download` mutate the row's URL, or by asserting the UPDATE carries `WHERE ... AND video_url = <selected>`), the status write does NOT overwrite — the row remains `'pending'`.

  Use the `db.query`→sqlite adapter from `content-types-seed.test.js`; inject `deps.download` returning a canned `{status}`; inject `deps.now`; inject `deps.delay = () => Promise.resolve()` to avoid real timers.

- [ ] **Step 2: Run → FAIL. Step 3: implement `sweepVideos`** by copying `sweepThumbnails`' structure (dual cutoff formatting, the concurrency worker pool, per-item try/catch) and swapping in the selector + URL-guarded UPDATE above, `maxAgeDays` 30 / `freshnessDays` 14 / `concurrency` 3, and the `video_*` columns. Add to exports.

- [ ] **Step 4: Run → PASS. Step 5: Commit** — `git commit -am "feat(video-cache): sweepVideos (retention+freshness windows, url-guarded update)"`

---

### Task 5: `pruneOldVideos` — rolling 30-day recycle

**Files:**
- Modify: `server/videos.js`
- Test: `server/videos-prune.test.js`

**Interfaces:**
- Produces: `pruneOldVideos(opts?, deps?) : Promise<{deleted}>` — deletes cached files for posts whose `posted_at < now - maxAgeDays` (default 30), then clears their `video_cache_status`/`video_cached_at`. Dependency-injected `fs`/`db`/`videoDir`/`now`.

**Two-phase `pruning` claim [CX-10, R2-2, R3-5].** Two failure modes pull in opposite directions: unlink-before-clear orphans the file if the DB write fails; clear-before-unlink orphans the file if `unlinkSync` fails with a non-ENOENT error (status is already NULL → prune never reselects → leaked forever). Resolve both with an intermediate `'pruning'` status that is self-healing:

```sql
-- Phase 1 (claim): atomically move eligible rows out of "cached/pending" into "pruning".
UPDATE posts SET video_cache_status = 'pruning', video_cached_at = NULL
WHERE id = $1 AND posted_at < $cutoff AND video_cache_status IS NOT NULL AND video_cache_status <> 'pruning'
-- Phase 2: only if Phase 1 changed the row, unlink the file (ignore ENOENT).
-- Phase 3: on unlink success OR confirmed ENOENT, finalize:
UPDATE posts SET video_cache_status = NULL WHERE id = $1 AND video_cache_status = 'pruning'
```

- A `'pruning'` row is served as **not cached** by `/video/:id` and is **not fresh** (`videoUrlIsFresh` returns false), so it shows the poster during deletion. The sweep never reselects it (it's neither `pending` nor `NULL`).
- **[R4-1] Reclaiming an already-`'pruning'` orphan.** The SELECT reselects `video_cache_status IS NOT NULL`, which INCLUDES a row stuck at `'pruning'` from an interrupted prior run. But Phase 1 excludes `<> 'pruning'`, so it would change 0 rows for such an orphan → without special handling it's reselected forever, never reclaimed. Fix: **select the current status; if it is already `'pruning'`, SKIP Phase 1 and go straight to unlink + Phase 3.** Only rows that are NOT yet `'pruning'` need the Phase-1 claim (and must skip on 0 changes = raced).
- On a non-ENOENT unlink error, skip Phase 3 (leave it `'pruning'`) and log — the next run reselects and retries. No orphaned file, no zombie-cached row.

- [ ] **Step 1: Write the failing test** [CX-14, R2-2, R3-5, R4-1] — seed two posts (one 40 days old with a cached file present, one 5 days old); run `pruneOldVideos({maxAgeDays:30})`; assert the old file was `unlinkSync`'d and its status ended `NULL`, the recent one untouched; assert a missing file (ENOENT) still finalizes to `NULL` and does not throw; **assert an already-`'pruning'` orphan (status `'pruning'`, file present) IS reclaimed to `NULL` and its file unlinked** (this is the R4-1 case — it must not require a fresh Phase-1 claim); assert a simulated non-ENOENT unlink error leaves status `'pruning'` (retryable), not `NULL`.

- [ ] **Step 2: Run → FAIL. Step 3: implement** — `SELECT id, video_cache_status FROM posts WHERE posted_at < cutoff AND video_cache_status IS NOT NULL`; for each row:

```js
if (row.video_cache_status !== 'pruning') {
  const claim = await db.query(
    `UPDATE posts SET video_cache_status='pruning', video_cached_at=NULL
     WHERE id=$1 AND posted_at < $2 AND video_cache_status IS NOT NULL AND video_cache_status <> 'pruning'`,
    [row.id, cutoff]);
  if ((claim.rowCount || claim.changes || 0) === 0) continue;   // raced / already handled
}
// row is now 'pruning' (freshly claimed OR pre-existing orphan) → delete + finalize
try { fs.unlinkSync(videoFilePath(row, videoDir)); }
catch (e) { if (e.code !== 'ENOENT') { console.error('[Prune] unlink failed', e.code); continue; } }
await db.query(`UPDATE posts SET video_cache_status=NULL WHERE id=$1 AND video_cache_status='pruning'`, [row.id]);
deleted++;
```

Log `[Metric] video_prune deleted=N` (rows finalized to NULL). Add to exports.

- [ ] **Step 4: Run → PASS. Step 5: Commit** — `git commit -am "feat(video-cache): pruneOldVideos rolling recycle (guarded clear)"`

---

### Task 6: `GET /video/:id` — serve cached file via `res.sendFile`

**Files:**
- Modify: `server/index.js` — register `app.use('/video', requireAuth);` alongside `/thumb` at `index.js:107`; add the handler near the `/thumb/:postId` handler (`index.js:906`).
- Test: `server/video-route.test.js` (extracted-handler unit test [CX-12])

**Interfaces:**
- Consumes: `videoFilePath`, `DEFAULT_VIDEO_DIR`.
- Produces: `GET /video/:id` — validates `id` [R2-10, R4-4]; serves the cached file with `res.sendFile` (Express handles `Range`→206/416, `Content-Type`, `Accept-Ranges`, stream errors via the callback) UNLESS the row is `'pruning'` [R4-2] (mid-delete → treat as uncached). If not served, `302` to `video_url` **only when `video_url_refreshed_at` is within the freshness window** [R2-1, R3-2]; for a stale/absent refresh time return `404` so the shipped poster wins immediately with no wasted `302→403`. Else `404`.

> **[CX-9] TOCTOU is handled by `res.sendFile`'s error callback.** If prune unlinks the file between the `statSync` check and the send, `sendFile` invokes `errCb(err)`; we translate any post-headers error to a best-effort `404` (guarded by `res.headersSent`). No uncaught stream crash.

- [ ] **Step 1: Add the auth prefix + handler.** Add `app.use('/video', requireAuth);` next to `index.js:107`. Handler:

```js
const { videoFilePath, DEFAULT_VIDEO_DIR } = require('./videos');

// [R2-1, R3-2, R3-3] Worth 302-ing the raw IG URL? Only if it was refreshed recently.
// Reads video_url_refreshed_at — NOT status (pending is eternal) and NOT scraped_at
// (stale on re-scrape). Self-expiring: a pending row refreshed 20d ago is NOT fresh.
function videoUrlIsFresh(post, freshnessDays = 14) {
  if (!post.video_url_refreshed_at) return false;
  const cutoff = new Date(Date.now() - freshnessDays * 86400000).toISOString();
  return post.video_url_refreshed_at >= cutoff;
}

app.get('/video/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  // [R2-10, R4-4] reject non-ids AND values past Postgres int4 max (would overflow the comparison)
  if (!Number.isSafeInteger(id) || id <= 0 || id > 2147483647) return res.status(404).send('not found');
  const r = await pool.query(
    'SELECT id, video_url, video_url_refreshed_at, video_cache_status FROM posts WHERE id = $1', [id]);
  const post = r.rows[0];
  if (!post) return res.status(404).send('not found');
  const file = videoFilePath(post, DEFAULT_VIDEO_DIR);
  let cached = false;
  // [R4-2] a 'pruning' row's file is mid-delete — do not serve it; fall through to poster.
  if (post.video_cache_status !== 'pruning') {
    try { cached = fs.statSync(file).size > 0; } catch { cached = false; }
  }
  if (cached) {
    return res.sendFile(file, { acceptRanges: true }, (err) => {
      if (err && !res.headersSent) res.status(404).end();      // TOCTOU / vanished file
    });
  }
  if (post.video_url && videoUrlIsFresh(post)) return res.redirect(302, post.video_url);  // [R2-1] gated
  return res.status(404).send('no video');    // known-dead or absent → client shows poster
}));
```

(`fs`, `asyncHandler`, `pool` already exist in `index.js`; `res.sendFile` is already used at `index.js:911`.)

- [ ] **Step 2: Write the extracted-handler test [CX-12, R2-1, R2-10, R3-6]** — export `videoUrlIsFresh` so it's unit-testable without booting Express, and test with **real row-shaped objects that use the actual field name `video_url_refreshed_at`** (the function reads that, not `status` — a test passing `{status:'pending'}` would test nothing): (a) `{ video_url_refreshed_at: new Date().toISOString() }` → true; (b) `{ video_url_refreshed_at: new Date(Date.now() - 30*86400000).toISOString() }` → false (aged out → poster, not a 302); (c) `{ video_url_refreshed_at: null }` → false; (d) a `pending` row whose `video_url_refreshed_at` is 20 days old → false (proves `pending` is NOT treated as eternally fresh, [R3-2]). Also unit-test id validation — `Number('abc')`/`0`/`-1` short-circuit to 404 before any `pool.query`. Factor the handler body into a small `serveVideo(post, { fs, videoDir, res })`-style function if that makes the sendFile/302/404 branches testable with fake `res`/`fs`; otherwise `videoUrlIsFresh` + id-validation units plus the Step-3 curls are the gate. (Auth is enforced by the `app.use('/video', requireAuth)` prefix, identical to `/thumb`, at `index.js:107`.)

- [ ] **Step 3: Manual verify** — cache one video (seed a post + run a sweep locally, or drop a small mp4 at `videos/<id>.mp4`), then:
  - `curl -s -D- -o /dev/null "localhost:4000/video/<id>" -H 'Range: bytes=0-99'` → `206 Partial Content`, `Content-Range: bytes 0-99/<size>`, `Accept-Ranges: bytes`.
  - `curl -s -D- -o /dev/null "localhost:4000/video/<id>" -H 'Range: bytes=999999999-'` → `416 Range Not Satisfiable` (Express handles this — proves [CX-8]).
  - Plain GET → `200` + `Content-Length` + `Content-Type: video/mp4`.
  - An uncached id with a `video_url` → `302`. Document the results.

- [ ] **Step 4: Commit** — `git commit -am "feat(video-cache): GET /video/:id via res.sendFile (native range/416/TOCTOU-safe)"`

---

### Task 7: Enqueue at scrape time (BOTH insert paths) + post-scrape sweep

**Files:**
- Modify: `server/scraper.js` — the main upsert (`scraper.js:668-681`), the URL-import insert (`scraper.js:1113-1116`), and the post-scrape sweep call.

**Interfaces:**
- Produces: **every** post-insert path that writes a fresh `video_url` sets `video_cache_status = 'pending'` [CX-11] AND `video_url_refreshed_at = <nowIso>` [R3-2, R3-3], and a `sweepVideos({batchLimit:60})` fires fire-and-forget after the scrape — mirroring the existing `thumbnail_cache_status = 'pending'` + `sweepThumbnails(...)`.

> **[CX-11] There are TWO insert paths.** `scraper.js:668` is the main `ON CONFLICT DO UPDATE` upsert (both INSERT values AND the `DO UPDATE SET` clause must set the two columns — a re-scrape must refresh `video_url_refreshed_at` even though the row already exists). `scraper.js:1113` is the URL-import `INSERT ... ON CONFLICT DO NOTHING` — only the INSERT column list/values need them (a conflict is a no-op). **Compute one `const nowIso = new Date().toISOString();` per scrape and bind it** — do NOT use a SQL `NOW()`/`CURRENT_TIMESTAMP` default (those render in different formats per backend, reintroducing the R2-4 mismatch).

> **Placeholder renumbering:** both INSERTs currently list 15 columns (`$1..$15`); adding `video_cache_status` + `video_url_refreshed_at` makes them 17 (`$1..$17`). Renumber carefully and add the two values to each params array.

- [ ] **Step 1: Main upsert (`scraper.js:668`).** Add `video_cache_status` and `video_url_refreshed_at` to the INSERT column list + values (`'pending'`, `nowIso`); add BOTH `video_cache_status = 'pending'` and `video_url_refreshed_at = EXCLUDED.video_url_refreshed_at` (or `= $N` bound to `nowIso`) to the `ON CONFLICT (shortcode) DO UPDATE SET` list, next to the existing `thumbnail_cache_status = 'pending'` (`scraper.js:681`).

- [ ] **Step 2: URL-import insert (`scraper.js:1113`).** Add `video_cache_status` (`'pending'`) and `video_url_refreshed_at` (`nowIso`) to that INSERT's column list + values (`DO NOTHING`, so no `SET` change).

- [ ] **Step 3: Post-scrape sweep — in BOTH scrape methods [R2-8].** The main flow's `sweepThumbnails(...)` fire-and-forget is at `scraper.js:720`; add the video sweep right after it. But `importByUrls` returns at `scraper.js:1132` and has NO sweep of its own — so add the SAME line just before its `return { imported, ... }`, or the URL-imported rows sit `'pending'` until some unrelated future scrape happens to sweep them. Add in both places:

```js
require('./videos').sweepVideos({ batchLimit: 60 })
  .catch(err => console.error('[Sweep] post-scrape video sweep failed:', err.message));
```

(The sweep selects ALL eligible `pending` rows, not just this scrape's, so either call drains stragglers — but both paths must kick it so imports aren't stranded.)

- [ ] **Step 4: Verify** the full backend suite still passes (`cd server && node --test` → green; the scraper's existing tests must not regress). **Step 5: Commit** — `git commit -am "feat(video-cache): enqueue on BOTH insert paths + sweep after main scrape AND importByUrls"`

---

### Task 8: Daily prune cron

**Files:**
- Modify: `server/scheduler.js` (add a cron alongside the existing `cron.schedule('0 3 * * *', ...)` at ~`scheduler.js:347`)

**Interfaces:**
- Produces: a daily job calling `pruneOldVideos({ maxAgeDays: 30 })`.

- [ ] **Step 1:** Add near the existing daily cron:

```js
cron.schedule('30 3 * * *', () =>
  require('./videos').pruneOldVideos({ maxAgeDays: 30 })
    .catch(e => console.error('[Cron] video prune failed:', e.message)));
```

- [ ] **Step 2:** Boot check the scheduler module loads (`cd server && node -e "require('./scheduler'); console.log('ok')"`). **Step 3: Commit** — `git commit -am "feat(video-cache): daily rolling prune cron"`

---

### Task 9: Frontend — serve video from the cache

**Files:**
- Modify: `client/src/components/ContentCard.js`

**Interfaces:**
- Produces: the autoplay/tap-to-play `<video src>` points at `${API_URL}/video/${cardId}` instead of the raw `post.video_url`. [R2-9] This uses the SAME `${API_URL}/…` base as the already-working authed `${API_URL}/thumb/${cardId}` at `ContentCard.js:76` — in production `API_URL` is baked to `https://instascraper-production-7281.up.railway.app` (the host that serves the SPA), so the request is first-party and the session cookie flows; locally it's `http://localhost:4000` (the dev API). No new origin, no CORS. The poster/`videoFailed` fallback (already shipped) stays: an uncached video whose row is stale/dead returns `404` (or an expired 302 target 403s) → `onError` → thumbnail, exactly as now.

- [ ] **Step 1:** Compute `const videoSrc = cardId ? \`${API_URL}/video/${cardId}\` : post.video_url;` near `thumbnailSrc` (same `API_URL` the thumbnail uses), and set `<video src={videoSrc}>`. Keep `poster={thumbnailSrc}` and the `onError` → `videoFailed` handler.

- [ ] **Step 2:** `cd client && npm run build` → compiles.

- [ ] **Step 3: Manual (mobile):** with a few videos cached, confirm they play instantly from `/video/:id` (Network tab shows `206`s on scrub), uncached-but-fresh ones still play via the 302 fallback, dead ones show the thumbnail.

- [ ] **Step 4: Commit** — `git commit -am "feat(video-cache): play video from /video/:id cache"`

---

## Self-Review

**Spec coverage:** cache-at-scrape-time (enqueue, both paths) → Task 7; background batched download → Tasks 3–4; serve with native range → Task 6; rolling 30-day recycle → Tasks 5, 8; client uses the cache → Task 9; schema → Task 1; pure helpers → Task 2. Codex CX-001 (don't download inline) is honored: Task 7 only marks `'pending'`; all fetching is in the backgrounded `sweepVideos`.

**Round-1 Codex findings — disposition:**
- Incorporated: CX-1/2 (freshness=`scraped_at` + retention=`posted_at`, Task 4), CX-3 (URL-guarded UPDATE, Task 4), CX-5 (in-flight key includes URL, Task 3), CX-6 (streamed byte cap, Task 3), CX-8/9/15 (`res.sendFile`, drop range parser, Tasks 2+6), CX-10 (guarded prune clear, Task 5), CX-11 (both insert paths, Task 7), CX-12 (route/auth test + cookie note, Task 6 + Global Constraints), CX-13 (real-migration test, Task 1), CX-14 (the missing risky-path tests, Tasks 3/4/5/6).
- Rejected (rationale in the review log): CX-4 (cross-process `pending→downloading` lease — over-engineered for a single-instance Railway deploy; CX-3+CX-5 remove the real harms; matches the proven `thumbnails.js` pattern) and CX-7's *removal* of the 302 (kept but gated per R2-1).

**Round-2 Codex findings — ALL incorporated:**
- R2-1 (gate the 302 to genuinely-fresh rows, else 404→poster, Task 6), R2-2 (prune claim/unlink ordering → superseded by the R3-5 two-phase claim, Task 5), R2-3 (never cache null-`posted_at` — keeps cached set == prunable set, Task 4 + Global Constraints), R2-4 (cutoff formats — simplified by R3-3 to both ISO-Z, Task 4 + Global Constraints), R2-5 (export the migration array, test it in-memory — no disk side-effect, Task 1 + db.js refactor), R2-6 (`stream.pipeline` + byte-counting Transform, tested against a real temp dir, Task 3), R2-7 (crypto suffix in `tempVideoPath`, Task 2), R2-8 (fire the sweep after `importByUrls` too, Task 7), R2-9 (cookie flow grounded in the baked prod origin, mirrors the working `/thumb` reference, Task 9 + Global Constraints), R2-10 (validate `id` before querying, Task 6).

**Round-3 Codex findings — ALL incorporated:**
- R3-1 (export the FULL mixed-table SQLite migration array, not a posts-only subset that would drop scrape_jobs/suggested_accounts/tracked_accounts migrations, Task 1), R3-2 + R3-3 (add a dedicated `video_url_refreshed_at` column as the freshness signal — `pending` is eternal and `scraped_at` doesn't update on re-scrape / has a `scheduler.js:203` consumer; used by both the sweep legacy-gate and the route 302-gate, Tasks 1/4/6/7 + Global Constraints), R3-4 (empty-body guard `seen > 0`, Task 3), R3-5 (two-phase `'pruning'` claim — self-healing against both a failed unlink and a failed clear, Task 5), R3-6 (test `videoUrlIsFresh` with the real `video_url_refreshed_at` field, not a phantom `status`, Task 6).

**Placeholder scan:** none — pure-logic tasks carry full code; the sweep/prune tasks give the exact selector/UPDATE SQL plus the `thumbnails.js` structure to copy; the endpoint + frontend carry full code and concrete manual checks. The one implementer-judgment seam (fake-stream modeling in Task 3) is explicitly bounded with a required test outcome.

**Type consistency:** the four columns (Task 1) — `video_cache_status`/`video_cache_error`/`video_cached_at`/`video_url_refreshed_at` — are: set (`'pending'` + `nowIso`) by the scraper (7), written (`cached`/`expired`/`skipped`/`error`) by `sweepVideos` (4), transitioned through `'pruning'`→`NULL` by `pruneOldVideos` (5). `video_url_refreshed_at` is the freshness signal read by both the sweep legacy-gate (4) and `videoUrlIsFresh` (6). `videoFilePath`/`tempVideoPath` (2) are consumed by `downloadVideo` (3) and `/video/:id` (6); `DEFAULT_VIDEO_DIR` is one definition imported everywhere. Both cutoffs (retention on `posted_at`, freshness on `video_url_refreshed_at`) are JS `.toISOString()` values → one ISO-Z format across backends. No `parseRangeHeader` anywhere (dropped).

## Verification (end-to-end)

- Backend `node --test` green (new `video-*` suites + no regression).
- Trigger a scrape (or set a recent post's `video_cache_status='pending'`), run `sweepVideos`, confirm an `.mp4` lands under `/app/server/thumbnails/videos/` and `video_cache_status='cached'` with `video_cached_at` set.
- `curl` `/video/:id`: with `Range: bytes=0-99` → `206`; with a beyond-EOF range → `416`; plain → `200`; uncached-with-url → `302`.
- On a phone: cached videos play **instantly** (no gray, no warm-up); scrubbing works (range requests); after 30 days (or a manual `pruneOldVideos({maxAgeDays:0})` in a dev DB) the files are deleted and status cleared.
- Watch volume usage (`railway volume` / `df`) stays bounded across a few scrape+prune cycles.

## Execution Handoff

Plan 3 saved and Codex-reviewed (Round 1 REVISE → incorporated). Execute subagent-driven like Plan 1. Targets branch `video-cache` off `main` (the deploy branch).
