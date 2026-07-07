const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { buildBulkUpdate } = require('./content-bulk');

const DEFAULT_TYPES = ['talking', 'dance', 'skit', 'snapchat', 'omegle', 'osc'];

test('buildBulkUpdate: unknown action → error', () => {
  assert.deepStrictEqual(buildBulkUpdate('frobnicate', 'x', [1]), { error: 'Invalid action' });
});

test('buildBulkUpdate: tag value outside allow-list → error', () => {
  assert.deepStrictEqual(buildBulkUpdate('tag', 'bogus', [1]), { error: 'Invalid tag' });
});

test('buildBulkUpdate: content-type value outside allow-list → error', () => {
  assert.deepStrictEqual(buildBulkUpdate('content-type', 'bogus', [1], DEFAULT_TYPES), { error: 'Invalid content type' });
});

test('buildBulkUpdate: content-type accepts a newly-added type when passed in validTypeValues', () => {
  const out = buildBulkUpdate('content-type', 'get-ready', [5], [...DEFAULT_TYPES, 'get-ready']);
  assert.strictEqual(out.sql, 'UPDATE posts SET content_type = $1 WHERE id IN ($2)');
  assert.deepStrictEqual(out.params, ['get-ready', 5]);
});

test('buildBulkUpdate: content-type rejects a value not present in validTypeValues, even if it looks plausible', () => {
  assert.deepStrictEqual(buildBulkUpdate('content-type', 'get-ready', [5], DEFAULT_TYPES), { error: 'Invalid content type' });
});

test('buildBulkUpdate: null is a valid tag and content-type (clear)', () => {
  assert.strictEqual(buildBulkUpdate('tag', null, [5]).sql, 'UPDATE posts SET tag = $1 WHERE id IN ($2)');
  assert.deepStrictEqual(buildBulkUpdate('tag', null, [5]).params, [null, 5]);
  assert.strictEqual(buildBulkUpdate('content-type', null, [5]).params[0], null);
  assert.strictEqual(buildBulkUpdate('content-type', null, [5], DEFAULT_TYPES).params[0], null);
});

test('buildBulkUpdate: tag build with multiple ids + placeholder list', () => {
  const out = buildBulkUpdate('tag', 'skip', [3, 1, 2]);
  assert.strictEqual(out.sql, 'UPDATE posts SET tag = $1 WHERE id IN ($2,$3,$4)');
  assert.deepStrictEqual(out.params, ['skip', 3, 1, 2]);
  assert.deepStrictEqual(out.ids, [3, 1, 2]);
});

test('buildBulkUpdate: archive maps truthy/falsy → 1/0', () => {
  assert.deepStrictEqual(buildBulkUpdate('archive', true, [1]).params, [1, 1]);
  assert.deepStrictEqual(buildBulkUpdate('archive', false, [1]).params, [0, 1]);
});

test('buildBulkUpdate: non-integer/garbage ids dropped; empty → sql null', () => {
  assert.deepStrictEqual(buildBulkUpdate('tag', 'skip', ['x', 0, -2, null, 2.5]).sql, null);
  const out = buildBulkUpdate('tag', 'skip', ['4', 5, 'x']);
  assert.deepStrictEqual(out.ids, [4, 5]); // numeric strings coerced, garbage dropped
});

test('buildBulkUpdate: generated SQL actually updates the right rows (sqlite)', () => {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE posts (id INTEGER PRIMARY KEY, tag TEXT)");
  db.exec("INSERT INTO posts (id, tag) VALUES (1,'recreate'),(2,NULL),(3,'reference')");
  const out = buildBulkUpdate('tag', 'skip', [1, 3]);
  const sqliteSql = out.sql.replace(/\$\d+/g, '?'); // mirror the dual-mode shim
  const info = db.prepare(sqliteSql).run(...out.params);
  assert.strictEqual(info.changes, 2);
  const rows = db.prepare('SELECT id, tag FROM posts ORDER BY id').all();
  assert.deepStrictEqual(rows, [{ id: 1, tag: 'skip' }, { id: 2, tag: null }, { id: 3, tag: 'skip' }]);
});

test('untagged WHERE clause selects only null/empty tags (sqlite)', () => {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE posts (id INTEGER PRIMARY KEY, tag TEXT)");
  db.exec("INSERT INTO posts (id, tag) VALUES (1,'recreate'),(2,NULL),(3,''),(4,'skip')");
  const rows = db.prepare("SELECT id FROM posts WHERE (tag IS NULL OR tag = '') ORDER BY id").all();
  assert.deepStrictEqual(rows.map(r => r.id), [2, 3]);
});
