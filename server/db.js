const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
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
      scraped_at TEXT DEFAULT TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      source_query TEXT,
      archived INTEGER DEFAULT 0,
      content_type TEXT DEFAULT NULL,
      followers_at_scrape INTEGER DEFAULT 0,
      er_percent REAL DEFAULT 0,
      er_label TEXT DEFAULT NULL,
      soft_deleted INTEGER DEFAULT 0,
      soft_deleted_at TEXT DEFAULT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS scrape_jobs (
      id SERIAL PRIMARY KEY,
      query TEXT NOT NULL,
      query_type TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      apify_run_id TEXT,
      posts_found INTEGER DEFAULT 0,
      progress INTEGER DEFAULT 0,
      status_message TEXT DEFAULT '',
      error TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      completed_at TEXT,
      source TEXT DEFAULT 'manual'
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS creator_types (
      account_handle TEXT PRIMARY KEY,
      content_type TEXT NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tracked_accounts (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      status TEXT DEFAULT 'active',
      tags TEXT DEFAULT '',
      followers INTEGER DEFAULT 0,
      bio TEXT DEFAULT '',
      avg_er REAL DEFAULT 0,
      last_scraped_at TEXT,
      last_post_count INTEGER DEFAULT 0,
      added_at TEXT DEFAULT TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      updated_at TEXT DEFAULT TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS engagement_rollups (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      week_start TEXT NOT NULL,
      week_end TEXT NOT NULL,
      post_count INTEGER DEFAULT 0,
      avg_er REAL DEFAULT 0,
      max_er REAL DEFAULT 0,
      total_likes INTEGER DEFAULT 0,
      total_comments INTEGER DEFAULT 0,
      total_views INTEGER DEFAULT 0,
      followers_snapshot INTEGER DEFAULT 0,
      computed_at TEXT DEFAULT TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      UNIQUE(username, week_start)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS deletion_log (
      id SERIAL PRIMARY KEY,
      post_id INTEGER NOT NULL,
      shortcode TEXT NOT NULL,
      account_handle TEXT,
      reason TEXT,
      deleted_at TEXT DEFAULT TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      restored_at TEXT DEFAULT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS suggested_accounts (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      source TEXT NOT NULL,
      followers INTEGER DEFAULT 0,
      avg_er REAL DEFAULT 0,
      posts_per_week REAL DEFAULT 0,
      bio TEXT DEFAULT '',
      content_breakdown TEXT DEFAULT '',
      top_hashtags TEXT DEFAULT '',
      relevance_reason TEXT DEFAULT '',
      suggestion_score REAL DEFAULT 0,
      status TEXT DEFAULT 'pending',
      snoozed_until TEXT DEFAULT NULL,
      discovered_at TEXT DEFAULT TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      reviewed_at TEXT
    )
  `);

  // Migrations for existing tables (safe to re-run)
  const migrations = [
    `ALTER TABLE posts ADD COLUMN IF NOT EXISTS soft_deleted INTEGER DEFAULT 0`,
    `ALTER TABLE posts ADD COLUMN IF NOT EXISTS soft_deleted_at TEXT DEFAULT NULL`,
    `ALTER TABLE scrape_jobs ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual'`,
  ];
  for (const sql of migrations) {
    try { await pool.query(sql); } catch (e) { /* column already exists */ }
  }

  console.log('Database initialized');
}

initDB().catch(console.error);

module.exports = pool;
