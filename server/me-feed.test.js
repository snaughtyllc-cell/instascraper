// server/me-feed.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { buildMeFeedQuery, nicheVisibilityClause, parseNiches, allowedNicheOptions, visibilityOnlyClause, PLAYABLE_CLAUSE } = require('./me-feed');

// posts table with the columns the feed query now reads (incl. video playability).
function makePostsDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE posts (
    id INTEGER PRIMARY KEY, content_type TEXT, account_handle TEXT, posted_at TEXT,
    sort_status TEXT DEFAULT 'auto', ai_look_tags TEXT, perf_score REAL,
    soft_deleted INTEGER DEFAULT 0, archived INTEGER DEFAULT 0,
    video_url TEXT, video_url_refreshed_at TEXT, video_cache_status TEXT)`);
  sqlite.exec(`CREATE TABLE creator_types (account_handle TEXT, content_type TEXT)`);
  sqlite.exec(`CREATE TABLE model_assigned_posts (model_id INTEGER, post_id INTEGER, status TEXT)`);
  sqlite.exec(`CREATE TABLE model_post_feedback (model_id INTEGER, post_id INTEGER, feedback TEXT)`);
  sqlite.exec(`CREATE TABLE model_saved_posts (model_id INTEGER, post_id INTEGER)`);
  sqlite.exec(`CREATE TABLE model_creators (model_id INTEGER, username TEXT)`);
  return sqlite;
}

test('empty niches still show sorted reels', () => {
  const sqlite = makePostsDb();
  sqlite.exec(`INSERT INTO posts (id,content_type,sort_status,video_cache_status) VALUES
    (1,'talking','auto','cached'),(2,'dance','manual','cached'),(3,'talking','unsorted','cached')`);
  const { sql, params } = buildMeFeedQuery([], {});
  assert.deepStrictEqual(sqlite.prepare(sql.replace(/\$\d+/g, '?')).all(...params).map(row => row.id), [1, 2]);
});
test('nicheVisibilityClause uses IN() placeholders (not ANY) + archived + soft_deleted', () => {
  const { clause, params } = nicheVisibilityClause(['talking', 'dance'], 5);
  assert.match(clause, /CASE WHEN posts\.sort_status IN \('auto','manual'\) THEN posts\.content_type ELSE NULL END IN \(\$5, \$6\)/);
  assert.match(clause, /archived/);
  assert.match(clause, /soft_deleted/);
  assert.doesNotMatch(clause, /ANY/);
  assert.deepStrictEqual(params, ['talking', 'dance']);
});
test('buildMeFeedQuery ranks niches first and includes other sorted types', () => {
  const sqlite = makePostsDb();
  // all inserted posts are cached → playable, so this test isolates niche/archived scoping
  sqlite.prepare(`INSERT INTO posts (id, content_type, posted_at, archived, video_cache_status) VALUES
    (1,'talking','2026-07-01',0,'cached'),(2,'dance','2026-07-02',0,'cached'),
    (3,'skit','2026-07-03',0,'cached'),(4,'talking','2026-07-04',1,'cached')`).run();
  const { sql, params } = buildMeFeedQuery(['talking', 'dance'], { page: 1, limit: 24 });
  const rows = sqlite.prepare(sql.replace(/\$\d+/g, '?')).all(...params);
  assert.deepStrictEqual(rows.map(r => r.id), [2, 1, 3], 'niche reels rank above newer skit; archived excluded');
});
test('parseNiches builds a flat list from primary + comma-separated secondary niches', () => {
  assert.deepStrictEqual(
    parseNiches({ primary_niche: 'talking', secondary_niches: 'dance, skit' }),
    ['talking', 'dance', 'skit']
  );
  assert.deepStrictEqual(
    parseNiches({ primary_niche: 'talking', secondary_niches: 'talking, dance' }),
    ['talking', 'dance']
  );
  assert.deepStrictEqual(
    parseNiches({ primary_niche: 'talking' }),
    ['talking']
  );
});

test('allowedNicheOptions returns only model niches with labels and a readable fallback', () => {
  assert.deepStrictEqual(
    allowedNicheOptions(['talking', 'photo-dump'], [{ value: 'talking', label: 'Talking' }, { value: 'dance', label: 'Dance' }]),
    [{ value: 'talking', label: 'Talking' }, { value: 'photo-dump', label: 'Photo Dump' }]
  );
});

test('visibilityOnlyClause returns archived + soft_deleted filter with no params, no niche IN', () => {
  const clause = visibilityOnlyClause();
  assert.match(clause, /archived/);
  assert.match(clause, /soft_deleted/);
  assert.doesNotMatch(clause, / IN \(/);
  assert.doesNotMatch(clause, /ANY/);
});

test('explicit niche selection remains a hard filter', () => {
  const sqlite = makePostsDb();
  sqlite.prepare(`INSERT INTO posts (id, content_type, posted_at, archived, video_cache_status) VALUES
    (1,'talking','2026-07-01',0,'cached'),(2,'dance','2026-07-02',0,'cached'),(3,'skit','2026-07-03',0,'cached')`).run();
  const { sql, params } = buildMeFeedQuery(['talking', 'dance'], { modelId: 7, niche: 'dance' });
  assert.deepStrictEqual([...sql.matchAll(/\$(\d+)/g)].map(match => Number(match[1])), params.map((_, i) => i + 1));
  const rows = sqlite.prepare(sql.replace(/\$\d+/g, '?')).all(...params);
  const ids = rows.map(r => r.id).sort();
  assert.deepStrictEqual(ids, [2], 'only dance post returned');
});

test('buildMeFeedQuery shuffle mode orders by random for feed refresh', () => {
  const { sql, params } = buildMeFeedQuery(['talking'], { page: 1, limit: 24, shuffle: true });
  assert.match(sql, /ORDER BY RANDOM\(\)/);
  assert.doesNotMatch(sql, /ORDER BY posts\.posted_at DESC/);
  assert.doesNotMatch(sql, /perf_score/);
  assert.deepStrictEqual(params, [24, 0]);
});

test('buildMeFeedQuery can fetch one extra row without skipping between 24-item pages', () => {
  const { sql, params } = buildMeFeedQuery(['talking'], { page: 2, limit: 25, pageSize: 24 });
  assert.match(sql, /LIMIT \$2 OFFSET \$3/);
  assert.deepStrictEqual(params, ['talking', 25, 24]);
});

test('buildMeFeedQuery all:true builds a query with NO niche IN() clause but WITH archived/soft_deleted, and executes against sqlite returning ALL visible+cached posts across niches', () => {
  const { sql, params } = buildMeFeedQuery([], { page: 1, limit: 24, all: true });
  assert.ok(sql, 'sql should not be null in all mode');
  assert.doesNotMatch(sql, /END IN \(/);
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

test('model feed excludes assigned, saved, and not-interested reels without hiding other models records', () => {
  const sqlite = makePostsDb();
  sqlite.prepare(`INSERT INTO posts (id, content_type, posted_at, video_cache_status) VALUES
    (1,'talking','2026-07-04','cached'),
    (2,'talking','2026-07-03','cached'),
    (3,'talking','2026-07-02','cached'),
    (4,'talking','2026-07-01','cached')`).run();
  sqlite.prepare("INSERT INTO model_assigned_posts (model_id, post_id, status) VALUES (7,1,'assigned'), (8,4,'assigned')").run();
  sqlite.prepare("INSERT INTO model_post_feedback (model_id, post_id, feedback) VALUES (7,2,'not_my_style'), (7,3,'want_to_make'), (8,4,'not_my_style')").run();
  sqlite.prepare('INSERT INTO model_saved_posts (model_id, post_id) VALUES (7,3), (8,4)').run();

  const { sql, params } = buildMeFeedQuery(['talking'], { modelId: 7, limit: 24 });
  const rows = sqlite.prepare(sql.replace(/\$\d+/g, '?')).all(...params);
  assert.deepStrictEqual(rows.map((row) => row.id), [4]);
  assert.deepStrictEqual(params, [7, 7, 7, 7, 7, 'talking', 24, 0]);
});

for (const [name, status, contentType, creatorType, expected] of [
  ['unsorted reel with creator type is hidden', 'unsorted', null, 'talking', []],
  ['unsorted reel with content_type is hidden', 'unsorted', 'talking', null, []],
  ['needs_look reel hidden', 'needs_look', 'talking', 'talking', []],
  ['auto reel without a type hidden', 'auto', null, 'talking', []],
  ['manual reel without a type hidden', 'manual', null, 'talking', []],
  ['auto reel visible', 'auto', 'talking', null, [1]],
  ['manual reel visible', 'manual', 'talking', null, [1]],
]) {
  test(name, () => {
    const sqlite = makePostsDb();
    sqlite.prepare("INSERT INTO posts (id, account_handle, content_type, sort_status, video_cache_status) VALUES (1, 'creator', ?, ?, 'cached')").run(contentType, status);
    if (creatorType) sqlite.prepare("INSERT INTO creator_types VALUES ('creator', ?)").run(creatorType);
    const { sql, params } = buildMeFeedQuery(['talking']);
    assert.deepStrictEqual(sqlite.prepare(sql.replace(/\$\d+/g, '?')).all(...params).map((row) => row.id), expected);
  });
}

for (const [name, owned, expected] of [
  ['fallback — no creators, all sorted reels visible with niche ones first', false, [2, 1, 3]],
  ["with creators — other creators' reels hidden, other sorted types visible", true, [1, 3]],
]) {
  test(name, () => {
    const sqlite = makePostsDb();
    sqlite.exec(`INSERT INTO posts (id, account_handle, content_type, posted_at, video_cache_status) VALUES
      (1,'Mia.Talks','talking','2026-07-01','cached'),
      (2,'other','talking','2026-07-02','cached'),
      (3,'Mia.Talks','dance','2026-07-03','cached')`);
    if (owned) sqlite.exec("INSERT INTO model_creators VALUES (7,'mia.talks')");
    const { sql, params } = buildMeFeedQuery(['talking'], { modelId: 7 });
    assert.deepStrictEqual(sqlite.prepare(sql.replace(/\$\d+/g, '?')).all(...params).map(r => r.id), expected);
  });
}
test("own creator's sorted reel outside her niches remains visible", () => {
  const sqlite = makePostsDb();
  sqlite.exec("INSERT INTO model_creators VALUES (7,'mia.talks'); INSERT INTO posts (id,account_handle,content_type,video_cache_status) VALUES (1,'mia.talks','dance','cached')");
  const { sql, params } = buildMeFeedQuery(['talking'], { modelId: 7 });
  assert.deepStrictEqual(sqlite.prepare(sql.replace(/\$\d+/g, '?')).all(...params).map(row => row.id), [1]);
});

function rankedReels(sqlite, options) {
  const { sql, params } = buildMeFeedQuery(['talking'], options);
  const numbers = [...sql.matchAll(/\$(\d+)/g)].map(match => Number(match[1]));
  assert.deepStrictEqual(numbers, params.map((_, i) => i + 1), 'ascending SQLite placeholders');
  return sqlite.prepare(sql.replace(/\$\d+/g, '?')).all(...params).map(row => row.id);
}

test('look tags rank matching reels first without filtering unmatched reels', () => {
  const sqlite = makePostsDb();
  sqlite.exec(`INSERT INTO posts (id,content_type,posted_at,video_cache_status,ai_look_tags) VALUES
    (1,'talking','2026-07-01','cached','["brunette","bedroom"]'),
    (2,'talking','2026-07-02','cached','["brunette"]'),
    (3,'talking','2026-07-03','cached',NULL)`);
  assert.deepStrictEqual(rankedReels(sqlite, { lookTags: ['brunette', 'bedroom'], modelId: 7 }), [1, 2, 3]);
  sqlite.close();
});

test('niche rank precedes look match, learned taste, and recency', () => {
  const sqlite = makePostsDb();
  sqlite.exec(`INSERT INTO posts (id,account_handle,content_type,posted_at,video_cache_status,ai_look_tags) VALUES
    (1,'neutral','talking','2026-07-01','cached','[]'),
    (2,'liked','dance','2026-07-03','cached','["alt","bedroom"]'),
    (3,'neutral','dance','2026-07-04','cached','[]')`);
  assert.deepStrictEqual(rankedReels(sqlite, { modelId: 7, lookTags: ['alt', 'bedroom'], taste: { creators: [['liked', 0.8]] } }), [1, 2, 3]);
  sqlite.close();
});

test('no model tags still ranks by performance', () => {
  assert.deepStrictEqual(buildMeFeedQuery(['talking'], { lookTags: [] }), buildMeFeedQuery(['talking']));
  assert.match(buildMeFeedQuery(['talking'], { lookTags: [] }).sql, /THEN 1 ELSE 0 END DESC, \(COALESCE\(posts\.perf_score, 0\) \* 1\) DESC, posts\.posted_at DESC/);
});

test('shuffle ignores look tags', () => {
  assert.deepStrictEqual(buildMeFeedQuery(['talking'], { shuffle: true, lookTags: ['alt'] }),
    buildMeFeedQuery(['talking'], { shuffle: true }));
});

test('quoted match avoids substring hits', () => {
  const sqlite = makePostsDb();
  sqlite.exec(`INSERT INTO posts (id,content_type,posted_at,video_cache_status,ai_look_tags) VALUES
    (1,'talking','2026-07-01','cached','["alt"]'),
    (2,'talking','2026-07-03','cached','["alt-girl"]'),
    (3,'talking','2026-07-02','cached',NULL)`);
  assert.deepStrictEqual(rankedReels(sqlite, { lookTags: ['alt'] }), [1, 2, 3]);
  sqlite.close();
});

test('feed ranks reels from liked creator and liked tag above disliked type', () => {
  const sqlite = makePostsDb();
  sqlite.exec(`INSERT INTO posts (id,account_handle,content_type,posted_at,video_cache_status,ai_look_tags) VALUES
    (1,'Mia','talking','2026-07-01','cached','["brunette"]'),
    (2,'other','talking','2026-07-03','cached','["brunette"]'),
    (3,'other','talking','2026-07-04','cached','[]')`);
  const taste = { types: [['talking', -0.3]], tags: [['brunette', 0.5]], creators: [['mia', 0.5]] };
  assert.match(buildMeFeedQuery(['talking'], { taste }).sql, /THEN CAST\(\$\d+ AS REAL\) ELSE 0 END/,
    'fractional affinities must not be inferred as integer parameters by Postgres');
  assert.deepStrictEqual(rankedReels(sqlite, { modelId: 7, lookTags: ['bedroom'], taste }), [1, 2, 3]);
  sqlite.close();
});

test('disliked reels sink but remain in results; only exact rejected reel stays hidden', () => {
  const sqlite = makePostsDb();
  sqlite.exec(`INSERT INTO posts (id,account_handle,content_type,posted_at,video_cache_status) VALUES
    (1,'disliked','talking','2026-07-04','cached'),(2,'disliked','talking','2026-07-03','cached'),
    (3,'neutral','talking','2026-07-01','cached');
    INSERT INTO model_post_feedback VALUES (7,1,'not_my_style')`);
  assert.deepStrictEqual(rankedReels(sqlite, { modelId: 7, taste: { creators: [['disliked', -0.5]] } }), [3, 2]);
  sqlite.close();
});

test('empty taste and no look tags retains the default rank', () => {
  assert.deepStrictEqual(buildMeFeedQuery(['talking'], { lookTags: [], taste: { types: [], tags: [], creators: [] } }), buildMeFeedQuery(['talking']));
});

test('shuffle ignores taste', () => {
  assert.deepStrictEqual(buildMeFeedQuery(['talking'], { shuffle: true, taste: { tags: [['alt', 0.5]] } }),
    buildMeFeedQuery(['talking'], { shuffle: true }));
});

function withPerfWeight(value, run) {
  const previous = process.env.FEED_PERF_WEIGHT;
  if (value === undefined) delete process.env.FEED_PERF_WEIGHT;
  else process.env.FEED_PERF_WEIGHT = value;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.FEED_PERF_WEIGHT;
    else process.env.FEED_PERF_WEIGHT = previous;
  }
}

test('performance beats recency within a niche with equal look and taste', () => {
  const sqlite = makePostsDb();
  sqlite.exec(`INSERT INTO posts (id,account_handle,content_type,posted_at,video_cache_status,ai_look_tags,perf_score) VALUES
    (1,'liked','talking','2026-07-01','cached','["alt"]',2),
    (2,'liked','talking','2026-07-02','cached','["alt"]',-1)`);
  withPerfWeight(undefined, () => {
    assert.deepStrictEqual(rankedReels(sqlite, { lookTags: ['alt'], taste: { creators: [['liked', 0.5]] } }), [1, 2]);
    assert.deepStrictEqual(rankedReels(sqlite, {}), [1, 2], 'performance applies on its own');
  });
  sqlite.close();
});

test('zero performance weight restores newest-first without look or taste', () => {
  const sqlite = makePostsDb();
  sqlite.exec(`INSERT INTO posts (id,content_type,posted_at,video_cache_status,perf_score) VALUES
    (1,'talking','2026-07-01','cached',2),(2,'talking','2026-07-02','cached',-1)`);
  withPerfWeight('0', () => {
    assert.doesNotMatch(buildMeFeedQuery(['talking']).sql, /perf_score/);
    assert.deepStrictEqual(rankedReels(sqlite, {}), [2, 1]);
  });
  sqlite.close();
});

test('niche preference beats performance, look, taste, and recency', () => {
  const sqlite = makePostsDb();
  sqlite.exec(`INSERT INTO posts (id,account_handle,content_type,posted_at,video_cache_status,ai_look_tags,perf_score) VALUES
    (1,'neutral','talking','2026-07-01','cached','[]',-2),
    (2,'liked','dance','2026-07-02','cached','["alt"]',2)`);
  withPerfWeight('100', () => {
    assert.deepStrictEqual(rankedReels(sqlite, { lookTags: ['alt'], taste: { creators: [['liked', 1]] } }), [1, 2]);
  });
  sqlite.close();
});

test('all mode ranks by performance without adding niche priority or filtering missing scores', () => {
  const sqlite = makePostsDb();
  sqlite.exec(`INSERT INTO posts (id,content_type,sort_status,posted_at,video_cache_status,perf_score) VALUES
    (1,'talking','auto','2026-07-03','cached',-2),
    (2,'dance','auto','2026-07-01','cached',2),
    (3,NULL,'unsorted','2026-07-02','cached',NULL)`);
  withPerfWeight(undefined, () => {
    assert.deepStrictEqual(rankedReels(sqlite, { all: true }), [2, 3, 1]);
    assert.doesNotMatch(buildMeFeedQuery(['talking'], { all: true, shuffle: true }).sql, /perf_score/);
  });
  sqlite.close();
});

test('performance is summed with look and taste and preserves ascending scoped placeholders', () => {
  const sqlite = makePostsDb();
  sqlite.exec(`INSERT INTO model_creators VALUES (7,'liked');
    INSERT INTO posts (id,account_handle,content_type,posted_at,video_cache_status,ai_look_tags,perf_score) VALUES
    (1,'liked','talking','2026-07-01','cached','[]',1.5),
    (2,'liked','talking','2026-07-02','cached','["alt"]',0),
    (3,'other','talking','2026-07-03','cached','["alt"]',2),
    (4,'liked','dance','2026-07-04','cached','["alt"]',2)`);
  const options = { modelId: 7, niche: 'talking', lookTags: ['alt'],
    taste: { types: [['talking', -0.25]], tags: [['alt', 0.5]], creators: [['liked', 0.25]] } };
  withPerfWeight('0.5', () => {
    assert.match(buildMeFeedQuery(['talking'], options).sql, /COALESCE\(posts\.perf_score, 0\) \* 0\.5/);
    assert.deepStrictEqual(rankedReels(sqlite, options), [2, 1], 'look and taste together outweigh weighted performance');
  });
  withPerfWeight('2', () => {
    assert.deepStrictEqual(rankedReels(sqlite, options), [1, 2], 'weight scales performance within the summed rank');
  });
  sqlite.close();
});

for (const weight of ['invalid', 'NaN', 'Infinity', '-Infinity', '-1', '1; SELECT 1']) {
  test(`invalid performance weight ${JSON.stringify(weight)} falls back to one`, () => {
    withPerfWeight(weight, () => {
      const query = buildMeFeedQuery(['talking']);
      assert.match(query.sql, /COALESCE\(posts\.perf_score, 0\) \* 1\) DESC/);
      withPerfWeight(undefined, () => assert.deepStrictEqual(query, buildMeFeedQuery(['talking'])));
    });
  });
}
