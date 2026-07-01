const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');

// Mirrors the suggested_reels schema + insert with $n → ? (dual-mode shim).
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE suggested_reels (
    id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, shortcode TEXT UNIQUE NOT NULL,
    thumbnail_url TEXT, video_url TEXT, view_count INTEGER DEFAULT 0, like_count INTEGER DEFAULT 0,
    comment_count INTEGER DEFAULT 0, permalink TEXT, posted_at TEXT, rank INTEGER DEFAULT 0,
    captured_at TEXT DEFAULT (datetime('now'))
  )`);
  return db;
}
const INS = `INSERT INTO suggested_reels (username, shortcode, thumbnail_url, video_url, view_count, like_count, comment_count, permalink, posted_at, rank)
   VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT (shortcode) DO NOTHING`;
const ins = (db, r) => db.prepare(INS).run(r.username, r.shortcode, r.thumbnailUrl, r.videoUrl, r.viewCount, r.likeCount, r.commentCount, r.permalink, r.postedAt, r.rank);
const R = (o) => ({ username: 'u', shortcode: 's', thumbnailUrl: 't', videoUrl: 'v', viewCount: 100, likeCount: 5, commentCount: 1, permalink: 'p', postedAt: null, rank: 1, ...o });

test('suggested_reels: 10-column insert round-trips', () => {
  const db = makeDb();
  ins(db, R({ shortcode: 'abc', viewCount: 900, rank: 1 }));
  const row = db.prepare("SELECT * FROM suggested_reels WHERE shortcode='abc'").get();
  assert.strictEqual(row.username, 'u');
  assert.strictEqual(row.view_count, 900);
  assert.strictEqual(row.rank, 1);
});

test('suggested_reels: ON CONFLICT (shortcode) DO NOTHING is idempotent', () => {
  const db = makeDb();
  ins(db, R({ shortcode: 'dup', viewCount: 100 }));
  ins(db, R({ shortcode: 'dup', viewCount: 999 })); // same shortcode → ignored
  const rows = db.prepare("SELECT view_count FROM suggested_reels WHERE shortcode='dup'").all();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].view_count, 100);
});
