const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');

// Mirror of the SQLite DDL initDB will create (asserts the shape is creatable & insertable).
function makeSchema(db) {
  db.exec(`CREATE TABLE watch_terms (
    id INTEGER PRIMARY KEY AUTOINCREMENT, term TEXT, kind TEXT, source TEXT,
    status TEXT DEFAULT 'active', model_id INTEGER DEFAULT NULL,
    added_at TEXT, last_run_at TEXT DEFAULT NULL, notes TEXT DEFAULT '',
    UNIQUE(term, kind))`);
  db.exec(`CREATE TABLE radar_reels (
    id INTEGER PRIMARY KEY AUTOINCREMENT, shortcode TEXT UNIQUE NOT NULL, account_handle TEXT,
    video_url TEXT, thumbnail_url TEXT, caption TEXT,
    like_count INTEGER, comment_count INTEGER, view_count INTEGER,
    posted_at TEXT, post_url TEXT, discovered_via TEXT,
    author_followers INTEGER DEFAULT NULL, author_median_views INTEGER DEFAULT NULL,
    breakout_score REAL DEFAULT 0, niche_fit_score REAL DEFAULT 0, total_score REAL DEFAULT 0,
    status TEXT DEFAULT 'new', discovered_at TEXT)`);
}

test('schema: watch_terms enforces UNIQUE(term,kind) and radar_reels UNIQUE(shortcode)', () => {
  const db = new Database(':memory:');
  makeSchema(db);
  db.prepare("INSERT INTO watch_terms (term,kind,source) VALUES ('fitgirl','hashtag','auto')").run();
  assert.throws(() => db.prepare("INSERT INTO watch_terms (term,kind,source) VALUES ('fitgirl','hashtag','admin')").run());
  db.prepare("INSERT INTO radar_reels (shortcode,account_handle) VALUES ('ABC','x')").run();
  assert.throws(() => db.prepare("INSERT INTO radar_reels (shortcode,account_handle) VALUES ('ABC','y')").run());
});
