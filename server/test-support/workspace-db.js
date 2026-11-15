const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { ensureWorkspaceTables, ensureLookTables } = require('../workspace-migration');
const { seedLookTags } = require('../look-tags');

async function makeWorkspaceDb(t) {
  const sqlite = new Database(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec(`CREATE TABLE models (id INTEGER PRIMARY KEY, name TEXT, primary_niche TEXT, secondary_niches TEXT, status TEXT DEFAULT 'active');
    INSERT INTO models (id, name, primary_niche) VALUES (1, 'Logan', 'talking'), (2, 'Gigi', 'dance');
    CREATE TABLE tracked_accounts (username TEXT PRIMARY KEY, status TEXT DEFAULT 'active', tags TEXT DEFAULT '',
      followers INTEGER DEFAULT 0, bio TEXT DEFAULT '', avg_er REAL DEFAULT 0, last_scraped_at TEXT, added_at TEXT, updated_at TEXT);
    CREATE TABLE suggested_accounts (username TEXT PRIMARY KEY, source TEXT DEFAULT '', followers INTEGER DEFAULT 0,
      bio TEXT DEFAULT '', avg_er REAL DEFAULT 0, suggestion_score REAL DEFAULT 0,
      status TEXT DEFAULT 'pending', reviewed_at TEXT);
    CREATE TABLE suggested_reels (id INTEGER PRIMARY KEY, username TEXT, shortcode TEXT, thumbnail_url TEXT,
      video_url TEXT, view_count INTEGER, like_count INTEGER, comment_count INTEGER, permalink TEXT, rank INTEGER);
    CREATE TABLE posts (id INTEGER PRIMARY KEY, account_handle TEXT, content_type TEXT, sort_status TEXT DEFAULT 'unsorted',
      soft_deleted INTEGER DEFAULT 0, archived INTEGER DEFAULT 0, video_cache_status TEXT, posted_at TEXT, perf_score REAL, ai_layout TEXT);
    CREATE TABLE creator_types (account_handle TEXT, content_type TEXT);
    CREATE TABLE model_assigned_posts (model_id INTEGER, post_id INTEGER, status TEXT);
    CREATE TABLE model_saved_posts (model_id INTEGER, post_id INTEGER);
    CREATE TABLE model_post_feedback (model_id INTEGER, post_id INTEGER, feedback TEXT);`);
  const pool = { sqlite, query: async (sql, params = []) => {
    const numbers = [...sql.matchAll(/\$(\d+)/g)].map(match => Number(match[1]));
    assert.deepEqual(numbers, params.map((_, i) => i + 1), 'SQLite parameter order');
    const stmt = sqlite.prepare(sql.replace(/\$\d+/g, '?'));
    if (stmt.reader) { const rows = stmt.all(...params); return { rows, rowCount: rows.length }; }
    return { rows: [], rowCount: stmt.run(...params).changes };
  } };
  pool.transaction = async work => {
    sqlite.exec('BEGIN');
    try { const result = await work(pool); sqlite.exec('COMMIT'); return result; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  };
  await ensureWorkspaceTables(pool, { isPg: false });
  await ensureLookTables(pool, { isPg: false });
  await seedLookTags(pool);
  return pool;
}

module.exports = { makeWorkspaceDb };
