// server/me-feed.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { buildMeFeedQuery, nicheVisibilityClause, parseNiches, allowedNicheOptions, visibilityOnlyClause, PLAYABLE_CLAUSE, EASY_FILM_CLAUSE } = require('./me-feed');

// posts table with the columns the feed query now reads (incl. video playability).
function makePostsDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE posts (
    id INTEGER PRIMARY KEY, content_type TEXT, account_handle TEXT, posted_at TEXT,
    sort_status TEXT DEFAULT 'auto', ai_look_tags TEXT, ai_layout TEXT, perf_score REAL,
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
  assert.deepStrictEqual(sqlite.prepare(sql.replace(/\$\d+/g, '?')).all(...params).map(row => row.id), [2, 1]);
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
  assert.deepStrictEqual(rows.map(r => r.id), [1, 2, 3], 'primary, then secondary, then newer skit; archived excluded');
});
for (const spread of ['2', '0']) {
  test(`primary niche outranks stronger secondary and other reels with creator spread ${spread}`, () => {
    const saved = process.env.FEED_CREATOR_SPREAD;
    process.env.FEED_CREATOR_SPREAD = spread;
    try {
      const sqlite = makePostsDb();
      sqlite.exec(`INSERT INTO posts (id, content_type, account_handle, posted_at, perf_score, video_cache_status) VALUES
        (1,'talking','a','2026-07-01',0,'cached'),(2,'dance','b','2026-07-02',99,'cached'),
        (3,'skit','c','2026-07-03',99,'cached'),(4,'talking','d','2026-07-04',0,'cached')`);
      const { sql, params } = buildMeFeedQuery(['talking', 'dance'], { page: 1, limit: 24 });
      const rows = sqlite.prepare(sql.replace(/\$\d+/g, '?')).all(...params);
      assert.deepStrictEqual(rows.map(r => r.id), [4, 1, 2, 3]);
    } finally {
      if (saved === undefined) delete process.env.FEED_CREATOR_SPREAD; else process.env.FEED_CREATOR_SPREAD = saved;
    }
  });
}
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

function withEasyFilmRequirement(value, run) {
  const previous = process.env.FEED_REQUIRE_EASY_FILM;
  if (value === undefined) delete process.env.FEED_REQUIRE_EASY_FILM;
  else process.env.FEED_REQUIRE_EASY_FILM = value;
  try { run(); } finally {
    if (previous === undefined) delete process.env.FEED_REQUIRE_EASY_FILM;
    else process.env.FEED_REQUIRE_EASY_FILM = previous;
  }
}

function withEasyFilmExemptTypes(value, run) {
  const previous = process.env.FEED_EASY_FILM_EXEMPT_TYPES;
  if (value === undefined) delete process.env.FEED_EASY_FILM_EXEMPT_TYPES;
  else process.env.FEED_EASY_FILM_EXEMPT_TYPES = value;
  try { run(); } finally {
    if (previous === undefined) delete process.env.FEED_EASY_FILM_EXEMPT_TYPES;
    else process.env.FEED_EASY_FILM_EXEMPT_TYPES = previous;
  }
}

function makeLayoutPostsDb() {
  const sqlite = makePostsDb();
  const insert = sqlite.prepare(`INSERT INTO posts
    (id,content_type,posted_at,video_cache_status,ai_layout) VALUES (?,?,?,'cached',?)`);
  let id = 0;
  for (const type of ['talking', 'dance', 'skit']) {
    for (const layout of ['self_filmed', null, 'split_screen', 'gameplay_overlay', 'needs_footage']) {
      insert.run(++id, type, '2026-11-15', layout);
    }
  }
  return sqlite;
}

test('easy-to-film filter keeps self-filmed and unchecked reels across content types and feed modes', () => {
  assert.equal(EASY_FILM_CLAUSE, "(posts.ai_layout IS NULL OR posts.ai_layout = 'self_filmed' OR posts.content_type IN ('omegle'))");
  const sqlite = makeLayoutPostsDb();
  withEasyFilmRequirement(undefined, () => withEasyFilmExemptTypes(undefined, () => {
    for (const options of [{}, { all: true }, { shuffle: true }, { niche: 'talking', modelId: 7 }]) {
      const ids = rankedReels(sqlite, options).sort((a, b) => a - b);
      assert.deepStrictEqual(ids, options.niche ? [1, 2] : [1, 2, 6, 7, 11, 12]);
    }
  }));
  sqlite.close();
});

for (const value of ['0', 'false', 'off', ' FALSE ', 'OFF']) {
  test(`FEED_REQUIRE_EASY_FILM=${JSON.stringify(value)} disables layout filtering`, () => {
    const sqlite = makeLayoutPostsDb();
    withEasyFilmRequirement(value, () => withEasyFilmExemptTypes(undefined, () => {
      const { sql } = buildMeFeedQuery(['talking']);
      assert.ok(!sql.includes(EASY_FILM_CLAUSE));
      assert.deepStrictEqual(rankedReels(sqlite, {}).sort((a, b) => a - b), Array.from({ length: 15 }, (_, i) => i + 1));
    }));
    sqlite.close();
  });
}

for (const value of ['', '1', 'true', 'unexpected']) {
  test(`FEED_REQUIRE_EASY_FILM=${JSON.stringify(value)} keeps layout filtering enabled`, () => {
    withEasyFilmRequirement(value, () => withEasyFilmExemptTypes(undefined,
      () => assert.ok(buildMeFeedQuery(['talking']).sql.includes(EASY_FILM_CLAUSE))));
  });
}

function makeReactLayoutPostsDb() {
  const sqlite = makePostsDb();
  sqlite.exec(`INSERT INTO posts (id,account_handle,content_type,posted_at,video_cache_status,ai_layout) VALUES
    (1,'mine','omegle','2026-11-15','cached','split_screen'),
    (2,'mine','talking','2026-11-15','cached','split_screen'),
    (3,'mine','photo-dump','2026-11-15','cached','gameplay_overlay'),
    (4,'mine','skit','2026-11-15','cached','needs_footage')`);
  return sqlite;
}

test('React-mode omegle reels are exempt by default while split-screen talking stays hidden', () => {
  const sqlite = makeReactLayoutPostsDb();
  withEasyFilmRequirement(undefined, () => withEasyFilmExemptTypes(undefined, () => {
    for (const options of [{}, { all: true }, { shuffle: true }]) {
      assert.deepStrictEqual(rankedReels(sqlite, options), [1]);
    }
    assert.ok(buildMeFeedQuery(['talking']).sql.includes(EASY_FILM_CLAUSE));
  }));
  sqlite.close();
});

test('custom exempt types replace omegle, trim and deduplicate values, and are read per query', () => {
  const sqlite = makeReactLayoutPostsDb();
  withEasyFilmRequirement(undefined, () => {
    withEasyFilmExemptTypes(undefined, () => assert.deepStrictEqual(rankedReels(sqlite, {}), [1]));
    withEasyFilmExemptTypes(' skit, photo-dump,skit, ,', () => {
      const { sql } = buildMeFeedQuery(['talking']);
      assert.ok(sql.includes("posts.content_type IN ('skit', 'photo-dump')"));
      assert.deepStrictEqual(rankedReels(sqlite, {}).sort((a, b) => a - b), [3, 4]);
    });
    withEasyFilmExemptTypes(undefined, () => assert.deepStrictEqual(rankedReels(sqlite, {}), [1]));
  });
  sqlite.close();
});

for (const value of ['', ' , , ']) {
  test(`FEED_EASY_FILM_EXEMPT_TYPES=${JSON.stringify(value)} removes all exemptions`, () => {
    const sqlite = makeReactLayoutPostsDb();
    withEasyFilmRequirement(undefined, () => withEasyFilmExemptTypes(value, () => {
      assert.deepStrictEqual(rankedReels(sqlite, {}), []);
      assert.doesNotMatch(buildMeFeedQuery(['talking']).sql, /posts\.content_type IN \(/);
    }));
    sqlite.close();
  });
}

test('invalid exemption tokens are rejected individually without entering SQL', () => {
  const sqlite = makeReactLayoutPostsDb();
  const invalid = ["omegle') OR 1=1 --", 'OMEGLE', 'photo_dump', 'skit;DROP TABLE posts', 'talking/*', 'ömegle', 'omegle\u0001', 'photo dump'];
  withEasyFilmRequirement(undefined, () => {
    withEasyFilmExemptTypes(invalid.join(','), () => {
      assert.deepStrictEqual(rankedReels(sqlite, {}), []);
      assert.doesNotMatch(buildMeFeedQuery(['talking']).sql, /posts\.content_type IN \(/);
    });
    withEasyFilmExemptTypes([...invalid, 'photo-dump', 'talking'].join(','), () => {
      const { sql } = buildMeFeedQuery(['talking']);
      assert.ok(sql.includes("posts.content_type IN ('photo-dump', 'talking')"));
      for (const value of invalid) assert.ok(!sql.includes(value), 'invalid token stays outside SQL');
      assert.deepStrictEqual(rankedReels(sqlite, {}).sort((a, b) => a - b), [2, 3]);
    });
  });
  sqlite.close();
});

test('React exemptions preserve model scope, visibility and ascending niche/look/taste placeholders', () => {
  const sqlite = makeReactLayoutPostsDb();
  sqlite.exec(`INSERT INTO model_creators VALUES (7,'mine');
    INSERT INTO posts (id,account_handle,content_type,posted_at,video_cache_status,ai_layout,archived,soft_deleted,sort_status) VALUES
    (5,'other','omegle','2026-11-15','cached','split_screen',0,0,'auto'),
    (6,'mine','omegle','2026-11-15','pending','split_screen',0,0,'auto'),
    (7,'mine','omegle','2026-11-15','cached','split_screen',1,0,'auto'),
    (8,'mine','omegle','2026-11-15','cached','split_screen',0,1,'auto'),
    (9,'mine','omegle','2026-11-15','cached','split_screen',0,0,'unsorted'),
    (10,'mine','omegle','2026-11-15','cached','split_screen',0,0,'auto'),
    (11,'mine','omegle','2026-11-15','cached','split_screen',0,0,'auto'),
    (12,'mine','omegle','2026-11-15','cached','split_screen',0,0,'auto');
    INSERT INTO model_saved_posts VALUES (7,10);
    INSERT INTO model_post_feedback VALUES (7,11,'not_my_style');
    INSERT INTO model_assigned_posts VALUES (7,12,'assigned')`);
  withEasyFilmRequirement(undefined, () => withEasyFilmExemptTypes(undefined, () => {
    const options = { modelId: 7, niche: 'omegle', lookTags: ['alt'],
      taste: { types: [['omegle', 0.5]], tags: [['alt', -0.25]], creators: [['mine', 0.5]] } };
    const withExemption = buildMeFeedQuery(['talking'], options);
    assert.deepStrictEqual(rankedReels(sqlite, options), [1]);
    withEasyFilmExemptTypes('', () => {
      assert.deepStrictEqual(rankedReels(sqlite, options), []);
      assert.deepStrictEqual(buildMeFeedQuery(['talking'], options).params, withExemption.params,
        'validated exemptions add no bind slots');
    });
    withEasyFilmRequirement('0', () => {
      assert.deepStrictEqual(rankedReels(sqlite, { ...options, niche: 'talking' }), [2]);
    });
  }));
  sqlite.close();
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
  assert.deepStrictEqual(params, ['talking', 7, 7, 7, 7, 7, 24, 0]);
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
  assert.match(buildMeFeedQuery(['talking'], { lookTags: [] }).sql, /COALESCE\(posts\.perf_score, 0\) \* 1/);
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
      assert.match(query.sql, /COALESCE\(posts\.perf_score, 0\) \* 1/);
      withPerfWeight(undefined, () => assert.deepStrictEqual(query, buildMeFeedQuery(['talking'])));
    });
  });
}

function withCreatorSpread(value, run) {
  const previous = process.env.FEED_CREATOR_SPREAD;
  if (value === undefined) delete process.env.FEED_CREATOR_SPREAD;
  else process.env.FEED_CREATOR_SPREAD = value;
  try { run(); } finally {
    if (previous === undefined) delete process.env.FEED_CREATOR_SPREAD;
    else process.env.FEED_CREATOR_SPREAD = previous;
  }
}

function makeCreatorSpreadDb(t) {
  const sqlite = makePostsDb();
  t.after(() => sqlite.close());
  const insert = sqlite.prepare(`INSERT INTO posts
    (id,account_handle,content_type,posted_at,video_cache_status,perf_score)
    VALUES (?,?,'talking','2026-11-15','cached',?)`);
  for (const [id, creator, score] of [
    [1, 'a', 100], [2, 'a', 99], [3, 'a', 98], [4, 'a', 97], [5, 'a', 96], [6, 'a', 95],
    [7, 'b', 50], [8, 'b', 49], [9, 'c', 40], [10, 'c', 39],
  ]) insert.run(id, creator, score);
  return sqlite;
}

test('creator spread defaults to two reels per creator in each score-ranked round', (t) => {
  const sqlite = makeCreatorSpreadDb(t);
  withPerfWeight(undefined, () => withCreatorSpread(undefined, () => {
    assert.deepStrictEqual(rankedReels(sqlite, {}), [1, 2, 7, 8, 9, 10, 3, 4, 5, 6]);
  }));
});

test('zero creator spread restores the exact legacy ordering and bind parameters', (t) => {
  const sqlite = makeCreatorSpreadDb(t);
  withPerfWeight(undefined, () => withCreatorSpread('0', () => {
    assert.deepStrictEqual(rankedReels(sqlite, {}), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const { sql, params } = buildMeFeedQuery(['talking'], { page: 2, limit: 4 });
    assert.doesNotMatch(sql, /ROW_NUMBER|creator_pos|rank_score|niche_rank/);
    assert.match(sql, /ORDER BY CASE WHEN CASE WHEN posts\.sort_status IN \('auto','manual'\) THEN posts\.content_type ELSE NULL END IN \(\$1\) THEN 1 ELSE 0 END DESC, \(COALESCE\(posts\.perf_score, 0\) \* 1\) DESC, posts\.posted_at DESC\s+LIMIT \$2 OFFSET \$3/);
    assert.deepStrictEqual(params, ['talking', 4, 4]);
    withPerfWeight('0', () => {
      assert.match(buildMeFeedQuery([], { all: true }).sql, /ORDER BY posts\.posted_at DESC\s+LIMIT/);
    });
  }));
});

test('creator spread keeps every preferred-niche reel first and resets rounds per niche rank', (t) => {
  const sqlite = makePostsDb();
  t.after(() => sqlite.close());
  sqlite.exec(`INSERT INTO posts (id,account_handle,content_type,posted_at,video_cache_status,perf_score) VALUES
    (1,'a','talking','2026-11-15','cached',100),(2,'a','talking','2026-11-15','cached',90),
    (3,'a','talking','2026-11-15','cached',80),(4,'a','dance','2026-11-15','cached',70),
    (5,'a','dance','2026-11-15','cached',60),(6,'b','dance','2026-11-15','cached',50),
    (7,'b','dance','2026-11-15','cached',40), (8,'c','dance','2026-11-16','cached',1000)`);
  withPerfWeight(undefined, () => withCreatorSpread(undefined, () => {
    assert.deepStrictEqual(rankedReels(sqlite, {}), [1, 2, 3, 8, 4, 5, 6, 7]);
  }));
});

test('creator spread groups account handles without case sensitivity', (t) => {
  const sqlite = makePostsDb();
  t.after(() => sqlite.close());
  sqlite.exec(`INSERT INTO posts (id,account_handle,content_type,posted_at,video_cache_status,perf_score) VALUES
    (1,'Alice','talking','2026-11-15','cached',100),(2,'alice','talking','2026-11-15','cached',90),
    (3,'ALICE','talking','2026-11-15','cached',80),(4,'aLiCe','talking','2026-11-15','cached',70),
    (5,'bob','talking','2026-11-15','cached',60),(6,'BOB','talking','2026-11-15','cached',50)`);
  withPerfWeight(undefined, () => withCreatorSpread(undefined, () => {
    assert.deepStrictEqual(rankedReels(sqlite, {}), [1, 2, 5, 6, 3, 4]);
  }));
});

test('creator spread applies pagination after ranking and preserves pageSize lookahead', (t) => {
  const sqlite = makeCreatorSpreadDb(t);
  withPerfWeight(undefined, () => withCreatorSpread(undefined, () => {
    const expected = [1, 2, 7, 8, 9, 10, 3, 4, 5, 6];
    const first = rankedReels(sqlite, { page: 1, limit: 5 });
    const second = rankedReels(sqlite, { page: 2, limit: 5 });
    assert.deepStrictEqual([...first, ...second], expected);
    assert.equal(new Set([...first, ...second]).size, expected.length, 'pages never repeat a reel');
    assert.deepStrictEqual(rankedReels(sqlite, { page: 1, limit: 5 }), first, 'repeated pages are stable');

    const lookaheadPages = [1, 2, 3].map(page => rankedReels(sqlite, { page, limit: 5, pageSize: 4 }));
    assert.deepStrictEqual(lookaheadPages, [expected.slice(0, 5), expected.slice(4, 9), expected.slice(8)]);
    assert.deepStrictEqual(lookaheadPages.flatMap(rows => rows.slice(0, 4)), expected,
      'discarding each lookahead row loses no reels between pages');
  }));
});

test('creator spread uses posted date and id to break score ties consistently', (t) => {
  const sqlite = makePostsDb();
  t.after(() => sqlite.close());
  sqlite.exec(`INSERT INTO posts (id,account_handle,content_type,posted_at,video_cache_status) VALUES
    (1,'a','talking','2026-11-14','cached'),(2,'a','talking','2026-11-15','cached'),
    (3,'a','talking','2026-11-15','cached'),(4,'b','talking','2026-11-15','cached'),
    (5,'b','talking','2026-11-15','cached')`);
  withPerfWeight(undefined, () => withCreatorSpread(undefined, () => {
    assert.deepStrictEqual(rankedReels(sqlite, {}), [5, 4, 3, 2, 1]);
    assert.deepStrictEqual(rankedReels(sqlite, { page: 2, limit: 2 }), [3, 2]);
  }));
});

test('creator spread works with no rank terms or niche ordering and retains post columns', (t) => {
  const sqlite = makeCreatorSpreadDb(t);
  withPerfWeight('0', () => withCreatorSpread(undefined, () => {
    assert.deepStrictEqual(rankedReels(sqlite, { all: true }), [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    const { sql, params } = buildMeFeedQuery([], { all: true });
    assert.doesNotMatch(sql, /perf_score/);
    const rows = sqlite.prepare(sql.replace(/\$\d+/g, '?')).all(...params);
    const post = sqlite.prepare('SELECT * FROM posts WHERE id = ?').get(rows[0].id);
    for (const [column, value] of Object.entries(post)) assert.deepStrictEqual(rows[0][column], value, column);
    assert.equal(rows[0].niche, 'talking');
  }));
});

test('creator spread preserves one ascending placeholder per bind with scope, filters, look and taste', (t) => {
  const sqlite = makeCreatorSpreadDb(t);
  sqlite.exec("INSERT INTO model_creators VALUES (7,'a'),(7,'b'),(7,'c')");
  withPerfWeight(undefined, () => withCreatorSpread(undefined, () => {
    const options = { modelId: 7, niche: 'talking', lookTags: ['alt', 'bedroom'],
      taste: { types: [['talking', 0.5]], tags: [['alt', -0.25]], creators: [['a', 0.5]] } };
    assert.deepStrictEqual(rankedReels(sqlite, options), [1, 2, 7, 8, 9, 10, 3, 4, 5, 6]);
  }));
});

test('shuffle query stays unchanged for every creator spread setting', () => {
  const options = { modelId: 7, niche: 'talking', shuffle: true, lookTags: ['alt'],
    taste: { creators: [['a', 1]] }, page: 2, limit: 25, pageSize: 24 };
  let baseline;
  withCreatorSpread(undefined, () => { baseline = buildMeFeedQuery(['talking'], options); });
  for (const value of ['0', '1', '3', 'invalid']) {
    withCreatorSpread(value, () => assert.deepStrictEqual(buildMeFeedQuery(['talking'], options), baseline));
  }
  assert.match(baseline.sql, /ORDER BY RANDOM\(\)/);
  assert.doesNotMatch(baseline.sql, /ROW_NUMBER|creator_pos|rank_score|niche_rank/);
});

for (const [value, expected] of [
  ['1', [1, 7, 9, 2, 8, 10, 3, 4, 5, 6]],
  ['3', [1, 2, 3, 7, 8, 9, 10, 4, 5, 6]],
]) {
  test(`FEED_CREATOR_SPREAD=${value} uses the configured positive integer round size`, (t) => {
    const sqlite = makeCreatorSpreadDb(t);
    withPerfWeight(undefined, () => withCreatorSpread(value, () => {
      assert.deepStrictEqual(rankedReels(sqlite, {}), expected);
    }));
  });
}

for (const value of ['', ' ', '-1', '1.5', 'NaN', 'Infinity', '2garbage', '2; SELECT 1']) {
  test(`invalid creator spread ${JSON.stringify(value)} falls back to two`, () => {
    let baseline;
    withCreatorSpread(undefined, () => { baseline = buildMeFeedQuery(['talking']); });
    withCreatorSpread(value, () => assert.deepStrictEqual(buildMeFeedQuery(['talking']), baseline));
  });
}
