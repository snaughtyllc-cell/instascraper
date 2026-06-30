# Engagement Honesty + Collab-Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop storing a fake `0` for views when Apify returns no play count (show "unknown"/`—`), and persist per-post collaborator tags so discovery can mine them from reels already in the DB.

**Architecture:** Two pure, exported helpers in `server/scraper.js` (`extractViews`, `normalizeTaggedUsers`/`parseTaggedUsers`) used by the two existing insert paths and by `discoverRelated` Phase-1. One new nullable `posts.tagged_users TEXT` column via the existing dual-mode migration list. Client renders `—` for unknown views via a small per-file `formatViews` formatter. No new dependencies.

**Tech Stack:** Node.js, Express, dual-mode DB layer (`pg` in prod / `better-sqlite3` in dev+test), React (CRA) client, `node:test` runner.

## Global Constraints

- **Test runner:** `node --test` — run from `server/` with `npm test`. Test files are `server/*.test.js`.
- **Pure helpers** are top-level functions in `scraper.js`, exported via `module.exports.<name> = <name>` (alongside `classifyGenderKeyword`, `parseGenderBatch`, etc. at the bottom of the file), and imported in tests via `const scraper = require('./scraper')`.
- **DB portability:** every SQL string must work under both Postgres and SQLite (the `db.query` shim converts `$n`→`?` and strips PG-isms). `NULLS LAST` is supported by both engines (verified: Postgres + SQLite 3.51.3). New columns go in **both** arms of the migration list in `db.js`.
- **Storage formats:** unknown views → SQL `NULL` (never `0`). `tagged_users` → `JSON.stringify(string[])` or `NULL` when empty.
- **YAGNI / DRY / TDD / frequent commits.** No shares/reposts work (confirmed unavailable from Apify).
- **No backfill** of `tagged_users` on existing rows (impossible without re-scrape) — forward-looking only.

---

### Task 1: Honest views — `extractViews` helper, both write paths, sort, client display

**Files:**
- Modify: `server/scraper.js` — add `extractViews(item)` near `calcER` (~L9); export it (~L863 block); use it at the two `const views = item.videoPlayCount || item.videoViewCount || 0;` sites (`_fetchAndStoreResults` ~L453 and `importByUrls` ~L813).
- Modify: `server/index.js:160` — `sortMap.most_viewed` gets `NULLS LAST`.
- Modify: `client/src/components/ContentCard.js` — add `formatViews`, use for `post.view_count` (~L142).
- Modify: `client/src/pages/DeleteLogTab.js` — add `formatViews`, use for `entry.view_count` (~L123).
- Create: `server/views-honesty.test.js`.

**Interfaces:**
- Produces: `extractViews(item) → number | null` — returns `item.videoPlayCount` if it is a finite number, else `item.videoViewCount` if finite, else `null`. A genuine `0` returns `0` (not `null`).

- [ ] **Step 1: Write the failing test**

Create `server/views-honesty.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { extractViews } = require('./scraper');

test('extractViews: prefers videoPlayCount when present', () => {
  assert.strictEqual(extractViews({ videoPlayCount: 1234, videoViewCount: 5 }), 1234);
});

test('extractViews: falls back to videoViewCount', () => {
  assert.strictEqual(extractViews({ videoViewCount: 77 }), 77);
});

test('extractViews: genuine zero stays 0, not null', () => {
  assert.strictEqual(extractViews({ videoPlayCount: 0 }), 0);
});

test('extractViews: no view field → null (unknown, not fake 0)', () => {
  assert.strictEqual(extractViews({ likesCount: 10 }), null);
  assert.strictEqual(extractViews({}), null);
  assert.strictEqual(extractViews({ videoPlayCount: null, videoViewCount: undefined }), null);
});

test('extractViews: ignores non-numeric junk', () => {
  assert.strictEqual(extractViews({ videoPlayCount: 'NaN' }), null);
});

test('most_viewed ORDER BY puts NULL views last (dual-engine guard)', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE posts (shortcode TEXT, view_count INTEGER)');
  db.exec("INSERT INTO posts VALUES ('a', 500), ('b', NULL), ('c', 2000)");
  const rows = db.prepare('SELECT shortcode FROM posts ORDER BY view_count DESC NULLS LAST').all();
  assert.deepStrictEqual(rows.map(r => r.shortcode), ['c', 'a', 'b']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npm test -- views-honesty.test.js` (or `node --test views-honesty.test.js`)
Expected: FAIL — `extractViews` is not a function / undefined.

- [ ] **Step 3: Add the `extractViews` helper**

In `server/scraper.js`, immediately after the `calcER` function (~L17), add:

```js
// Views: Apify's reel actor returns a real videoPlayCount; the generic actor
// (URL imports + small-result fallback) returns no view field at all. Return
// null ("unknown") in that case so we never store a fake 0.
function extractViews(item) {
  const play = item && item.videoPlayCount;
  if (typeof play === 'number' && Number.isFinite(play)) return play;
  const view = item && item.videoViewCount;
  if (typeof view === 'number' && Number.isFinite(view)) return view;
  return null;
}
```

- [ ] **Step 4: Export it**

In the `module.exports` block at the bottom of `server/scraper.js` (after `module.exports.hasActiveJob = hasActiveJob;`), add:

```js
module.exports.extractViews = extractViews;
```

- [ ] **Step 5: Use it in both write paths**

In `_fetchAndStoreResults` replace (~L453):

```js
      const views = item.videoPlayCount || item.videoViewCount || 0;
```
with:
```js
      const views = extractViews(item);
```

In `importByUrls` replace the identical line (~L813) with the same `const views = extractViews(item);`. (Both then bind `views` into the existing `view_count` INSERT param — no further change; the column is nullable.)

- [ ] **Step 6: Run helper tests to verify they pass**

Run: `cd server && node --test views-honesty.test.js`
Expected: PASS (all 6 tests).

- [ ] **Step 7: Add `NULLS LAST` to the most_viewed sort**

In `server/index.js:160`, change:

```js
  const sortMap = { newest: 'posted_at DESC', oldest: 'posted_at ASC', most_viewed: 'view_count DESC', most_liked: 'like_count DESC', highest_er: 'er_percent DESC', lowest_er: 'er_percent ASC' };
```
to (only `most_viewed` changes):
```js
  const sortMap = { newest: 'posted_at DESC', oldest: 'posted_at ASC', most_viewed: 'view_count DESC NULLS LAST', most_liked: 'like_count DESC', highest_er: 'er_percent DESC', lowest_er: 'er_percent ASC' };
```

- [ ] **Step 8: Client — render `—` for unknown views**

In `client/src/components/ContentCard.js`, add directly below the existing `formatCount` function (~L26):

```js
function formatViews(n) {
  if (n === null || n === undefined) return '—';
  return formatCount(n);
}
```
Then change the views span (~L142) from `{formatCount(post.view_count)}` to `{formatViews(post.view_count)}`.

In `client/src/pages/DeleteLogTab.js`, add the same `formatViews` helper below its local `formatCount` (~L9) and change `{formatCount(entry.view_count)}` (~L123) to `{formatViews(entry.view_count)}`.

- [ ] **Step 9: Verify client builds**

Run: `cd client && npm run build`
Expected: `Compiled successfully` (no new warnings about `formatViews`).

- [ ] **Step 10: Commit**

```bash
git add server/scraper.js server/index.js server/views-honesty.test.js client/src/components/ContentCard.js client/src/pages/DeleteLogTab.js
git commit -m "feat(engagement): store unknown views as null, render as —

Generic Apify actor (URL imports + <=3-item fallback) returns no play/view
field; stop coercing to a fake 0. extractViews() returns null when absent;
most_viewed sort uses NULLS LAST; client shows — for unknown."
```

---

### Task 2: `tagged_users` column + write persistence in both paths

**Files:**
- Modify: `server/db.js` — add `tagged_users` to both arms of the migration list (~L270-287).
- Modify: `server/scraper.js` — add `normalizeTaggedUsers(item)` helper + export; bind it into both INSERTs (`_fetchAndStoreResults` ~L489-508, `importByUrls` ~L826-845).
- Create: `server/collab-capture.test.js`.

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `normalizeTaggedUsers(item) → string[] | null` — pulls handles from `item.taggedUsers || item.usertags` (entries may be strings, `{username}`, or `{user:{username}}`), lowercases, trims a leading `@`, de-dupes, drops `ownerHandle` when given, returns `null` when empty. Signature: `normalizeTaggedUsers(item, ownerHandle = '')`.

- [ ] **Step 1: Write the failing test**

Create `server/collab-capture.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { normalizeTaggedUsers } = require('./scraper');

test('normalizeTaggedUsers: array of strings', () => {
  assert.deepStrictEqual(normalizeTaggedUsers({ taggedUsers: ['Alice', '@Bob'] }), ['alice', 'bob']);
});

test('normalizeTaggedUsers: array of {username} objects', () => {
  assert.deepStrictEqual(
    normalizeTaggedUsers({ taggedUsers: [{ username: 'Cara' }, { username: 'dee' }] }),
    ['cara', 'dee']
  );
});

test('normalizeTaggedUsers: nested {user:{username}} (usertags shape)', () => {
  assert.deepStrictEqual(
    normalizeTaggedUsers({ usertags: [{ user: { username: 'Eve' } }] }),
    ['eve']
  );
});

test('normalizeTaggedUsers: de-dupes and drops owner', () => {
  assert.deepStrictEqual(
    normalizeTaggedUsers({ taggedUsers: ['x', 'X', 'owner'] }, 'owner'),
    ['x']
  );
});

test('normalizeTaggedUsers: empty / missing / junk → null', () => {
  assert.strictEqual(normalizeTaggedUsers({}), null);
  assert.strictEqual(normalizeTaggedUsers({ taggedUsers: [] }), null);
  assert.strictEqual(normalizeTaggedUsers({ taggedUsers: [{}, { user: {} }, 42] }), null);
});

test('posts.tagged_users round-trips as JSON, null stays null (sqlite)', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE posts (shortcode TEXT UNIQUE, tagged_users TEXT)');
  const ins = db.prepare('INSERT INTO posts (shortcode, tagged_users) VALUES (?, ?)');
  const tags = normalizeTaggedUsers({ taggedUsers: ['alice', 'bob'] });
  ins.run('p1', tags ? JSON.stringify(tags) : null);
  ins.run('p2', normalizeTaggedUsers({}) ? '' : null);
  const r1 = db.prepare('SELECT tagged_users FROM posts WHERE shortcode = ?').get('p1');
  const r2 = db.prepare('SELECT tagged_users FROM posts WHERE shortcode = ?').get('p2');
  assert.deepStrictEqual(JSON.parse(r1.tagged_users), ['alice', 'bob']);
  assert.strictEqual(r2.tagged_users, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test collab-capture.test.js`
Expected: FAIL — `normalizeTaggedUsers` is not a function.

- [ ] **Step 3: Add the `normalizeTaggedUsers` helper**

In `server/scraper.js`, after `extractViews` (added in Task 1), add:

```js
// Collaborators: the reel actor returns taggedUsers/usertags per post. Extract
// a clean, de-duped list of handles so discovery can mine collab partners later.
function normalizeTaggedUsers(item, ownerHandle = '') {
  const raw = (item && (item.taggedUsers || item.usertags)) || [];
  if (!Array.isArray(raw)) return null;
  const owner = (ownerHandle || '').toLowerCase();
  const out = [];
  const seen = new Set();
  for (const entry of raw) {
    let handle = '';
    if (typeof entry === 'string') handle = entry;
    else if (entry && typeof entry === 'object') handle = entry.username || (entry.user && entry.user.username) || '';
    handle = String(handle || '').trim().replace(/^@/, '').toLowerCase();
    if (!handle || handle === owner || seen.has(handle)) continue;
    seen.add(handle);
    out.push(handle);
  }
  return out.length ? out : null;
}
```

- [ ] **Step 4: Export it**

In the `module.exports` block, after `module.exports.extractViews = extractViews;`, add:

```js
module.exports.normalizeTaggedUsers = normalizeTaggedUsers;
```

- [ ] **Step 5: Run helper tests to verify they pass**

Run: `cd server && node --test collab-capture.test.js`
Expected: PASS (all 6 tests).

- [ ] **Step 6: Add the migration column (both arms)**

In `server/db.js`, in the **Postgres** arm of the migration list (the block with `ADD COLUMN IF NOT EXISTS`, after the `suggested_accounts ... gender` line ~L275), add:

```js
      `ALTER TABLE posts ADD COLUMN IF NOT EXISTS tagged_users TEXT DEFAULT NULL`,
```

In the **SQLite** arm (the plain `ADD COLUMN` block, after the matching `suggested_accounts ... gender` line ~L287), add:

```js
      `ALTER TABLE posts ADD COLUMN tagged_users TEXT DEFAULT NULL`,
```

(The SQLite arm is already wrapped in try/catch for idempotency — re-running on an existing column is a no-op error that is swallowed, matching the sibling lines.)

- [ ] **Step 7: Persist tags in `_fetchAndStoreResults`**

In `_fetchAndStoreResults`, inside the `for (const item of items)` loop, just before the `const post = { ... }` object, compute the JSON:

```js
      const taggedHandles = normalizeTaggedUsers(item, item.ownerUsername || item.owner?.username || '');
      const taggedJson = taggedHandles ? JSON.stringify(taggedHandles) : null;
```

Then change the INSERT (~L489) — add `tagged_users` as the final column, `$15` as the final value, `tagged_users = EXCLUDED.tagged_users` to the `DO UPDATE SET`, and `taggedJson` as the final bind param:

```js
        const insertResult = await pool.query(`
          INSERT INTO posts (shortcode, video_url, thumbnail_url, caption, like_count, comment_count,
            view_count, posted_at, account_handle, post_url, source_query, followers_at_scrape, er_percent, er_label, tagged_users)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
          ON CONFLICT (shortcode) DO UPDATE SET
            thumbnail_url = EXCLUDED.thumbnail_url,
            video_url = EXCLUDED.video_url,
            like_count = EXCLUDED.like_count,
            comment_count = EXCLUDED.comment_count,
            view_count = EXCLUDED.view_count,
            followers_at_scrape = EXCLUDED.followers_at_scrape,
            er_percent = EXCLUDED.er_percent,
            er_label = EXCLUDED.er_label,
            tagged_users = EXCLUDED.tagged_users,
            thumbnail_cache_status = 'pending'
        `, [
          post.shortcode, post.videoUrl, post.thumbnailUrl, post.caption,
          post.likeCount, post.commentCount, post.viewCount, post.postedAt,
          post.accountHandle, post.postUrl, post.sourceQuery,
          post.followersAtScrape, post.erPercent, post.erLabel, taggedJson,
        ]);
```

- [ ] **Step 8: Persist tags in `importByUrls`**

In `importByUrls`, inside its `for (const item of items)` loop, just before the `const shortcode = ...` line (~L825), add:

```js
      const taggedHandles = normalizeTaggedUsers(item, item.ownerUsername || item.owner?.username || '');
      const taggedJson = taggedHandles ? JSON.stringify(taggedHandles) : null;
```

Then change its INSERT (~L828) — add `tagged_users` column, `$15`, and `taggedJson` as the final bind param (ON CONFLICT stays `DO NOTHING`):

```js
        const insertResult = await pool.query(`
          INSERT INTO posts (shortcode, video_url, thumbnail_url, caption, like_count, comment_count,
            view_count, posted_at, account_handle, post_url, source_query, followers_at_scrape, er_percent, er_label, tagged_users)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
          ON CONFLICT (shortcode) DO NOTHING
        `, [
          shortcode,
          item.videoUrl || null,
          item.displayUrl || (item.images && item.images[0]) || null,
          item.caption || '',
          likes, comments, views, postedAt,
          item.ownerUsername || item.owner?.username || '',
          item.url || (item.shortCode ? `https://www.instagram.com/p/${item.shortCode}/` : ''),
          'manual_import',
          itemFollowers, er_percent, er_label, taggedJson,
        ]);
```

- [ ] **Step 9: Run full server suite (no regressions)**

Run: `cd server && npm test`
Expected: all existing tests + the 12 new tests PASS. (Migration list change is exercised by `integration.test.js` / `db-health.test.js` if they boot the schema; confirm green.)

- [ ] **Step 10: Commit**

```bash
git add server/db.js server/scraper.js server/collab-capture.test.js
git commit -m "feat(collab): persist post taggedUsers to posts.tagged_users

New nullable TEXT column (dual-mode migration). normalizeTaggedUsers() pulls
clean handles from taggedUsers/usertags; both scrape + import paths write JSON
(or null when empty). Forward-looking; existing rows are not backfilled."
```

---

### Task 3: Mine `tagged_users` in `discoverRelated` Phase-1

**Files:**
- Modify: `server/scraper.js` — add `parseTaggedUsers(json)` helper + export; broaden the Phase-1 query and add a tagged-handle loop in `discoverRelated` (~L553-575).
- Modify: `server/collab-capture.test.js` — add `parseTaggedUsers` + mining-shape tests.

**Interfaces:**
- Consumes: `normalizeTaggedUsers` (Task 2), the `posts.tagged_users` column (Task 2).
- Produces: `parseTaggedUsers(json) → string[]` — `JSON.parse` a stored value, return the array of string handles, or `[]` for null/empty/malformed/non-array (never throws).

- [ ] **Step 1: Write the failing test**

Append to `server/collab-capture.test.js`:

```js
const { parseTaggedUsers } = require('./scraper');

test('parseTaggedUsers: valid JSON array → handles', () => {
  assert.deepStrictEqual(parseTaggedUsers('["alice","bob"]'), ['alice', 'bob']);
});

test('parseTaggedUsers: null/empty/malformed/non-array → [] (never throws)', () => {
  assert.deepStrictEqual(parseTaggedUsers(null), []);
  assert.deepStrictEqual(parseTaggedUsers(''), []);
  assert.deepStrictEqual(parseTaggedUsers('not json'), []);
  assert.deepStrictEqual(parseTaggedUsers('{"a":1}'), []);
  assert.deepStrictEqual(parseTaggedUsers('[1,2,"  ","ok"]'), ['ok']); // drops non-string/blank
});

test('mining shape: caption @mention + tagged handle de-dupe via seen Set', () => {
  // Mirrors the Phase-1 loop logic: a handle present in BOTH caption and
  // tagged_users is added once; new tagged handles are added with tagged_by source.
  const username = 'creator';
  const seen = new Set();
  const candidates = [];
  const rows = [{ caption: 'shot with @alice 🔥', tagged_users: '["alice","bob"]' }];
  for (const post of rows) {
    const mentions = (post.caption || '').match(/@([a-zA-Z0-9_.]{3,30})/g) || [];
    for (const m of mentions) {
      const h = m.replace('@', '').toLowerCase();
      if (!seen.has(h) && h !== username) { seen.add(h); candidates.push({ username: h, source: `mentioned_by:${username}` }); }
    }
    for (const h of parseTaggedUsers(post.tagged_users)) {
      if (!seen.has(h) && h !== username) { seen.add(h); candidates.push({ username: h, source: `tagged_by:${username}` }); }
    }
  }
  assert.deepStrictEqual(candidates.map(c => c.username), ['alice', 'bob']);
  assert.strictEqual(candidates.find(c => c.username === 'alice').source, 'mentioned_by:creator');
  assert.strictEqual(candidates.find(c => c.username === 'bob').source, 'tagged_by:creator');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test collab-capture.test.js`
Expected: FAIL — `parseTaggedUsers` is not a function.

- [ ] **Step 3: Add the `parseTaggedUsers` helper**

In `server/scraper.js`, after `normalizeTaggedUsers`, add:

```js
// Read side: parse a stored tagged_users JSON value into clean handles.
// Tolerates null/empty/malformed/non-array input — never throws.
function parseTaggedUsers(json) {
  if (!json) return [];
  let arr;
  try { arr = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return arr.filter(h => typeof h === 'string' && h.trim()).map(h => h.trim().toLowerCase());
}
```

- [ ] **Step 4: Export it**

After `module.exports.normalizeTaggedUsers = normalizeTaggedUsers;`, add:

```js
module.exports.parseTaggedUsers = parseTaggedUsers;
```

- [ ] **Step 5: Run helper tests to verify they pass**

Run: `cd server && node --test collab-capture.test.js`
Expected: PASS (Task 2 + Task 3 tests).

- [ ] **Step 6: Wire mining into `discoverRelated` Phase-1**

In `server/scraper.js` `discoverRelated`, change the Phase-1 query (~L554) to also select `tagged_users` and not require a caption:

```js
    // Phase 1: Mine existing posts in DB for @mentions and tagged collaborators
    const postsResult = await pool.query(
      "SELECT caption, tagged_users FROM posts WHERE account_handle = $1",
      [username]
    );
```

Then inside the existing `for (const post of postsResult.rows)` loop, after the caption-mention `for` loop (~L574, right before the loop's closing `}`), add the tagged-handle loop:

```js
      for (const handle of parseTaggedUsers(post.tagged_users)) {
        if (!seen.has(handle) && handle !== username.toLowerCase()) {
          seen.add(handle);
          candidates.push({
            username: handle,
            source: `tagged_by:${username}`,
            sourceAccount: username,
            captionSnippet: (post.caption || '').slice(0, 160),
            relevanceReason: `Photo-tagged by @${username}`,
            relevanceScore: 40,
          });
        }
      }
```

- [ ] **Step 7: Add the Phase-1 observability log**

In `discoverRelated`, immediately after the Phase-1 loop (before the `// Phase 2` comment ~L577), add a one-line metric:

```js
    console.log(`[Discovery] Phase-1 DB mining for @${username}: ${candidates.length} candidates (caption + tagged)`);
```

- [ ] **Step 8: Run full server suite**

Run: `cd server && npm test`
Expected: all tests green (existing + Task 1/2/3 additions).

- [ ] **Step 9: Commit**

```bash
git add server/scraper.js server/collab-capture.test.js
git commit -m "feat(discovery): mine tagged_users in discoverRelated Phase-1

parseTaggedUsers() reads stored handles; Phase-1 DB mining now surfaces
photo-tag collaborators (tagged_by source, relevance 40) from reels already
in the DB, de-duped against caption @mentions via the existing seen Set."
```

---

## Self-Review

**1. Spec coverage:**
- §3 unknown-views storage `null` → Task 1 Step 3/5. ✓
- §3 `formatViews` `—` display → Task 1 Step 8. ✓
- §3 `most_viewed` `NULLS LAST` → Task 1 Step 7. ✓
- §3 `minViews` hides unknown → no code change (SQL `view_count >= $n` already excludes `null`); documented, nothing to implement. ✓
- §4b/§5 `tagged_users TEXT` column dual-mode → Task 2 Step 6. ✓
- §4b persist in both paths → Task 2 Steps 7–8. ✓
- §4c Phase-1 mining → Task 3 Steps 6–7. ✓
- §7 observability log → Task 3 Step 7. ✓
- §9 tests (extractViews, normalizeTaggedUsers, persistence, Phase-1 mining, sort) → Tasks 1–3 test steps. ✓
- §2 non-goals (shares, backfill) → not implemented by design. ✓

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to" — all code shown inline. ✓

**3. Type consistency:** `extractViews(item)→number|null`, `normalizeTaggedUsers(item, ownerHandle='')→string[]|null`, `parseTaggedUsers(json)→string[]` used identically in tests and wiring. The write path JSON-stringifies the `string[]`; the read path `parseTaggedUsers` consumes that exact JSON. `tagged_users` column name consistent across db.js, both INSERTs, and the Phase-1 SELECT. ✓
