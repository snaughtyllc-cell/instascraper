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
    sort_status TEXT DEFAULT 'auto',
    view_count INTEGER, caption TEXT, post_url TEXT, video_cache_status TEXT,
    soft_deleted INTEGER DEFAULT 0, archived INTEGER DEFAULT 0,
    audio_id TEXT, audio_title TEXT, audio_author TEXT, is_original_audio INTEGER)`);
  s.exec(`CREATE TABLE creator_types (account_handle TEXT, content_type TEXT)`);
  s.exec(`CREATE TABLE model_creators (model_id INTEGER, username TEXT)`);
  // a tiny adapter so trendingAudio(db,...) can run: .query(sql, params) → {rows}
  return {
    sqlite: s,
    query: (sql, params = []) => {
      assert.deepStrictEqual([...sql.matchAll(/\$(\d+)/g)].map(match => Number(match[1])), params.map((_, i) => i + 1),
        'placeholders appear once in ascending order for the SQLite adapter');
      return { rows: s.prepare(sql.replace(/\$\d+/g, '?')).all(...params) };
    },
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
  db.sqlite.prepare(`INSERT INTO posts (id, account_handle, posted_at, view_count, audio_id, video_cache_status) VALUES
    (1,'a','${daysAgo(1)}',100,'A','cached'),(2,'b','${daysAgo(1)}',900,'A','cached'),
    (3,'c','${daysAgo(1)}',50,'B','cached'),(4,'d','${daysAgo(1)}',9999,'A','pending')`).run();
  const { sql, params } = buildAudioReelsQuery('A', [], { all: true, limit: 12 });
  const rows = db.query(sql, params).rows;
  assert.deepStrictEqual(rows.map(r => r.id), [2, 1], 'only audio A, highest views first');
});

test('trendingAudio end-to-end: ranks by score and attaches example reels', async () => {
  const db = makeDb();
  db.sqlite.prepare(`INSERT INTO posts (id, shortcode, account_handle, posted_at, view_count, audio_id, audio_title, audio_author, video_cache_status) VALUES
    (1,'s1','a','${daysAgo(1)}',1000,'HOT','Viral Sound','DJ X','cached'),
    (2,'s2','b','${daysAgo(1)}',2000,'HOT','Viral Sound','DJ X','cached'),
    (3,'s3','c','${daysAgo(1)}',3000,'HOT','Viral Sound','DJ X','cached'),
    (4,'s4','a','${daysAgo(2)}',500,'MILD','Okay Sound','DJ Y','cached'),
    (5,'s5','a','${daysAgo(2)}',400,'MILD','Okay Sound','DJ Y','cached')`).run();
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
  db.sqlite.prepare(`INSERT INTO posts (id, shortcode, account_handle, posted_at, view_count, audio_id, audio_title, content_type, video_cache_status) VALUES
    (1,'s1','a','${daysAgo(1)}',100,'A','Song A','talking','cached'),
    (2,'s2','b','${daysAgo(1)}',200,'A','Song A','talking','cached'),
    (3,'s3','c','${daysAgo(1)}',9999,'A','Song A','dance','cached')`).run();
  const out = await trendingAudio(db, { niches: ['talking'], nowMs: NOW, examples: 3 });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].reel_count, 2, 'dance reel excluded from the count');
  assert.deepStrictEqual(out[0].exampleReels.map(r => r.id).sort(), [1, 2], 'the high-view dance reel is NOT an example');
});

function seedUnsortedAudio(db) {
  db.sqlite.prepare(`INSERT INTO posts (id, shortcode, account_handle, posted_at, view_count, audio_id, content_type, sort_status, video_cache_status) VALUES
    (1,'sorted1','a','${daysAgo(1)}',100,'A','talking','auto','cached'),
    (2,'sorted2','b','${daysAgo(1)}',200,'A','talking','manual','cached'),
    (3,'unsorted','c','${daysAgo(1)}',9999,'A','talking','unsorted','cached')`).run();
  db.sqlite.prepare("INSERT INTO creator_types VALUES ('c', 'talking')").run();
}

test('buildTrendingAudioQuery excludes an unsorted reel audio', () => {
  const db = makeDb();
  seedUnsortedAudio(db);
  const { sql, params } = buildTrendingAudioQuery(['talking'], { cutoffIso: daysAgo(30), minReels: 2 });
  const rows = db.query(sql, params).rows;
  assert.strictEqual(rows[0].reel_count, 2);
  assert.strictEqual(rows[0].total_views, 300);
});

test('buildAudioReelsQuery excludes an unsorted reel audio', () => {
  const db = makeDb();
  seedUnsortedAudio(db);
  const { sql, params } = buildAudioReelsQuery('A', ['talking']);
  assert.deepStrictEqual(db.query(sql, params).rows.map((row) => row.id), [2, 1]);
});

test('trendingAudio example query excludes an unsorted reel audio', async () => {
  const db = makeDb();
  seedUnsortedAudio(db);
  const rows = await trendingAudio(db, { niches: ['talking'], nowMs: NOW, examples: 3 });
  assert.deepStrictEqual(rows[0].exampleReels.map((row) => row.id), [2, 1]);
});

test("trending audio for a model with creators only counts her creators' reels", async () => {
  const db = makeDb();
  db.sqlite.exec(`INSERT INTO model_creators VALUES (7,'mia.talks');
    INSERT INTO posts (id,account_handle,posted_at,content_type,audio_id,video_cache_status,view_count) VALUES
    (1,'Mia.Talks','${daysAgo(1)}','talking','A','cached',100),
    (2,'mia.talks','${daysAgo(1)}','talking','A','cached',200),
    (3,'other','${daysAgo(1)}','talking','A','cached',99999)`);
  const rows = await trendingAudio(db, { niches: ['talking'], modelId: 7, nowMs: NOW });
  assert.strictEqual(rows[0].reel_count, 2);
  assert.deepStrictEqual(rows[0].exampleReels.map(r => r.id), [2,1]);
  const built = buildAudioReelsQuery('A', ['talking'], { modelId: 7 });
  assert.deepStrictEqual(db.query(built.sql, built.params).rows.map(r => r.id), [2,1]);
  const fallback = await trendingAudio(db, { niches: ['talking'], modelId: 8, nowMs: NOW });
  assert.strictEqual(fallback[0].reel_count, 3);
});

test('model audio keeps sorted non-niche reels and ranks niche sounds and examples first', async () => {
  const db = makeDb();
  db.sqlite.exec(`INSERT INTO model_creators VALUES (7,'owned');
    INSERT INTO posts (id,shortcode,account_handle,posted_at,content_type,sort_status,audio_id,video_cache_status,view_count) VALUES
    (1,'niche','owned','${daysAgo(2)}','talking','auto','A','cached',100),
    (2,'other-type','owned','${daysAgo(1)}','dance','manual','A','cached',9000),
    (3,'other-audio1','owned','${daysAgo(1)}','dance','auto','B','cached',99000),
    (4,'other-audio2','owned','${daysAgo(1)}','dance','auto','B','cached',99900),
    (5,'unsorted','owned','${daysAgo(1)}','talking','unsorted','A','cached',999999),
    (6,'needs-look','owned','${daysAgo(1)}','talking','needs_look','A','cached',999999),
    (7,'null-type','owned','${daysAgo(1)}',NULL,'auto','A','cached',999999),
    (8,'unowned','other','${daysAgo(1)}','talking','auto','A','cached',999999)`);
  const rows = await trendingAudio(db, { niches: ['talking'], modelId: 7, nowMs: NOW, examples: 5 });
  assert.deepStrictEqual(rows.map(row => row.audio_id), ['A', 'B']);
  assert.ok(rows[0].trend_score < rows[1].trend_score, 'niche rank precedes a stronger trend score');
  assert.strictEqual(rows[0].reel_count, 2, 'only sorted owned reels contribute');
  assert.deepStrictEqual(rows[0].exampleReels.map(row => row.id), [1, 2]);
  const built = buildAudioReelsQuery('A', ['talking'], { modelId: 7 });
  assert.deepStrictEqual(db.query(built.sql, built.params).rows.map(row => row.id), [1, 2]);
});

test('zero-creator model audio includes all sorted types with niche matches first', async () => {
  const db = makeDb();
  db.sqlite.exec(`INSERT INTO posts (id,account_handle,posted_at,content_type,sort_status,audio_id,video_cache_status,view_count) VALUES
    (1,'one','${daysAgo(2)}','talking','auto','A','cached',100),
    (2,'two','${daysAgo(1)}','dance','manual','A','cached',9999),
    (3,'three','${daysAgo(1)}','talking','needs_look','A','cached',99999)`);
  const rows = await trendingAudio(db, { niches: ['talking'], modelId: 7, nowMs: NOW, examples: 5 });
  assert.strictEqual(rows[0].reel_count, 2);
  assert.deepStrictEqual(rows[0].exampleReels.map(row => row.id), [1, 2]);
  const built = buildAudioReelsQuery('A', ['talking'], { modelId: 7 });
  assert.deepStrictEqual(db.query(built.sql, built.params).rows.map(row => row.id), [1, 2]);
});

test('model audio without niches still returns sorted reels', async () => {
  const db = makeDb();
  seedUnsortedAudio(db);
  const rows = await trendingAudio(db, { modelId: 7, nowMs: NOW, examples: 5 });
  assert.strictEqual(rows[0].reel_count, 2);
  assert.deepStrictEqual(rows[0].exampleReels.map(row => row.id), [2, 1]);
  const built = buildAudioReelsQuery('A', [], { modelId: 7 });
  assert.deepStrictEqual(db.query(built.sql, built.params).rows.map(row => row.id), [2, 1]);
});
