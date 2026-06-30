const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { extractViews } = require('./scraper');

test('extractViews: prefers videoPlayCount when present', () => {
  assert.strictEqual(extractViews({ videoPlayCount: 1234, videoViewCount: 5 }), 1234);
});

test('extractViews: falls back to videoViewCount', () => {
  assert.strictEqual(extractViews({ videoViewCount: 77 }), 77);
});

test('extractViews: genuine zero stays 0, not null', () => {
  assert.strictEqual(extractViews({ videoPlayCount: 0 }), 0);
});

test('extractViews: no view field → null (unknown, not fake 0)', () => {
  assert.strictEqual(extractViews({ likesCount: 10 }), null);
  assert.strictEqual(extractViews({}), null);
  assert.strictEqual(extractViews({ videoPlayCount: null, videoViewCount: undefined }), null);
});

test('extractViews: ignores non-numeric junk', () => {
  assert.strictEqual(extractViews({ videoPlayCount: 'NaN' }), null);
});

test('most_viewed ORDER BY puts NULL views last (dual-engine guard)', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE posts (shortcode TEXT, view_count INTEGER)');
  db.exec("INSERT INTO posts VALUES ('a', 500), ('b', NULL), ('c', 2000)");
  const rows = db.prepare('SELECT shortcode FROM posts ORDER BY view_count DESC NULLS LAST').all();
  assert.deepStrictEqual(rows.map(r => r.shortcode), ['c', 'a', 'b']);
});
