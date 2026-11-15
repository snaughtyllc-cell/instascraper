const Database = require('better-sqlite3');
const { ensureSortStatus } = require('../sort-migration');

async function makeSortDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE posts (id INTEGER PRIMARY KEY, shortcode TEXT, account_handle TEXT,
    caption TEXT, posted_at TEXT, video_cache_status TEXT, content_type TEXT, archived INTEGER DEFAULT 0,
    soft_deleted INTEGER DEFAULT 0, soft_deleted_at TEXT, tag TEXT);
    CREATE TABLE content_types (id INTEGER PRIMARY KEY, value TEXT UNIQUE, label TEXT, sort_order INTEGER DEFAULT 0, created_at TEXT);
    INSERT INTO content_types (value,label) VALUES ('dance','Dance'),('talking','Talking');
    CREATE TABLE tracked_accounts (username TEXT PRIMARY KEY);
    CREATE TABLE suggested_reels (id INTEGER PRIMARY KEY, ai_classified_at TEXT, ai_cost_usd REAL);
    CREATE TABLE deletion_log (id INTEGER PRIMARY KEY, post_id INTEGER, shortcode TEXT, account_handle TEXT, reason TEXT);`);
  const db = { sqlite, query: async (sql, params = []) => {
    const numbers = [...sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1]));
    if (numbers.length) require('node:assert/strict').deepEqual(numbers, params.map((_, i) => i + 1), 'SQLite parameter order');
    const stmt = sqlite.prepare(sql.replace(/\$\d+/g, '?'));
    if (stmt.reader) { const rows = stmt.all(...params); return { rows, rowCount: rows.length }; }
    return { rows: [], rowCount: stmt.run(...params).changes };
  } };
  db.transaction = async work => {
    sqlite.exec('BEGIN');
    try { const result = await work(db); sqlite.exec('COMMIT'); return result; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  };
  await ensureSortStatus(db, { isPg: false });
  return db;
}
module.exports = { makeSortDb };
