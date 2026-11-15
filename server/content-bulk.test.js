const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { buildBulkUpdate } = require('./content-bulk');

const DEFAULT_TYPES = ['talking', 'dance', 'skit', 'snapchat', 'omegle', 'osc'];

test('buildBulkUpdate: unknown action → error', () => {
  assert.deepStrictEqual(buildBulkUpdate('frobnicate', 'x', [1]), { error: 'Invalid action' });
});

test('buildBulkUpdate: removed tag action with unknown value → error', () => {
  assert.deepStrictEqual(buildBulkUpdate('tag', 'bogus', [1]), { error: 'Invalid action' });
});

test('buildBulkUpdate: content-type value outside allow-list → error', () => {
  assert.deepStrictEqual(buildBulkUpdate('content-type', 'bogus', [1], DEFAULT_TYPES), { error: 'Invalid content type' });
});

test('buildBulkUpdate: content-type accepts a newly-added type when passed in validTypeValues', () => {
  const out = buildBulkUpdate('content-type', 'get-ready', [5], [...DEFAULT_TYPES, 'get-ready']);
  assert.strictEqual(out.sql, "UPDATE posts SET content_type = $1, sort_status = 'manual' WHERE id IN ($2)");
  assert.deepStrictEqual(out.params, ['get-ready', 5]);
});

test('buildBulkUpdate: content-type rejects a value not present in validTypeValues, even if it looks plausible', () => {
  assert.deepStrictEqual(buildBulkUpdate('content-type', 'get-ready', [5], DEFAULT_TYPES), { error: 'Invalid content type' });
});

test('buildBulkUpdate: null is a valid content-type (clear)', () => {
  assert.strictEqual(buildBulkUpdate('content-type', null, [5]).params[0], null);
  assert.strictEqual(buildBulkUpdate('content-type', null, [5], DEFAULT_TYPES).params[0], null);
});

test('buildBulkUpdate: content-type build with multiple ids + placeholder list', () => {
  const out = buildBulkUpdate('content-type', 'dance', [3, 1, 2], DEFAULT_TYPES);
  assert.strictEqual(out.sql, "UPDATE posts SET content_type = $1, sort_status = 'manual' WHERE id IN ($2,$3,$4)");
  assert.deepStrictEqual(out.params, ['dance', 3, 1, 2]);
  assert.deepStrictEqual(out.ids, [3, 1, 2]);
});

test('buildBulkUpdate: archive maps truthy/falsy → 1/0', () => {
  assert.deepStrictEqual(buildBulkUpdate('archive', true, [1]).params, [1, 1]);
  assert.deepStrictEqual(buildBulkUpdate('archive', false, [1]).params, [0, 1]);
});

test('buildBulkUpdate: non-integer/garbage ids dropped; empty → sql null', () => {
  assert.deepStrictEqual(buildBulkUpdate('archive', true, ['x', 0, -2, null, 2.5]).sql, null);
  const out = buildBulkUpdate('archive', true, ['4', 5, 'x']);
  assert.deepStrictEqual(out.ids, [4, 5]); // numeric strings coerced, garbage dropped
});

test('buildBulkUpdate: generated SQL actually updates the right rows (sqlite)', () => {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE posts (id INTEGER PRIMARY KEY, content_type TEXT, sort_status TEXT)");
  db.exec("INSERT INTO posts (id, content_type, sort_status) VALUES (1,'dance','auto'),(2,NULL,'unsorted'),(3,'talking','auto')");
  const out = buildBulkUpdate('content-type', 'skit', [1, 3], DEFAULT_TYPES);
  const sqliteSql = out.sql.replace(/\$\d+/g, '?'); // mirror the dual-mode shim
  const info = db.prepare(sqliteSql).run(...out.params);
  assert.strictEqual(info.changes, 2);
  const rows = db.prepare('SELECT id, content_type, sort_status FROM posts ORDER BY id').all();
  assert.deepStrictEqual(rows, [{ id: 1, content_type: 'skit', sort_status: 'manual' }, { id: 2, content_type: null, sort_status: 'unsorted' }, { id: 3, content_type: 'skit', sort_status: 'manual' }]);
});

test('content-type action sets sort_status manual, including when clearing', () => {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE posts (id INTEGER PRIMARY KEY, content_type TEXT, sort_status TEXT); INSERT INTO posts VALUES (1, 'dance', 'auto')");
  for (const value of ['talking', null]) {
    const { sql, params } = buildBulkUpdate('content-type', value, [1], DEFAULT_TYPES);
    db.prepare(sql.replace(/\$\d+/g, '?')).run(...params);
    assert.deepStrictEqual(db.prepare('SELECT content_type, sort_status FROM posts').get(), { content_type: value, sort_status: 'manual' });
  }
});

test('tag action rejected', () => {
  for (const value of ['recreate', 'reference', 'skip', null]) {
    assert.deepStrictEqual(buildBulkUpdate('tag', value, [1]), { error: 'Invalid action' });
  }
});
