// server/me-feed.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { buildMeFeedQuery, nicheVisibilityClause, parseNiches, visibilityOnlyClause, playableClause } = require('./me-feed');

// A fixed freshness boundary so playable-filter tests are deterministic (no wall clock).
const CUTOFF = '2026-07-06T00:00:00.000Z';

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
  const { sql, params } = buildMeFeedQuery(['talking', 'dance'], { page: 1, limit: 24, freshnessCutoff: CUTOFF });
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
  const { sql, params } = buildMeFeedQuery(['dance'], { freshnessCutoff: CUTOFF });
  const rows = sqlite.prepare(sql.replace(/\$\d+/g, '?')).all(...params);
  const ids = rows.map(r => r.id).sort();
  assert.deepStrictEqual(ids, [2], 'only dance post returned');
});

test('buildMeFeedQuery all:true builds a query with NO niche IN() clause but WITH archived/soft_deleted, and executes against sqlite returning ALL visible+playable posts across niches', () => {
  const { sql, params } = buildMeFeedQuery([], { page: 1, limit: 24, all: true, freshnessCutoff: CUTOFF });
  assert.ok(sql, 'sql should not be null in all mode');
  assert.doesNotMatch(sql, /IN \(/);
  assert.match(sql, /soft_deleted/);
  assert.match(sql, /archived/);
  // all-mode: cutoff is $1, then limit $2, offset $3
  assert.deepStrictEqual(params, [CUTOFF, 24, 0]);

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

test('buildMeFeedQuery all:true placeholder numbering is cutoff=$1, LIMIT $2 OFFSET $3 (params length 0) and does not throw', () => {
  const { sql, params } = buildMeFeedQuery([], { page: 2, limit: 10, all: true, freshnessCutoff: CUTOFF });
  assert.match(sql, /LIMIT \$2 OFFSET \$3/);
  assert.deepStrictEqual(params, [CUTOFF, 10, 10]);
  const sqlite = makePostsDb();
  sqlite.prepare(`INSERT INTO posts (id, content_type, posted_at, video_cache_status) VALUES (1,'talking','2026-07-01','cached')`).run();
  assert.doesNotThrow(() => sqlite.prepare(sql.replace(/\$\d+/g, '?')).all(...params));
});

test('playableClause: cached OR fresh raw URL, excludes uncached-expired and pruning', () => {
  const clause = playableClause(3);
  assert.match(clause, /video_cache_status = 'cached'/);
  assert.match(clause, /video_url_refreshed_at >= \$3/);
  assert.match(clause, /pruning/);
});

test('feed hides reels whose video is neither cached nor fresh (the videos-wont-play fix)', () => {
  const sqlite = makePostsDb();
  // Same niche, same visibility — differ ONLY by playability:
  //  1 cached (playable)                                        → shown
  //  2 uncached, raw URL fresh (refreshed after cutoff)         → shown (302-able)
  //  3 uncached, raw URL stale (refreshed before cutoff)        → HIDDEN (frozen thumb today)
  //  4 uncached, no refreshed_at, no url                        → HIDDEN
  //  5 mid-prune (pruning) even with a fresh url                → HIDDEN
  sqlite.prepare(`INSERT INTO posts (id, content_type, posted_at, video_url, video_url_refreshed_at, video_cache_status) VALUES
    (1,'talking','2026-07-01','http://x/1', NULL,                     'cached'),
    (2,'talking','2026-07-02','http://x/2','2026-07-07T00:00:00.000Z', NULL),
    (3,'talking','2026-07-03','http://x/3','2026-07-01T00:00:00.000Z', NULL),
    (4,'talking','2026-07-04', NULL,        NULL,                      NULL),
    (5,'talking','2026-07-05','http://x/5','2026-07-07T00:00:00.000Z','pruning')`).run();
  const { sql, params } = buildMeFeedQuery(['talking'], { freshnessCutoff: CUTOFF });
  const rows = sqlite.prepare(sql.replace(/\$\d+/g, '?')).all(...params);
  const ids = rows.map(r => r.id).sort();
  assert.deepStrictEqual(ids, [1, 2], 'only the cached reel and the fresh-URL reel are surfaced');
});
