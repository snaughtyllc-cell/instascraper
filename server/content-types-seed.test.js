// server/content-types-seed.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { seedContentTypes, CONTENT_TYPE_DESCRIPTIONS } = require('./content-types');
const { ensureContentTypeDescriptions } = require('./content-types-migration');

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
      const stmt = sqlite.prepare(norm);
      if (stmt.reader) return { rows: stmt.all(...params) };
      stmt.run(...params);
      return { rows: [] };
    },
  };
}

test('description migration upgrades old tables idempotently before seeding defaults', async () => {
  const db = makeDb();
  await ensureContentTypeDescriptions(db, { isPg: false });
  await ensureContentTypeDescriptions(db, { isPg: false });
  await seedContentTypes(db);
  const { rows } = await db.query('SELECT value, description FROM content_types ORDER BY sort_order');
  assert.deepStrictEqual(rows.map(r => r.value), ['talking', 'dance', 'skit', 'snapchat', 'omegle', 'osc', 'lipsync']);
  for (const row of rows) assert.strictEqual(row.description, CONTENT_TYPE_DESCRIPTIONS[row.value]);
});

test('seedContentTypes is idempotent (no duplicates on second run)', async () => {
  const db = makeDb();
  await ensureContentTypeDescriptions(db, { isPg: false });
  await seedContentTypes(db);
  await seedContentTypes(db);
  const { rows } = await db.query('SELECT COUNT(*) AS n FROM content_types');
  assert.strictEqual(Number(rows[0].n), 7);
});

test('seed fills production definitions by value while preserving edited labels and descriptions', async () => {
  const db = makeDb();
  await ensureContentTypeDescriptions(db, { isPg: false });
  for (const value of Object.keys(CONTENT_TYPE_DESCRIPTIONS)) {
    await db.query('INSERT INTO content_types (value, label) VALUES ($1, $2)', [value, `Production ${value}`]);
  }
  await db.query('UPDATE content_types SET description = $1 WHERE value = $2', ['Custom speech definition', 'talking']);
  await db.query('UPDATE content_types SET description = $1 WHERE value = $2', ['', 'dance']);
  await db.query('INSERT INTO content_types (value, label) VALUES ($1, $2)', ['custom', 'Custom']);
  await seedContentTypes(db);
  await seedContentTypes(db);
  const { rows } = await db.query('SELECT value, label, description FROM content_types');
  assert.strictEqual(rows.length, 13);
  for (const value of Object.keys(CONTENT_TYPE_DESCRIPTIONS)) {
    const row = rows.find(item => item.value === value);
    assert.strictEqual(row.label, `Production ${value}`);
    assert.strictEqual(row.description, value === 'talking' ? 'Custom speech definition' : value === 'dance' ? '' : CONTENT_TYPE_DESCRIPTIONS[value]);
  }
  assert.strictEqual(rows.find(row => row.value === 'custom').description, null);
});

test('Postgres description migration inspects schema and adds only the missing column', async () => {
  const calls = [];
  const db = { query: async sql => {
    calls.push(sql);
    return { rows: calls.length === 1 ? [{ name: 'id' }, { name: 'label' }] : [] };
  } };
  await ensureContentTypeDescriptions(db, { isPg: true });
  assert.match(calls[0], /information_schema.columns.*content_types/);
  assert.strictEqual(calls[1], 'ALTER TABLE content_types ADD COLUMN IF NOT EXISTS description TEXT');
  await ensureContentTypeDescriptions({ query: async sql => {
    assert.match(sql, /information_schema.columns/);
    return { rows: [{ name: 'description' }] };
  } }, { isPg: true });
});
