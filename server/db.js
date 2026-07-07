const path = require('path');

const USE_PG = !!process.env.DATABASE_URL;

// ─── Unified DB interface: .query(sql, params) → { rows } ──────
let db;

if (USE_PG) {
  // PostgreSQL (Railway cloud)
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('railway') ? { rejectUnauthorized: false } : false,
  });
  pool.on('error', (err) => console.error('[DB] idle client error:', err.code || err.message));
  db = {
    query: (sql, params) => pool.query(sql, params),
    _pool: pool,
  };
} else {
  // SQLite (local dev)
  const Database = require('better-sqlite3');
  const sqlite = new Database(path.join(__dirname, 'instascraper.db'));
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  db = {
    query: (sql, params = []) => {
      // Convert PostgreSQL $1,$2 placeholders to SQLite ?
      let convertedSql = sql;
      let convertedParams = params;
      if (sql.includes('$')) {
        convertedSql = sql.replace(/\$(\d+)/g, '?');
      }
      // Convert PostgreSQL-specific syntax to SQLite
      convertedSql = convertedSql.replace(/SERIAL PRIMARY KEY/gi, 'INTEGER PRIMARY KEY AUTOINCREMENT');
      convertedSql = convertedSql.replace(/TO_CHAR\(NOW\(\),\s*'[^']*'\)/gi, "datetime('now')");
      convertedSql = convertedSql.replace(/TO_CHAR\(NOW\(\)\s*-\s*INTERVAL\s*'(\d+)\s*days',\s*'[^']*'\)/gi, "datetime('now', '-$1 days')");
      convertedSql = convertedSql.replace(/TO_CHAR\(NOW\(\)\s*\+\s*INTERVAL\s*'(\d+)\s*days',\s*'[^']*'\)/gi, "datetime('now', '+$1 days')");
      convertedSql = convertedSql.replace(/ILIKE/gi, 'LIKE');
      convertedSql = convertedSql.replace(/::numeric/gi, '');
      convertedSql = convertedSql.replace(/IF NOT EXISTS/gi, 'IF NOT EXISTS');
      convertedSql = convertedSql.replace(/ADD COLUMN IF NOT EXISTS/gi, 'ADD COLUMN');
      // FILTER (WHERE ...) → not supported in SQLite, handled per-query
      convertedSql = convertedSql.replace(/COUNT\(\*\)\s*FILTER\s*\(WHERE\s+([^)]+)\)/gi, "SUM(CASE WHEN $1 THEN 1 ELSE 0 END)");

      const trimmed = convertedSql.trim();
      const isSelect = /^SELECT/i.test(trimmed);
      const isInsert = /^INSERT/i.test(trimmed);
      const isCreate = /^CREATE/i.test(trimmed);

      try {
        if (isSelect) {
          const rows = sqlite.prepare(convertedSql).all(...convertedParams);
          return { rows, rowCount: rows.length };
        } else if (isInsert) {
          const stmt = sqlite.prepare(convertedSql);
          if (/RETURNING\s+/i.test(convertedSql)) {
            // INSERT ... RETURNING col1, col2 — a "reader" statement in
            // better-sqlite3; use get() to fetch the actual returned row
            // (mirrors what `pg` gives back for RETURNING on Postgres).
            const row = stmt.get(...convertedParams);
            return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
          }
          const info = stmt.run(...convertedParams);
          return { rows: [{ id: info.lastInsertRowid }], rowCount: info.changes };
        } else if (isCreate) {
          sqlite.exec(convertedSql);
          return { rows: [], rowCount: 0 };
        } else {
          const info = sqlite.prepare(convertedSql).run(...convertedParams);
          return { rows: [], rowCount: info.changes };
        }
      } catch (e) {
        // Duplicate column or table already exists — ignore safely
        if (e.message.includes('duplicate column') || e.message.includes('already exists')) {
          return { rows: [], rowCount: 0 };
        }
        throw e;
      }
    },
  };
}

// ─── Initialize tables ──────────────────────────────────────────
async function initDB() {
  const NOW_DEFAULT = USE_PG
    ? `TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`
    : `(datetime('now'))`;
  const SERIAL = USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';

  await db.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id ${SERIAL},
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
      scraped_at TEXT DEFAULT ${NOW_DEFAULT},
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

  await db.query(`
    CREATE TABLE IF NOT EXISTS scrape_jobs (
      id ${SERIAL},
      query TEXT NOT NULL,
      query_type TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      apify_run_id TEXT,
      posts_found INTEGER DEFAULT 0,
      progress INTEGER DEFAULT 0,
      status_message TEXT DEFAULT '',
      error TEXT,
      created_at TEXT DEFAULT ${NOW_DEFAULT},
      completed_at TEXT,
      source TEXT DEFAULT 'manual'
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS creator_types (
      account_handle TEXT PRIMARY KEY,
      content_type TEXT NOT NULL
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS content_types (
      id ${SERIAL},
      value TEXT UNIQUE NOT NULL,
      label TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT ${NOW_DEFAULT}
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS tracked_accounts (
      id ${SERIAL},
      username TEXT UNIQUE NOT NULL,
      status TEXT DEFAULT 'active',
      tags TEXT DEFAULT '',
      followers INTEGER DEFAULT 0,
      bio TEXT DEFAULT '',
      avg_er REAL DEFAULT 0,
      last_scraped_at TEXT,
      last_post_count INTEGER DEFAULT 0,
      added_at TEXT DEFAULT ${NOW_DEFAULT},
      updated_at TEXT DEFAULT ${NOW_DEFAULT}
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS engagement_rollups (
      id ${SERIAL},
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
      computed_at TEXT DEFAULT ${NOW_DEFAULT},
      UNIQUE(username, week_start)
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS deletion_log (
      id ${SERIAL},
      post_id INTEGER NOT NULL,
      shortcode TEXT NOT NULL,
      account_handle TEXT,
      reason TEXT,
      deleted_at TEXT DEFAULT ${NOW_DEFAULT},
      restored_at TEXT DEFAULT NULL
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS suggested_accounts (
      id ${SERIAL},
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
      discovered_at TEXT DEFAULT ${NOW_DEFAULT},
      reviewed_at TEXT
    )
  `);

  // Model profiles for AI content ideas
  await db.query(`
    CREATE TABLE IF NOT EXISTS models (
      id ${SERIAL},
      name TEXT NOT NULL,
      primary_niche TEXT NOT NULL,
      secondary_niches TEXT DEFAULT '',
      delivery_method TEXT DEFAULT 'whatsapp',
      delivery_contact TEXT DEFAULT '',
      delivery_day TEXT DEFAULT 'monday',
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT ${NOW_DEFAULT},
      updated_at TEXT DEFAULT ${NOW_DEFAULT}
    )
  `);

  // AI-generated idea cards
  await db.query(`
    CREATE TABLE IF NOT EXISTS idea_cards (
      id ${SERIAL},
      model_id INTEGER NOT NULL,
      batch_id TEXT NOT NULL,
      concept TEXT NOT NULL,
      format TEXT DEFAULT '',
      why_working TEXT DEFAULT '',
      hook_line TEXT DEFAULT '',
      source_niche TEXT DEFAULT '',
      source_post_ids TEXT DEFAULT '',
      stale_warning TEXT DEFAULT NULL,
      status TEXT DEFAULT 'pending',
      delivered_at TEXT DEFAULT NULL,
      created_at TEXT DEFAULT ${NOW_DEFAULT}
    )
  `);

  // Delivery log
  await db.query(`
    CREATE TABLE IF NOT EXISTS idea_delivery_log (
      id ${SERIAL},
      model_id INTEGER NOT NULL,
      batch_id TEXT NOT NULL,
      delivery_method TEXT NOT NULL,
      delivery_status TEXT DEFAULT 'pending',
      error TEXT DEFAULT NULL,
      sent_at TEXT DEFAULT ${NOW_DEFAULT}
    )
  `);

  // Apify run cost ledger (one row per actor run) — see Sub-C cost control
  await db.query(`
    CREATE TABLE IF NOT EXISTS apify_runs (
      id ${SERIAL},
      run_id TEXT UNIQUE NOT NULL,
      actor_id TEXT,
      purpose TEXT,
      query TEXT,
      status TEXT DEFAULT 'running',
      results_count INTEGER DEFAULT 0,
      usage_usd REAL DEFAULT 0,
      scrape_job_id INTEGER,
      started_at TEXT DEFAULT ${NOW_DEFAULT},
      completed_at TEXT
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS watch_terms (
      id ${SERIAL},
      term TEXT NOT NULL,
      kind TEXT DEFAULT 'hashtag',
      source TEXT DEFAULT 'auto',
      status TEXT DEFAULT 'active',
      model_id INTEGER DEFAULT NULL,
      added_at TEXT DEFAULT ${NOW_DEFAULT},
      last_run_at TEXT DEFAULT NULL,
      notes TEXT DEFAULT '',
      UNIQUE(term, kind)
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS radar_reels (
      id ${SERIAL},
      shortcode TEXT UNIQUE NOT NULL,
      account_handle TEXT,
      video_url TEXT,
      thumbnail_url TEXT,
      caption TEXT,
      like_count INTEGER DEFAULT 0,
      comment_count INTEGER DEFAULT 0,
      view_count INTEGER,
      posted_at TEXT,
      post_url TEXT,
      discovered_via TEXT,
      author_followers INTEGER DEFAULT NULL,
      author_median_views INTEGER DEFAULT NULL,
      breakout_score REAL DEFAULT 0,
      niche_fit_score REAL DEFAULT 0,
      total_score REAL DEFAULT 0,
      status TEXT DEFAULT 'new',
      discovered_at TEXT DEFAULT ${NOW_DEFAULT}
    )
  `);

  // Migrations for existing tables
  if (USE_PG) {
    const migrations = [
      `ALTER TABLE posts ADD COLUMN IF NOT EXISTS soft_deleted INTEGER DEFAULT 0`,
      `ALTER TABLE posts ADD COLUMN IF NOT EXISTS soft_deleted_at TEXT DEFAULT NULL`,
      `ALTER TABLE scrape_jobs ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual'`,
      `ALTER TABLE posts ADD COLUMN IF NOT EXISTS thumbnail_cache_status TEXT`,
      `ALTER TABLE posts ADD COLUMN IF NOT EXISTS thumbnail_cache_error TEXT`,
      `ALTER TABLE suggested_accounts ADD COLUMN IF NOT EXISTS gender TEXT DEFAULT 'unknown'`,
      `ALTER TABLE posts ADD COLUMN IF NOT EXISTS tagged_users TEXT DEFAULT NULL`,
      `ALTER TABLE tracked_accounts ADD COLUMN IF NOT EXISTS last_attempt_at TEXT DEFAULT NULL`,
      `ALTER TABLE tracked_accounts ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER DEFAULT 0`,
      `ALTER TABLE tracked_accounts ADD COLUMN IF NOT EXISTS last_discovery_at TEXT DEFAULT NULL`,
    ];
    for (const sql of migrations) {
      try { await db.query(sql); } catch (e) { /* ignore */ }
    }
  } else {
    const migrations = [
      `ALTER TABLE posts ADD COLUMN soft_deleted INTEGER DEFAULT 0`,
      `ALTER TABLE posts ADD COLUMN soft_deleted_at TEXT DEFAULT NULL`,
      `ALTER TABLE scrape_jobs ADD COLUMN source TEXT DEFAULT 'manual'`,
      `ALTER TABLE posts ADD COLUMN thumbnail_cache_status TEXT`,
      `ALTER TABLE posts ADD COLUMN thumbnail_cache_error TEXT`,
      `ALTER TABLE suggested_accounts ADD COLUMN gender TEXT DEFAULT 'unknown'`,
      `ALTER TABLE posts ADD COLUMN tagged_users TEXT DEFAULT NULL`,
      `ALTER TABLE tracked_accounts ADD COLUMN last_attempt_at TEXT DEFAULT NULL`,
      `ALTER TABLE tracked_accounts ADD COLUMN consecutive_failures INTEGER DEFAULT 0`,
      `ALTER TABLE tracked_accounts ADD COLUMN last_discovery_at TEXT DEFAULT NULL`,
    ];
    for (const sql of migrations) {
      try { await db.query(sql); } catch (e) { /* column already exists */ }
    }
  }

  const { seedContentTypes } = require('./content-types');
  await seedContentTypes(db);

  console.log(`Database initialized (${USE_PG ? 'PostgreSQL' : 'SQLite'})`);
}

module.exports = db;
module.exports.initDB = initDB;
