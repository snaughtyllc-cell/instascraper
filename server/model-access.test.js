const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { modelCanAccessPost } = require('./model-access');

function makePool() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE posts (id INTEGER PRIMARY KEY, content_type TEXT, sort_status TEXT, account_handle TEXT,
    soft_deleted INTEGER DEFAULT 0, archived INTEGER DEFAULT 0, video_cache_status TEXT DEFAULT 'cached');
    CREATE TABLE model_creators (model_id INTEGER, username TEXT);
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

test('sorted reels outside the model niches are accessible and requirePlayable gates saved reels', async () => {
  const pool = makePool();
  pool.sqlite.exec("UPDATE posts SET sort_status = 'auto', content_type = 'skit'");
  assert.strictEqual(await modelCanAccessPost(pool, 7, 1), true);
  pool.sqlite.exec("UPDATE posts SET video_cache_status = 'pending'; INSERT INTO model_saved_posts VALUES (7, 1)");
  assert.strictEqual(await modelCanAccessPost(pool, 7, 1, { requirePlayable: true }), false);
});

test('owned sorted non-niche reels are accessible while needs_look and null types are hidden', async () => {
  const pool = makePool();
  pool.sqlite.exec("INSERT INTO model_creators VALUES (7,'creator'); UPDATE posts SET sort_status = 'manual', content_type = 'skit'");
  assert.strictEqual(await modelCanAccessPost(pool, 7, 1), true);
  pool.sqlite.exec("UPDATE posts SET sort_status = 'needs_look'");
  assert.strictEqual(await modelCanAccessPost(pool, 7, 1), false);
  pool.sqlite.exec("UPDATE posts SET sort_status = 'auto', content_type = NULL");
  assert.strictEqual(await modelCanAccessPost(pool, 7, 1), false);
});

test('a model with no niches can access sorted reels in her creator scope', async () => {
  const pool = makePool();
  pool.sqlite.exec("UPDATE models SET primary_niche = NULL, secondary_niches = NULL; UPDATE posts SET sort_status = 'auto'");
  assert.strictEqual(await modelCanAccessPost(pool, 7, 1), true);
});

test('assigned reel from a non-owned creator still accessible', async () => {
  const pool = makePool();
  pool.sqlite.exec("INSERT INTO model_creators VALUES (7,'other'); INSERT INTO model_assigned_posts VALUES (7,1,'assigned')");
  assert.strictEqual(await modelCanAccessPost(pool, 7, 1), true);
});
test('saved reel stays accessible after the creator is removed', async () => {
  const pool = makePool();
  pool.sqlite.exec("INSERT INTO model_creators VALUES (7,'other'); INSERT INTO model_saved_posts VALUES (7,1)");
  assert.strictEqual(await modelCanAccessPost(pool, 7, 1), true);
});
test('sorted non-owned niche reel is inaccessible while owned mixed-case handle matches', async () => {
  const pool = makePool();
  pool.sqlite.exec("UPDATE posts SET sort_status='auto'; INSERT INTO model_creators VALUES (7,'other')");
  assert.strictEqual(await modelCanAccessPost(pool, 7, 1), false);
  pool.sqlite.exec("INSERT INTO model_creators VALUES (7,'creator'); UPDATE posts SET account_handle='Creator'");
  assert.strictEqual(await modelCanAccessPost(pool, 7, 1), true);
});
