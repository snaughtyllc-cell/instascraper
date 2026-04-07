const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'instascraper.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shortcode TEXT UNIQUE NOT NULL,
    video_url TEXT,
    thumbnail_url TEXT,
    caption TEXT,
    like_count INTEGER DEFAULT 0,
    comment_count INTEGER DEFAULT 0,
    view_count INTEGER DEFAULT 0,
    posted_at TEXT,
    account_handle TEXT,
    post_url TEXT,
    tag TEXT DEFAULT NULL,
    notes TEXT DEFAULT '',
    scraped_at TEXT DEFAULT (datetime('now')),
    source_query TEXT
  );

  CREATE TABLE IF NOT EXISTS scrape_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query TEXT NOT NULL,
    query_type TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    apify_run_id TEXT,
    posts_found INTEGER DEFAULT 0,
    progress INTEGER DEFAULT 0,
    status_message TEXT DEFAULT '',
    error TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT
  );
`);

// Migrations (safe to re-run)
const migrations = [
  `ALTER TABLE posts ADD COLUMN archived INTEGER DEFAULT 0`,
  `ALTER TABLE posts ADD COLUMN content_type TEXT DEFAULT NULL`,
  `ALTER TABLE posts ADD COLUMN followers_at_scrape INTEGER DEFAULT 0`,
  `ALTER TABLE posts ADD COLUMN er_percent REAL DEFAULT 0`,
  `ALTER TABLE posts ADD COLUMN er_label TEXT DEFAULT NULL`,
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (e) { /* column already exists */ }
}

// Creator content types table
db.exec(`
  CREATE TABLE IF NOT EXISTS creator_types (
    account_handle TEXT PRIMARY KEY,
    content_type TEXT NOT NULL
  );
`);

module.exports = db;
