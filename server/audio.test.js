// server/audio.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { audioConfig, trendScore, buildTrendingAudioQuery, buildAudioReelsQuery, trendingAudio } = require('./audio');

const NOW = Date.parse('2026-07-08T00:00:00.000Z');
const cfg = audioConfig({}); // defaults
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();

function makeDb() {
  const s = new Database(':memory:');
  s.exec(`CREATE TABLE posts (
    id INTEGER PRIMARY KEY, shortcode TEXT, content_type TEXT, account_handle TEXT, posted_at TEXT,
    view_count INTEGER, caption TEXT, post_url TEXT, video_cache_status TEXT,
    soft_deleted INTEGER DEFAULT 0, archived INTEGER DEFAULT 0,
    audio_id TEXT, audio_title TEXT, audio_author TEXT, is_original_audio INTEGER)`);
  s.exec(`CREATE TABLE creator_types (account_handle TEXT, content_type TEXT)`);
  // a tiny adapter so trendingAudio(db,...) can run: .query(sql, params) → {rows}
  return {
    sqlite: s,
    query: (sql, params = []) => ({ rows: s.prepare(sql.replace(/\$\d+/g, '?')).all(...params) }),
  };
}

test('trendScore: more distinct creators outranks fewer (same reach/recency)', () => {
  const spread = { creator_count: 5, reel_count: 6, total_views: 100000, latest_posted_at: daysAgo(1) };
  const narrow = { creator_count: 1, reel_count: 6, total_views: 100000, latest_posted_at: daysAgo(1) };
  assert.ok(trendScore(spread, cfg, NOW) > trendScore(narrow, cfg, NOW));
});

test('trendScore: recent outranks stale (same everything else)', () => {
  const fresh = { creator_count: 3, reel_count: 4, total_views: 50000, latest_posted_at: daysAgo(1) };
  const stale = { creator_count: 3, reel_count: 4, total_views: 50000, latest_posted_at: daysAgo(28) };
  assert.ok(trendScore(fresh, cfg, NOW) > trendScore(stale, cfg, NOW));
});

test('buildTrendingAudioQuery: null when not all and no niches', () => {
  assert.deepStrictEqual(buildTrendingAudioQuery([], { cutoffIso: daysAgo(30) }), { sql: null, params: [] });
});

test('buildTrendingAudioQuery all:true groups by audio, HAVING minReels, excludes null/old/archived', () => {
  const db = makeDb();
  db.sqlite.prepare(`INSERT INTO posts (id, account_handle, posted_at, view_count, audio_id, audio_title, is_original_audio, archived, soft_deleted) VALUES
    (1,'a','${daysAgo(1)}',100,'A','Song A',0,0,0),
    (2,'b','${daysAgo(2)}',200,'A','Song A',0,0,0),
    (3,'a','${daysAgo(3)}',300,'B','Song B',0,0,0),
    (4,'c','${daysAgo(1)}',150,'C','orig',1,0,0),
    (5,'d','${daysAgo(2)}',150,'C','orig',1,0,0),
    (6,'e','${daysAgo(40)}',999,'A','Song A',0,0,0),
    (7,'f','${daysAgo(1)}',500,NULL,NULL,0,0,0),
    (8,'g','${daysAgo(1)}',500,'A','Song A',0,1,0)`).run();
  const { sql, params } = buildTrendingAudioQuery([], { all: true, cutoffIso: daysAgo(30), minReels: 2 });
  const rows = db.query(sql, params).rows;
  const byId = Object.fromEntries(rows.map(r => [r.audio_id, r]));
  // A: reels 1,2 count (6 is >30d, 8 is archived → excluded) → reel_count 2, creators 2
  assert.ok(byId.A, 'audio A present (2 recent reels)');
  assert.strictEqual(byId.A.reel_count, 2);
  assert.strictEqual(byId.A.creator_count, 2);
  // B: only 1 reel → filtered by HAVING >= 2
  assert.ok(!byId.B, 'audio B excluded (single reel)');
  // C: 2 reels, original audio
  assert.ok(byId.C, 'audio C present');
  assert.strictEqual(byId.C.is_original_audio, 1);
  // null audio never groups
  assert.ok(!Object.prototype.hasOwnProperty.call(byId, 'null'));
});

test('buildTrendingAudioQuery niche-scoped: only reels in the niche counted', () => {
  const db = makeDb();
  db.sqlite.prepare(`INSERT INTO posts (id, account_handle, posted_at, view_count, audio_id, content_type) VALUES
    (1,'a','${daysAgo(1)}',100,'A','talking'),
    (2,'b','${daysAgo(1)}',100,'A','talking'),
    (3,'c','${daysAgo(1)}',100,'A','dance')`).run();
  const { sql, params } = buildTrendingAudioQuery(['talking'], { cutoffIso: daysAgo(30), minReels: 2 });
  const rows = db.query(sql, params).rows;
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].reel_count, 2, 'only the 2 talking reels; dance excluded');
});

test('buildAudioReelsQuery returns reels for one audio, ordered by views', () => {
  const db = makeDb();
  db.sqlite.prepare(`INSERT INTO posts (id, account_handle, posted_at, view_count, audio_id) VALUES
    (1,'a','${daysAgo(1)}',100,'A'),(2,'b','${daysAgo(1)}',900,'A'),(3,'c','${daysAgo(1)}',50,'B')`).run();
  const { sql, params } = buildAudioReelsQuery('A', [], { all: true, limit: 12 });
  const rows = db.query(sql, params).rows;
  assert.deepStrictEqual(rows.map(r => r.id), [2, 1], 'only audio A, highest views first');
});

test('trendingAudio end-to-end: ranks by score and attaches example reels', async () => {
  const db = makeDb();
  db.sqlite.prepare(`INSERT INTO posts (id, shortcode, account_handle, posted_at, view_count, audio_id, audio_title, audio_author) VALUES
    (1,'s1','a','${daysAgo(1)}',1000,'HOT','Viral Sound','DJ X'),
    (2,'s2','b','${daysAgo(1)}',2000,'HOT','Viral Sound','DJ X'),
    (3,'s3','c','${daysAgo(1)}',3000,'HOT','Viral Sound','DJ X'),
    (4,'s4','a','${daysAgo(2)}',500,'MILD','Okay Sound','DJ Y'),
    (5,'s5','a','${daysAgo(2)}',400,'MILD','Okay Sound','DJ Y')`).run();
  const out = await trendingAudio(db, { all: true, nowMs: NOW, examples: 2 });
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].audio_id, 'HOT', 'HOT (3 creators) ranks above MILD (1 creator)');
  assert.strictEqual(out[0].audio_title, 'Viral Sound');
  assert.strictEqual(out[0].creator_count, 3);
  assert.strictEqual(out[0].exampleReels.length, 2, 'top-2 example reels attached');
  assert.deepStrictEqual(out[0].exampleReels.map(r => r.id), [3, 2], 'examples are highest-view reels');
  assert.ok(out[0].trend_score > out[1].trend_score);
});

test('trendingAudio niche-scoped: aggregation AND example reels stay within the niche', async () => {
  const db = makeDb();
  db.sqlite.prepare(`INSERT INTO posts (id, shortcode, account_handle, posted_at, view_count, audio_id, audio_title, content_type) VALUES
    (1,'s1','a','${daysAgo(1)}',100,'A','Song A','talking'),
    (2,'s2','b','${daysAgo(1)}',200,'A','Song A','talking'),
    (3,'s3','c','${daysAgo(1)}',9999,'A','Song A','dance')`).run();
  const out = await trendingAudio(db, { niches: ['talking'], nowMs: NOW, examples: 3 });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].reel_count, 2, 'dance reel excluded from the count');
  assert.deepStrictEqual(out[0].exampleReels.map(r => r.id).sort(), [1, 2], 'the high-view dance reel is NOT an example');
});
