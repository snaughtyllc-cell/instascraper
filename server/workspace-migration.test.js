const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { ensureWorkspaceTables } = require('./workspace-migration');

test('creates the workspace tables and suggested_reels columns; second run no-op', async t => {
  const sqlite = new Database(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec('CREATE TABLE models (id INTEGER PRIMARY KEY); CREATE TABLE suggested_reels (id INTEGER PRIMARY KEY, username TEXT)');
  let mutations = 0;
  const pool = { query: async sql => {
    const stmt = sqlite.prepare(sql);
    if (stmt.reader) return { rows: stmt.all() };
    mutations++;
    stmt.run();
    return { rows: [] };
  } };
  await ensureWorkspaceTables(pool, { isPg: false });
  for (const name of ['model_creators', 'model_hidden_creators', 'model_creator_proposals', 'model_suggestions']) {
    assert.ok(sqlite.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(name));
  }
  const columns = sqlite.prepare('PRAGMA table_info(suggested_reels)').all().map(row => row.name);
  for (const name of ['ai_type', 'ai_confidence', 'ai_error', 'ai_classified_at', 'ai_cost_usd', 'ai_layout']) assert.ok(columns.includes(name), name);
  sqlite.exec("INSERT INTO suggested_reels(id,username) VALUES(1,'candidate')");
  assert.deepEqual(sqlite.prepare('SELECT ai_layout FROM suggested_reels').get(), { ai_layout: null });
  sqlite.exec("INSERT INTO model_creators (model_id, username) VALUES (1, 'mia.talks')");
  sqlite.exec("INSERT INTO models (id) VALUES (1); INSERT INTO model_hidden_creators VALUES (1, 'hidden', '2026-11-20T00:00:00Z')");
  const firstMutations = mutations;
  await ensureWorkspaceTables(pool, { isPg: false });
  assert.equal(mutations - firstMutations, 4, 'only idempotent CREATE TABLE statements on rerun');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM model_creators').get().n, 1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM model_hidden_creators').get().n, 1);
});

test('hidden creator schema requires values, enforces model ownership and cascades deletion', async t => {
  const sqlite = new Database(':memory:');
  t.after(() => sqlite.close());
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec('CREATE TABLE models (id INTEGER PRIMARY KEY); CREATE TABLE suggested_reels (id INTEGER PRIMARY KEY)');
  await ensureWorkspaceTables({ query: async sql => {
    const stmt = sqlite.prepare(sql);
    if (stmt.reader) return { rows: stmt.all() };
    stmt.run();
    return { rows: [] };
  } }, { isPg: false });
  const columns = sqlite.prepare('PRAGMA table_info(model_hidden_creators)').all();
  assert.deepEqual(columns.map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk })), [
    { name: 'model_id', type: 'INTEGER', notnull: 1, pk: 1 },
    { name: 'username', type: 'TEXT', notnull: 1, pk: 2 },
    { name: 'hidden_at', type: 'TEXT', notnull: 1, pk: 0 },
  ]);
  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_list(model_hidden_creators)').all().map(row => [row.table, row.from, row.to, row.on_delete]),
    [['models', 'model_id', 'id', 'CASCADE']]);
  sqlite.exec('INSERT INTO models (id) VALUES (1), (2)');
  const insert = sqlite.prepare('INSERT INTO model_hidden_creators (model_id, username, hidden_at) VALUES (?, ?, ?)');
  insert.run(1, 'creator', '2026-11-20');
  insert.run(2, 'creator', '2026-11-20');
  assert.throws(() => insert.run(1, 'creator', '2026-11-21'), /UNIQUE constraint/);
  assert.throws(() => insert.run(999, 'creator', '2026-11-20'), /FOREIGN KEY constraint/);
  for (const values of [[null, 'creator', '2026-11-20'], [1, null, '2026-11-20'], [1, 'other', null]]) {
    assert.throws(() => insert.run(...values), /NOT NULL constraint/);
  }
  sqlite.exec('DELETE FROM models WHERE id = 1');
  assert.deepEqual(sqlite.prepare('SELECT model_id, username FROM model_hidden_creators').all(), [{ model_id: 2, username: 'creator' }]);
});

test('PostgreSQL creates hidden creator ownership and adds nullable suggested reel layout', async () => {
  const statements = [];
  await ensureWorkspaceTables({ query: async sql => { statements.push(sql); return { rows: [] }; } }, { isPg: true });
  assert.ok(statements.includes('ALTER TABLE suggested_reels ADD COLUMN IF NOT EXISTS ai_layout TEXT'));
  const hidden = statements.find(sql => /CREATE TABLE IF NOT EXISTS model_hidden_creators/.test(sql));
  assert.match(hidden, /model_id INTEGER NOT NULL REFERENCES models\(id\) ON DELETE CASCADE/);
  assert.match(hidden, /username TEXT NOT NULL/);
  assert.match(hidden, /hidden_at TEXT NOT NULL/);
  assert.match(hidden, /PRIMARY KEY \(model_id, username\)/);
});
