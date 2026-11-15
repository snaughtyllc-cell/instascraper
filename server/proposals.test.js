const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { makeWorkspaceDb } = require('./test-support/workspace-db');
const { appRequest } = require('./test-support/app-request');
const { computeProposals } = require('./proposals');
const { registerWorkspaceRoutes } = require('./workspace-routes');

function seed(pool) {
  pool.sqlite.exec(`INSERT INTO tracked_accounts (username, status) VALUES ('mixed', 'paused');
    INSERT INTO posts (id, account_handle, content_type, sort_status) VALUES
    (1, 'Mixed', 'talking', 'auto'), (2, 'mixed', 'skit', 'auto'), (3, 'mixed', 'skit', 'manual'),
    (4, 'mixed', 'dance', 'unsorted'), (5, 'mixed', 'dance', 'needs_look');
    UPDATE posts SET archived = 1 WHERE id = 5`);
}

test('proposes when share ≥ 0.3', async t => {
  const pool = await makeWorkspaceDb(t);
  seed(pool);
  assert.deepEqual(await computeProposals(pool), { proposed: 1 });
  const row = pool.sqlite.prepare('SELECT model_id, username, share, status FROM model_creator_proposals').get();
  assert.deepEqual(row, { model_id: 1, username: 'mixed', share: 1 / 3, status: 'pending' });
  assert.deepEqual(await computeProposals(pool), { proposed: 0 });
  pool.sqlite.exec("UPDATE posts SET content_type = 'talking' WHERE id = 2");
  await computeProposals(pool);
  assert.equal(pool.sqlite.prepare('SELECT share FROM model_creator_proposals').get().share, 2 / 3);
});

test('rejected and owned pairs are not re-proposed', async t => {
  const pool = await makeWorkspaceDb(t);
  seed(pool);
  pool.sqlite.exec(`INSERT INTO model_creator_proposals (model_id, username, share, status) VALUES (1, 'mixed', 0.9, 'rejected');
    INSERT INTO models (id, name, primary_niche) VALUES (3, 'Lila', 'talking');
    INSERT INTO model_creators (model_id, username) VALUES (3, 'mixed')`);
  assert.deepEqual(await computeProposals(pool), { proposed: 0 });
  assert.deepEqual(pool.sqlite.prepare('SELECT status, share FROM model_creator_proposals').get(), { status: 'rejected', share: 0.9 });
});

test('look match of at least 0.5 proposes below-threshold creators using current vocabulary', async t => {
  const pool = await makeWorkspaceDb(t);
  pool.sqlite.exec(`UPDATE models SET look_tags = '[" BRUNETTE ","emo","deleted"]' WHERE id = 1;
    INSERT INTO tracked_accounts (username) VALUES ('half'), ('low'), ('manual'), ('unsorted'), ('deleted'), ('untyped'), ('rejected'), ('owned');
    INSERT INTO posts (id, account_handle, content_type, sort_status, ai_look_tags) VALUES
      (1, 'half', 'dance', 'auto', '["brunette"]'),
      (2, 'low', 'dance', 'auto', '["brunette"]'), (3, 'low', 'dance', 'manual', '[]'),
      (4, 'manual', 'dance', 'manual', '[]'),
      (5, 'unsorted', 'dance', 'auto', '[]'), (6, 'unsorted', 'dance', 'unsorted', '["brunette","emo"]'),
      (7, 'deleted', 'dance', 'auto', '["deleted"]'), (8, 'untyped', NULL, 'auto', '["brunette","emo"]'),
      (9, 'rejected', 'dance', 'auto', '["brunette","emo"]'), (10, 'owned', 'dance', 'auto', '["brunette","emo"]');
    INSERT INTO creator_look_tags (username, tag) VALUES ('manual', 'emo');
    INSERT INTO model_creator_proposals (model_id, username, share, status) VALUES (1, 'rejected', 0, 'rejected');
    INSERT INTO model_creators (model_id, username) VALUES (1, 'owned')`);
  assert.deepEqual(await computeProposals(pool, { modelId: 1 }), { proposed: 2 });
  assert.deepEqual(pool.sqlite.prepare("SELECT username, share FROM model_creator_proposals WHERE status = 'pending' ORDER BY username").all(),
    [{ username: 'half', share: 0 }, { username: 'manual', share: 0 }]);
  assert.equal(pool.sqlite.prepare("SELECT status FROM model_creator_proposals WHERE username = 'rejected'").get().status, 'rejected');
});

test('models without current look tags still require the niche threshold', async t => {
  const pool = await makeWorkspaceDb(t);
  pool.sqlite.exec(`UPDATE models SET look_tags = '["deleted"]' WHERE id = 1;
    INSERT INTO tracked_accounts (username) VALUES ('other');
    INSERT INTO posts (id, account_handle, content_type, sort_status, ai_look_tags)
      VALUES (1, 'other', 'dance', 'auto', '["brunette","deleted"]')`);
  assert.deepEqual(await computeProposals(pool, { modelId: 1 }), { proposed: 0 });
  assert.equal(pool.sqlite.prepare('SELECT COUNT(*) AS n FROM model_creator_proposals').get().n, 0);
});

test('refresh endpoint recomputes only its model and returns newly proposed count', async t => {
  const pool = await makeWorkspaceDb(t);
  pool.sqlite.exec(`INSERT INTO tracked_accounts (username) VALUES ('talker'), ('dancer');
    INSERT INTO posts (id, account_handle, content_type, sort_status) VALUES
      (1, 'talker', 'talking', 'auto'), (2, 'dancer', 'dance', 'manual')`);
  const app = express();
  app.use(express.json());
  registerWorkspaceRoutes(app, { pool });
  const response = await appRequest(app, { method: 'POST', path: '/workspaces/1/proposals/refresh' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { proposed: 1 });
  assert.deepEqual(pool.sqlite.prepare('SELECT model_id, username FROM model_creator_proposals').all(),
    [{ model_id: 1, username: 'talker' }]);
  assert.deepEqual((await appRequest(app, { method: 'POST', path: '/workspaces/1/proposals/refresh' })).body, { proposed: 0 });
  assert.equal((await appRequest(app, { method: 'POST', path: '/workspaces/999/proposals/refresh' })).status, 404);
});

test('a creator added during proposal computation is not proposed', async t => {
  const pool = await makeWorkspaceDb(t);
  seed(pool);
  const query = pool.query;
  let linked = false;
  pool.query = async (sql, params) => {
    if (!linked && /^INSERT INTO model_creator_proposals/.test(sql)) {
      linked = true;
      pool.sqlite.prepare("INSERT INTO model_creators (model_id, username) VALUES (1, 'mixed')").run();
    }
    return query(sql, params);
  };
  assert.deepEqual(await computeProposals(pool), { proposed: 0 });
  assert.equal(pool.sqlite.prepare('SELECT COUNT(*) AS n FROM model_creator_proposals').get().n, 0);
});

test('confirm-all links every pending pair and sets creators active', async t => {
  const pool = await makeWorkspaceDb(t);
  pool.sqlite.exec(`INSERT INTO tracked_accounts (username, status) VALUES ('one', 'paused'), ('two', 'paused');
    INSERT INTO model_creator_proposals (model_id, username, share) VALUES (1, 'one', 1), (1, 'two', 0.5), (2, 'two', 1)`);
  const app = express();
  app.use(express.json());
  registerWorkspaceRoutes(app, { pool });
  const response = await appRequest(app, { method: 'POST', path: '/workspaces/1/proposals/confirm-all' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { confirmed: 2 });
  assert.deepEqual(pool.sqlite.prepare('SELECT username, source FROM model_creators ORDER BY username').all(),
    [{ username: 'one', source: 'proposal' }, { username: 'two', source: 'proposal' }]);
  assert.deepEqual(pool.sqlite.prepare('SELECT status FROM tracked_accounts').all(), [{ status: 'active' }, { status: 'active' }]);
  assert.equal(pool.sqlite.prepare('SELECT status FROM model_creator_proposals WHERE model_id = 2').get().status, 'pending');
});
