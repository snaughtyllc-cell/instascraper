const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');

// Mirror of the dual-mode DDL initDB creates — asserts the shape is creatable,
// defaults apply, and UNIQUE(term,kind) + ON CONFLICT DO NOTHING behave.
function makeWatchTerms(db) {
  db.exec(`CREATE TABLE watch_terms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    term TEXT NOT NULL,
    kind TEXT DEFAULT 'keyword',
    source TEXT DEFAULT 'user',
    status TEXT DEFAULT 'active',
    added_at TEXT,
    last_run_at TEXT DEFAULT NULL,
    notes TEXT DEFAULT '',
    UNIQUE(term, kind))`);
}

test('watch_terms: defaults apply and ON CONFLICT(term,kind) DO NOTHING is idempotent', () => {
  const db = new Database(':memory:');
  makeWatchTerms(db);
  db.prepare("INSERT INTO watch_terms (term) VALUES ('blonde') ON CONFLICT(term,kind) DO NOTHING").run();
  const dup = db.prepare("INSERT INTO watch_terms (term) VALUES ('blonde') ON CONFLICT(term,kind) DO NOTHING").run();
  assert.strictEqual(dup.changes, 0, 'second identical insert is a no-op');
  const rows = db.prepare('SELECT * FROM watch_terms').all();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].kind, 'keyword');   // default
  assert.strictEqual(rows[0].source, 'user');    // default
  assert.strictEqual(rows[0].status, 'active');  // default
});
