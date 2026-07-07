const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { SQLITE_MIGRATIONS } = require('./db');

test('SQLITE_MIGRATIONS adds the four video columns to posts', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE posts (id INTEGER PRIMARY KEY, shortcode TEXT)`);
  for (const sql of SQLITE_MIGRATIONS) {
    // Tolerate other-table statements (no such table) and re-runs (duplicate column).
    try { db.exec(sql); } catch (e) { if (!/duplicate column|no such table/i.test(e.message)) throw e; }
  }
  const cols = db.prepare(`PRAGMA table_info(posts)`).all().map(c => c.name);
  for (const c of ['video_cache_status', 'video_cache_error', 'video_cached_at', 'video_url_refreshed_at']) {
    assert.ok(cols.includes(c), `${c} missing from the real migration array`);
  }
});
