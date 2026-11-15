const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { modelCanAccessPost } = require('./model-access');

function makePool() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE posts (id INTEGER PRIMARY KEY, content_type TEXT, sort_status TEXT, account_handle TEXT,
    soft_deleted INTEGER DEFAULT 0, archived INTEGER DEFAULT 0, video_cache_status TEXT DEFAULT 'cached');
    CREATE TABLE models (id INTEGER PRIMARY KEY, primary_niche TEXT, secondary_niches TEXT);
    CREATE TABLE creator_types (account_handle TEXT, content_type TEXT);
    CREATE TABLE model_assigned_posts (model_id INTEGER, post_id INTEGER, status TEXT);
    CREATE TABLE model_saved_posts (model_id INTEGER, post_id INTEGER);
    CREATE TABLE model_post_feedback (model_id INTEGER, post_id INTEGER, feedback TEXT);
    INSERT INTO models VALUES (7, 'talking', 'dance');
    INSERT INTO creator_types VALUES ('creator', 'talking');
    INSERT INTO posts (id, content_type, sort_status, account_handle) VALUES (1, 'talking', 'unsorted', 'creator')`);
  return { sqlite, query: async (sql, params = []) => {
    const rows = sqlite.prepare(sql.replace(/\$\d+/g, '?')).all(...params);
    return { rows, rowCount: rows.length };
  } };
}

test('already-saved reel stays reachable after it becomes needs_look', async () => {
  const pool = makePool();
  pool.sqlite.exec("UPDATE posts SET sort_status = 'needs_look', content_type = NULL; INSERT INTO model_saved_posts VALUES (7, 1)");
  assert.strictEqual(await modelCanAccessPost(pool, 7, 1), true);
});

test('reel with feedback stays reachable', async () => {
  const pool = makePool();
  pool.sqlite.exec("UPDATE posts SET sort_status = 'needs_look', content_type = NULL; INSERT INTO model_post_feedback VALUES (7, 1, 'need_script')");
  assert.strictEqual(await modelCanAccessPost(pool, 7, 1), true);
});

test('unsorted unsaved reel → false', async () => {
  assert.strictEqual(await modelCanAccessPost(makePool(), 7, 1), false);
});

test('assigned reel stays reachable and other model saves do not grant access', async () => {
  const pool = makePool();
  pool.sqlite.exec('INSERT INTO model_saved_posts VALUES (8, 1)');
  assert.strictEqual(await modelCanAccessPost(pool, 7, 1), false);
  pool.sqlite.exec("INSERT INTO model_assigned_posts VALUES (7, 1, 'assigned')");
  assert.strictEqual(await modelCanAccessPost(pool, 7, 1), true);
});

test('sorted reels match the model niches and requirePlayable gates saved reels', async () => {
  const pool = makePool();
  pool.sqlite.exec("UPDATE posts SET sort_status = 'auto', content_type = 'dance'");
  assert.strictEqual(await modelCanAccessPost(pool, 7, 1), true);
  pool.sqlite.exec("UPDATE posts SET video_cache_status = 'pending'; INSERT INTO model_saved_posts VALUES (7, 1)");
  assert.strictEqual(await modelCanAccessPost(pool, 7, 1, { requirePlayable: true }), false);
});
