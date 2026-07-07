// server/content-types-seed.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { seedContentTypes } = require('./content-types');

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE content_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    value TEXT UNIQUE NOT NULL,
    label TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT '')`);
  // Adapter matching the `db.query(sql, params)` shape used in db.js
  return {
    query: async (sql, params = []) => {
      const norm = sql.replace(/\$\d+/g, '?');
      if (/^\s*select/i.test(norm)) return { rows: sqlite.prepare(norm).all(...params) };
      sqlite.prepare(norm).run(...params);
      return { rows: [] };
    },
  };
}

test('seedContentTypes inserts the six defaults into an empty table', async () => {
  const db = makeDb();
  await seedContentTypes(db);
  const { rows } = await db.query('SELECT value FROM content_types ORDER BY sort_order');
  assert.deepStrictEqual(rows.map(r => r.value), ['talking', 'dance', 'skit', 'snapchat', 'omegle', 'osc']);
});

test('seedContentTypes is idempotent (no duplicates on second run)', async () => {
  const db = makeDb();
  await seedContentTypes(db);
  await seedContentTypes(db);
  const { rows } = await db.query('SELECT COUNT(*) AS n FROM content_types');
  assert.strictEqual(Number(rows[0].n), 6);
});
