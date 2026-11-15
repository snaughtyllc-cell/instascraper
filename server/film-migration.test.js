const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { ensureFilmTables } = require('./film-migration');

test('film migration upgrades existing models, enforces links, and is idempotent', async t => {
  const sqlite = new Database(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec("CREATE TABLE models (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO models VALUES (1, 'Logan')");
  const pool = { query: async sql => {
    const stmt = sqlite.prepare(sql);
    return { rows: stmt.reader ? stmt.all() : (stmt.run(), []) };
  } };
  await ensureFilmTables(pool, { isPg: false });
  await ensureFilmTables(pool, { isPg: false });
  assert.deepEqual(sqlite.prepare('SELECT * FROM models WHERE id = 1').get(), { id: 1, name: 'Logan', hq_project_id: null });
  sqlite.exec("INSERT INTO models (id, hq_project_id) VALUES (2, NULL), (3, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')");
  assert.throws(() => sqlite.exec("INSERT INTO models (id, hq_project_id) VALUES (4, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')"), /UNIQUE/);

  const columns = sqlite.prepare('PRAGMA table_info(film_reel_items)').all();
  assert.deepEqual(columns.map(row => row.name), ['model_id', 'post_id', 'hq_item_id', 'created_at']);
  assert.deepEqual(columns.filter(row => row.pk).map(row => row.name), ['model_id', 'post_id']);
  sqlite.exec("INSERT INTO film_reel_items (model_id, post_id, hq_item_id) VALUES (1, 101, 'hq-item')");
  assert.ok(sqlite.prepare('SELECT created_at FROM film_reel_items').get().created_at);
  assert.throws(() => sqlite.exec("INSERT INTO film_reel_items (model_id, post_id, hq_item_id) VALUES (1, 101, 'another-item')"), /UNIQUE/);
  sqlite.exec("INSERT INTO film_reel_items (model_id, post_id, hq_item_id) VALUES (2, 101, 'another-model')");
  assert.deepEqual(sqlite.prepare('PRAGMA table_info(film_react_refs)').all().map(row => row.name),
    ['shortcode', 'state', 'error', 'duration_sec', 'attempts', 'created_at', 'updated_at']);
  sqlite.exec("INSERT INTO film_react_refs (shortcode, state) VALUES ('fresh_ref', 'fetching')");
  const ref = sqlite.prepare('SELECT * FROM film_react_refs').get();
  assert.equal(ref.attempts, 0);
  assert.ok(ref.created_at);
  assert.ok(ref.updated_at);
  assert.throws(() => sqlite.exec("INSERT INTO film_react_refs (shortcode, state) VALUES ('fresh_ref', 'ready')"), /UNIQUE/);
  assert.deepEqual(sqlite.prepare('PRAGMA table_info(film_react_ref_attempts)').all().map(row => row.name),
    ['attempt_id', 'shortcode', 'created_at', 'started_at']);
  assert.deepEqual(sqlite.prepare('PRAGMA table_info(film_react_analysis)').all().map(row => row.name),
    ['shortcode', 'state', 'analysis_json', 'error', 'attempts', 'created_at', 'updated_at']);
  sqlite.exec("INSERT INTO film_react_analysis (shortcode, state) VALUES ('fresh_ref', 'queued')");
  const analysis = sqlite.prepare('SELECT * FROM film_react_analysis').get();
  assert.equal(analysis.attempts, 0);
  assert.equal(analysis.analysis_json, null);
  assert.ok(analysis.created_at);
  assert.ok(analysis.updated_at);
  assert.throws(() => sqlite.exec("INSERT INTO film_react_analysis (shortcode, state) VALUES ('fresh_ref', 'ready')"), /UNIQUE/);
});

test('film migration emits compatible PostgreSQL reference schema', async () => {
  const statements = [];
  await ensureFilmTables({ query: async sql => { statements.push(sql); return { rows: [{ name: 'hq_project_id' }] }; } }, { isPg: true });
  assert.ok(statements.some(sql => /CREATE TABLE IF NOT EXISTS film_react_refs/.test(sql)
    && /shortcode TEXT PRIMARY KEY/.test(sql) && /TO_CHAR\(NOW\(\)/.test(sql)));
  assert.ok(statements.some(sql => /CREATE TABLE IF NOT EXISTS film_react_ref_attempts/.test(sql)));
  assert.ok(statements.some(sql => /CREATE TABLE IF NOT EXISTS film_react_analysis/.test(sql)
    && /shortcode TEXT PRIMARY KEY/.test(sql) && /TO_CHAR\(NOW\(\)/.test(sql)));
});
