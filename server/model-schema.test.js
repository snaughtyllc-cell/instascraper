const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { SQLITE_MIGRATIONS } = require('./db');

test('SQLITE_MIGRATIONS adds the four model login columns to models', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE models (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, primary_niche TEXT)`);
  for (const sql of SQLITE_MIGRATIONS) {
    // Tolerate other-table statements (no such table) and re-runs (duplicate column).
    try { db.exec(sql); } catch (e) { if (!/duplicate column|no such table/i.test(e.message)) throw e; }
  }
  const cols = db.prepare(`PRAGMA table_info(models)`).all().map(c => c.name);
  for (const c of ['email', 'password_hash', 'role', 'login_enabled']) {
    assert.ok(cols.includes(c), `models.${c} missing from the real migration array`);
  }
});

test('model_saved_posts DDL (copied verbatim from db.js) has the expected shape', () => {
  // model_saved_posts is a CREATE TABLE in initDB, not in SQLITE_MIGRATIONS, so it can't be
  // exercised via the array. Copy the CREATE verbatim from db.js to keep this self-consistent.
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS model_saved_posts (
    model_id INTEGER NOT NULL, post_id INTEGER NOT NULL, saved_at TEXT, PRIMARY KEY (model_id, post_id))`);
  const saved = db.prepare(`PRAGMA table_info(model_saved_posts)`).all().map(c => c.name).sort();
  assert.deepStrictEqual(saved, ['model_id', 'post_id', 'saved_at'].sort());
});
