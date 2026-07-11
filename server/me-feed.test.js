// server/me-feed.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { buildMeFeedQuery, nicheVisibilityClause, parseNiches, visibilityOnlyClause, PLAYABLE_CLAUSE } = require('./me-feed');

// posts table with the columns the feed query now reads (incl. video playability).
function makePostsDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE posts (
    id INTEGER PRIMARY KEY, content_type TEXT, account_handle TEXT, posted_at TEXT,
    soft_deleted INTEGER DEFAULT 0, archived INTEGER DEFAULT 0,
    video_url TEXT, video_url_refreshed_at TEXT, video_cache_status TEXT)`);
  sqlite.exec(`CREATE TABLE creator_types (account_handle TEXT, content_type TEXT)`);
  return sqlite;
}

test('empty niches → sql null (nothing to show)', () => {
  assert.deepStrictEqual(buildMeFeedQuery([], {}), { sql: null, params: [] });
});
test('nicheVisibilityClause uses IN() placeholders (not ANY) + archived + soft_deleted', () => {
  const { clause, params } = nicheVisibilityClause(['talking', 'dance'], 5);
  assert.match(clause, /COALESCE\(posts\.content_type, ct\.content_type\) IN \(\$5, \$6\)/);
  assert.match(clause, /archived/);
  assert.match(clause, /soft_deleted/);
  assert.doesNotMatch(clause, /ANY/);
  assert.deepStrictEqual(params, ['talking', 'dance']);
});
test('buildMeFeedQuery actually EXECUTES against sqlite and scopes by niche + archived', () => {
  const sqlite = makePostsDb();
  // all inserted posts are cached → playable, so this test isolates niche/archived scoping
  sqlite.prepare(`INSERT INTO posts (id, content_type, posted_at, archived, video_cache_status) VALUES
    (1,'talking','2026-07-01',0,'cached'),(2,'dance','2026-07-02',0,'cached'),
    (3,'skit','2026-07-03',0,'cached'),(4,'talking','2026-07-04',1,'cached')`).run();
  const { sql, params } = buildMeFeedQuery(['talking', 'dance'], { page: 1, limit: 24 });
  const rows = sqlite.prepare(sql.replace(/\$\d+/g, '?')).all(...params);
  const ids = rows.map(r => r.id).sort();
  assert.deepStrictEqual(ids, [1, 2], 'only non-archived talking/dance posts; skit + archived excluded');
});
test('parseNiches builds a flat list from primary + comma-separated secondary niches', () => {
  assert.deepStrictEqual(
    parseNiches({ primary_niche: 'talking', secondary_niches: 'dance, skit' }),
    ['talking', 'dance', 'skit']
  );
  assert.deepStrictEqual(
    parseNiches({ primary_niche: 'talking' }),
    ['talking']
  );
});

test('visibilityOnlyClause returns archived + soft_deleted filter with no params, no niche IN', () => {
  const clause = visibilityOnlyClause();
  assert.match(clause, /archived/);
  assert.match(clause, /soft_deleted/);
  assert.doesNotMatch(clause, / IN \(/);
  assert.doesNotMatch(clause, /ANY/);
});

test('buildMeFeedQuery single-niche call still scoped (dance only)', () => {
  const sqlite = makePostsDb();
  sqlite.prepare(`INSERT INTO posts (id, content_type, posted_at, archived, video_cache_status) VALUES
    (1,'talking','2026-07-01',0,'cached'),(2,'dance','2026-07-02',0,'cached'),(3,'skit','2026-07-03',0,'cached')`).run();
  const { sql, params } = buildMeFeedQuery(['dance'], {});
  const rows = sqlite.prepare(sql.replace(/\$\d+/g, '?')).all(...params);
  const ids = rows.map(r => r.id).sort();
  assert.deepStrictEqual(ids, [2], 'only dance post returned');
});

test('buildMeFeedQuery shuffle mode orders by random for feed refresh', () => {
  const { sql, params } = buildMeFeedQuery(['talking'], { page: 1, limit: 24, shuffle: true });
  assert.match(sql, /ORDER BY RANDOM\(\)/);
  assert.doesNotMatch(sql, /ORDER BY posts\.posted_at DESC/);
  assert.deepStrictEqual(params, ['talking', 24, 0]);
});

test('buildMeFeedQuery all:true builds a query with NO niche IN() clause but WITH archived/soft_deleted, and executes against sqlite returning ALL visible+cached posts across niches', () => {
  const { sql, params } = buildMeFeedQuery([], { page: 1, limit: 24, all: true });
  assert.ok(sql, 'sql should not be null in all mode');
  assert.doesNotMatch(sql, /IN \(/);
  assert.match(sql, /soft_deleted/);
  assert.match(sql, /archived/);
  // all-mode: no visibility params, so limit $1 / offset $2
  assert.match(sql, /LIMIT \$1 OFFSET \$2/);
  assert.deepStrictEqual(params, [24, 0]);

  const sqlite = makePostsDb();
  sqlite.prepare(`INSERT INTO posts (id, content_type, posted_at, archived, soft_deleted, video_cache_status) VALUES
    (1,'talking','2026-07-01',0,0,'cached'),(2,'dance','2026-07-02',0,0,'cached'),(3,'skit','2026-07-03',0,0,'cached'),
    (4,'talking','2026-07-04',1,0,'cached'),(5,'dance','2026-07-05',0,1,'cached')`).run();
  const rows = sqlite.prepare(sql.replace(/\$\d+/g, '?')).all(...params);
  const ids = rows.map(r => r.id).sort();
  assert.deepStrictEqual(ids, [1, 2, 3], 'skit is included in all-mode; archived post 4 and soft-deleted post 5 excluded');
  // newest first ordering check
  assert.deepStrictEqual(rows.map(r => r.id), [3, 2, 1]);
});

test('the feed is cached-only: uncached reels are hidden even with a fresh raw URL (no frozen thumbnails)', () => {
  assert.match(PLAYABLE_CLAUSE, /video_cache_status = 'cached'/);
  const sqlite = makePostsDb();
  // Same niche, same visibility — differ ONLY by cache state:
  //  1 cached                                      → shown
  //  2 uncached, raw URL "fresh" (refreshed today) → HIDDEN (URL could 403 → frozen)
  //  3 uncached, pending                           → HIDDEN (not on disk yet)
  //  4 expired (403 during sweep)                  → HIDDEN
  sqlite.prepare(`INSERT INTO posts (id, content_type, posted_at, video_url, video_url_refreshed_at, video_cache_status) VALUES
    (1,'talking','2026-07-01','http://x/1', NULL,                     'cached'),
    (2,'talking','2026-07-02','http://x/2','2026-07-08T00:00:00.000Z', NULL),
    (3,'talking','2026-07-03','http://x/3','2026-07-08T00:00:00.000Z','pending'),
    (4,'talking','2026-07-04','http://x/4','2026-07-08T00:00:00.000Z','expired')`).run();
  const { sql, params } = buildMeFeedQuery(['talking'], {});
  const rows = sqlite.prepare(sql.replace(/\$\d+/g, '?')).all(...params);
  assert.deepStrictEqual(rows.map(r => r.id), [1], 'only the cached reel is surfaced');
});
