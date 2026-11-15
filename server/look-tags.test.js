const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { ensureLookTables } = require('./workspace-migration');
const { seedLookTags, parseTagList, validateLookTagInput, cleanModelLookTags } = require('./look-tags');

async function makeDb(t) {
  const sqlite = new Database(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec('CREATE TABLE posts (id INTEGER PRIMARY KEY); CREATE TABLE suggested_reels (id INTEGER PRIMARY KEY); CREATE TABLE models (id INTEGER PRIMARY KEY)');
  const db = { sqlite, query: async (sql, params = []) => {
    const numbers = [...sql.matchAll(/\$(\d+)/g)].map(match => Number(match[1]));
    assert.deepEqual(numbers, params.map((_, i) => i + 1), 'SQLite parameter order');
    const stmt = sqlite.prepare(sql.replace(/\$\d+/g, '?'));
    if (stmt.reader) { const rows = stmt.all(...params); return { rows, rowCount: rows.length }; }
    return { rows: [], rowCount: stmt.run(...params).changes };
  } };
  await ensureLookTables(db, { isPg: false });
  return db;
}

test('seed creates 16 tags across hair/aesthetic/setting, rerun no-op', async t => {
  const db = await makeDb(t);
  await seedLookTags(db);
  await seedLookTags(db);
  assert.deepEqual(db.sqlite.prepare('SELECT category, COUNT(*) AS n FROM look_tags GROUP BY category ORDER BY category').all(), [
    { category: 'aesthetic', n: 7 }, { category: 'hair', n: 5 }, { category: 'setting', n: 4 },
  ]);
  await ensureLookTables(db, { isPg: false });
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM look_tags').get().n, 16);
  for (const [table, column] of [['posts', 'ai_look_tags'], ['suggested_reels', 'ai_look_tags'], ['models', 'look_tags']]) {
    assert.ok(db.sqlite.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column));
  }
  for (const name of ['creator_look_tags', 'model_taste', 'look_backfill_attempts']) {
    assert.ok(db.sqlite.prepare('SELECT name FROM sqlite_master WHERE name = ?').get(name));
  }
});

test('parseTagList handles null, bad JSON, mixed case', () => {
  assert.deepEqual(parseTagList(null), []);
  assert.deepEqual(parseTagList('not JSON'), []);
  assert.deepEqual(parseTagList('{"tag":"emo"}'), []);
  assert.deepEqual(parseTagList('[" Brunette ","EMO",false,null,"brunette",""]'), ['brunette', 'emo']);
});

test('validateLookTagInput rejects unknown category', () => {
  assert.equal(validateLookTagInput({ label: 'Red hair', category: 'ethnicity' }).ok, false);
  assert.deepEqual(validateLookTagInput({ label: ' Red Hair ', category: 'hair' }), { ok: true, value: 'red-hair', label: 'Red Hair', category: 'hair' });
  assert.equal(validateLookTagInput({ label: '!!!', category: 'custom' }).ok, false);
});

test('model look_tags filtered to vocabulary', () => {
  const vocab = [{ value: 'brunette' }, { value: 'emo' }, { value: 'asian', category: 'custom' }];
  assert.deepEqual(cleanModelLookTags(['BRUNETTE', 'unknown', 'emo', 'emo', 'asian'], vocab), ['brunette', 'emo', 'asian']);
  assert.deepEqual(cleanModelLookTags('brunette', vocab), []);
});
