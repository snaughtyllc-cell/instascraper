const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { makeWorkspaceDb } = require('./test-support/workspace-db');
const { appRequest } = require('./test-support/app-request');
const { registerWorkspaceRoutes } = require('./workspace-routes');

async function setup(t) {
  const pool = await makeWorkspaceDb(t);
  pool.sqlite.exec(`INSERT INTO suggested_accounts (username, suggestion_score) VALUES ('Candidate', 75);
    INSERT INTO model_suggestions (model_id, username, fit, reason) VALUES (1, 'candidate', 0.8, 'a fit'), (2, 'candidate', 0.7, 'another fit');
    INSERT INTO suggested_reels (id, username, shortcode, rank) VALUES (1, 'Candidate', 'top', 1)`);
  const app = express();
  app.use(express.json());
  registerWorkspaceRoutes(app, { pool });
  app.use((error, req, res, next) => res.status(500).json({ error: error.message }));
  return { pool, app };
}

test('approve in one workspace leaves it pending in another', async t => {
  const { pool, app } = await setup(t);
  const response = await appRequest(app, { method: 'POST', path: '/workspaces/1/suggestions/CANDIDATE/approve' });
  assert.equal(response.status, 200);
  assert.deepEqual(pool.sqlite.prepare('SELECT model_id, status FROM model_suggestions ORDER BY model_id').all(),
    [{ model_id: 1, status: 'approved' }, { model_id: 2, status: 'pending' }]);
  assert.deepEqual(pool.sqlite.prepare('SELECT username, source FROM model_creators').get(), { username: 'candidate', source: 'suggestion' });
  assert.equal(pool.sqlite.prepare('SELECT status FROM tracked_accounts').get().status, 'active');
  assert.equal(pool.sqlite.prepare('SELECT status FROM suggested_accounts').get().status, 'approved');
  const pending = await appRequest(app, { path: '/workspaces/2/suggestions' });
  assert.equal(pending.body.length, 1, 'global approved status does not hide another model pending suggestion');
  assert.equal(pending.body[0].status, 'pending');
  assert.equal(pending.body[0].top_reels[0].shortcode, 'top');
});

test('dismiss affects only that model', async t => {
  const { pool, app } = await setup(t);
  assert.equal((await appRequest(app, { method: 'POST', path: '/workspaces/1/suggestions/candidate/dismiss' })).status, 200);
  assert.deepEqual(pool.sqlite.prepare('SELECT status FROM model_suggestions ORDER BY model_id').all(), [{ status: 'dismissed' }, { status: 'pending' }]);
  assert.equal(pool.sqlite.prepare('SELECT status FROM suggested_accounts').get().status, 'pending');
});

test('dismiss cannot overwrite an approved suggestion', async t => {
  const { pool, app } = await setup(t);
  await appRequest(app, { method: 'POST', path: '/workspaces/1/suggestions/candidate/approve' });
  const response = await appRequest(app, { method: 'POST', path: '/workspaces/1/suggestions/candidate/dismiss' });
  assert.equal(response.status, 404);
  assert.equal(pool.sqlite.prepare('SELECT status FROM model_suggestions WHERE model_id = 1').get().status, 'approved');
});

test('snooze hides only one workspace for seven days', async t => {
  const { pool, app } = await setup(t);
  assert.equal((await appRequest(app, { method: 'POST', path: '/workspaces/1/suggestions/candidate/snooze' })).status, 200);
  assert.equal((await appRequest(app, { path: '/workspaces/1/suggestions' })).body.length, 0);
  assert.equal((await appRequest(app, { path: '/workspaces/2/suggestions' })).body.length, 1);
  const row = pool.sqlite.prepare('SELECT snoozed_until FROM model_suggestions WHERE model_id = 1').get();
  assert.ok(Math.abs(new Date(row.snoozed_until).getTime() - Date.now() - 7 * 86400000) < 1000);
});

test('failed approval rolls back creator ownership and activation', async t => {
  const { pool, app } = await setup(t);
  pool.sqlite.exec(`CREATE TRIGGER reject_approval BEFORE UPDATE ON model_suggestions
    BEGIN SELECT RAISE(ABORT, 'forced approval failure'); END;`);
  const response = await appRequest(app, { method: 'POST', path: '/workspaces/1/suggestions/candidate/approve' });
  assert.equal(response.status, 500);
  assert.equal(pool.sqlite.prepare('SELECT COUNT(*) AS n FROM model_creators').get().n, 0);
  assert.equal(pool.sqlite.prepare('SELECT COUNT(*) AS n FROM tracked_accounts').get().n, 0);
});
