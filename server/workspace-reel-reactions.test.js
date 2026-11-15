const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { registerWorkspaceRoutes } = require('./workspace-routes');
const { buildMeFeedQuery } = require('./me-feed');
const { applyModelReaction } = require('./model-reactions');
const { loadTaste, tasteForFeed } = require('./model-taste');
const { makeWorkspaceDb } = require('./test-support/workspace-db');
const { appRequest } = require('./test-support/app-request');

async function setup(t) {
  const pool = await makeWorkspaceDb(t);
  pool.sqlite.exec(`ALTER TABLE model_post_feedback ADD COLUMN notes TEXT;
    ALTER TABLE model_post_feedback ADD COLUMN created_at TEXT;
    ALTER TABLE model_post_feedback ADD COLUMN updated_at TEXT;
    CREATE UNIQUE INDEX feedback_model_post ON model_post_feedback (model_id, post_id);
    ALTER TABLE model_saved_posts ADD COLUMN saved_at TEXT;
    CREATE UNIQUE INDEX saved_model_post ON model_saved_posts (model_id, post_id);
    INSERT INTO posts (id, account_handle, content_type, sort_status, video_cache_status, posted_at, ai_look_tags) VALUES
      (1, 'Mia', 'talking', 'auto', 'cached', '2026-11-01', '["brunette"]'),
      (2, 'Mia', 'talking', 'manual', 'cached', '2026-11-03', '["brunette"]'),
      (3, 'other', 'talking', 'auto', 'cached', '2026-11-02', '["glam"]')`);
  const app = express();
  app.use(express.json());
  registerWorkspaceRoutes(app, { pool });
  return { app, pool };
}

async function feedIds(pool, modelId) {
  const built = buildMeFeedQuery(['talking'], { modelId, taste: tasteForFeed(await loadTaste(pool, modelId)) });
  return (await pool.query(built.sql, built.params)).rows.map(row => row.id);
}

test('reject hides only that model reel, learns negative taste, and undo restores it', async t => {
  const { app, pool } = await setup(t);
  assert.deepEqual(await feedIds(pool, 1), [2, 3, 1]);
  const rejected = await appRequest(app, { method: 'POST', path: '/workspaces/1/reels/1/reject' });
  assert.equal(rejected.status, 200);
  assert.deepEqual(rejected.body, { saved: false, feedback: 'not_my_style' });
  assert.deepEqual(await feedIds(pool, 1), [3, 2], 'similar creator and look tags sink after the skip');
  assert.deepEqual(await feedIds(pool, 2), [2, 3, 1]);
  assert.deepEqual([...await loadTaste(pool, 1)], [
    ['creator:mia', -1 / 3], ['tag:brunette', -1 / 3], ['type:talking', -1 / 3],
  ]);
  assert.equal((await loadTaste(pool, 2)).size, 0);
  const workspace = await appRequest(app, { path: '/workspaces/1/reels' });
  assert.equal(workspace.status, 200);
  assert.deepEqual(workspace.body.map(row => row.id), [3, 2]);
  const undone = await appRequest(app, { method: 'DELETE', path: '/workspaces/1/reels/1/reject' });
  assert.equal(undone.status, 200);
  assert.deepEqual(undone.body, { success: true });
  assert.deepEqual(await feedIds(pool, 1), [2, 3, 1]);
  assert.equal((await loadTaste(pool, 1)).size, 0);
  assert.deepEqual((await appRequest(app, { path: '/workspaces/1/reels' })).body.map(row => row.id), [2, 3, 1]);
});

test('reject and undo are idempotent and undo preserves a newer save', async t => {
  const { app, pool } = await setup(t);
  const path = '/workspaces/1/reels/1/reject';
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal((await appRequest(app, { method: 'POST', path })).status, 200);
  }
  assert.equal(pool.sqlite.prepare('SELECT COUNT(*) AS n FROM model_post_feedback').get().n, 1);
  await applyModelReaction(pool, { modelId: 1, postId: 1, reaction: 'save' });
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal((await appRequest(app, { method: 'DELETE', path })).status, 200);
  }
  assert.equal(pool.sqlite.prepare('SELECT feedback FROM model_post_feedback WHERE model_id=1 AND post_id=1').get().feedback, 'want_to_make');
  assert.ok(pool.sqlite.prepare('SELECT 1 FROM model_saved_posts WHERE model_id=1 AND post_id=1').get());
  assert.equal((await loadTaste(pool, 1)).get('creator:mia'), 1 / 3);
});

test('both verbs reject invalid, missing, and non-visible reels without recording feedback', async t => {
  const { app, pool } = await setup(t);
  pool.sqlite.exec(`INSERT INTO posts (id, account_handle, content_type, sort_status, video_cache_status, archived, soft_deleted) VALUES
    (10, 'Mia', 'talking', 'unsorted', 'cached', 0, 0),
    (11, 'Mia', 'talking', 'needs_look', 'cached', 0, 0),
    (12, 'Mia', NULL, 'auto', 'cached', 0, 0),
    (13, 'Mia', 'talking', 'auto', 'cached', 1, 0),
    (14, 'Mia', 'talking', 'auto', 'cached', 0, 1),
    (15, 'Mia', 'talking', 'auto', 'pending', 0, 0)`);
  const ids = ['abc', '0', '-1', '1.5', '1abc', '1e0', '2147483648', '9007199254740992', '999', '10', '11', '12', '13', '14', '15'];
  for (const method of ['POST', 'DELETE']) {
    for (const id of ids) {
      const response = await appRequest(app, { method, path: `/workspaces/1/reels/${id}/reject` });
      assert.equal(response.status, 404, `${method} ${id}`);
      assert.deepEqual(response.body, { error: 'reel_not_available' });
    }
  }
  assert.equal(pool.sqlite.prepare('SELECT COUNT(*) AS n FROM model_post_feedback').get().n, 0);
});

test('strict creator scope rejects historical access while matching mixed-case owned handles', async t => {
  const { app, pool } = await setup(t);
  pool.sqlite.exec(`INSERT INTO model_creators (model_id, username) VALUES (1, 'mia');
    INSERT INTO model_saved_posts (model_id, post_id) VALUES (1, 3);
    INSERT INTO model_post_feedback (model_id, post_id, feedback) VALUES (1, 3, 'not_my_style');
    INSERT INTO model_assigned_posts (model_id, post_id, status) VALUES (1, 3, 'assigned')`);
  for (const method of ['POST', 'DELETE']) {
    const response = await appRequest(app, { method, path: '/workspaces/1/reels/3/reject' });
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { error: 'reel_not_available' });
  }
  assert.equal(pool.sqlite.prepare('SELECT feedback FROM model_post_feedback WHERE model_id=1 AND post_id=3').get().feedback, 'not_my_style');
  assert.ok(pool.sqlite.prepare('SELECT 1 FROM model_saved_posts WHERE model_id=1 AND post_id=3').get());
  assert.equal((await appRequest(app, { method: 'POST', path: '/workspaces/1/reels/1/reject' })).status, 200);
  assert.equal((await appRequest(app, { method: 'DELETE', path: '/workspaces/1/reels/1/reject' })).status, 200);
});
