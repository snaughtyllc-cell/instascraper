const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { ensureWorkspaceTables } = require('./workspace-migration');

test('creates the three tables and suggested_reels columns; second run no-op', async t => {
  const sqlite = new Database(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec('CREATE TABLE suggested_reels (id INTEGER PRIMARY KEY, username TEXT)');
  let mutations = 0;
  const pool = { query: async sql => {
    const stmt = sqlite.prepare(sql);
    if (stmt.reader) return { rows: stmt.all() };
    mutations++;
    stmt.run();
    return { rows: [] };
  } };
  await ensureWorkspaceTables(pool, { isPg: false });
  for (const name of ['model_creators', 'model_creator_proposals', 'model_suggestions']) {
    assert.ok(sqlite.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(name));
  }
  const columns = sqlite.prepare('PRAGMA table_info(suggested_reels)').all().map(row => row.name);
  for (const name of ['ai_type', 'ai_confidence', 'ai_error', 'ai_classified_at', 'ai_cost_usd', 'ai_layout']) assert.ok(columns.includes(name), name);
  sqlite.exec("INSERT INTO suggested_reels(id,username) VALUES(1,'candidate')");
  assert.deepEqual(sqlite.prepare('SELECT ai_layout FROM suggested_reels').get(), { ai_layout: null });
  sqlite.exec("INSERT INTO model_creators (model_id, username) VALUES (1, 'mia.talks')");
  const firstMutations = mutations;
  await ensureWorkspaceTables(pool, { isPg: false });
  assert.equal(mutations - firstMutations, 3, 'only idempotent CREATE TABLE statements on rerun');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM model_creators').get().n, 1);
});

test('PostgreSQL adds suggested reel layout as nullable TEXT', async () => {
  const statements = [];
  await ensureWorkspaceTables({ query: async sql => { statements.push(sql); return { rows: [] }; } }, { isPg: true });
  assert.ok(statements.includes('ALTER TABLE suggested_reels ADD COLUMN IF NOT EXISTS ai_layout TEXT'));
});
