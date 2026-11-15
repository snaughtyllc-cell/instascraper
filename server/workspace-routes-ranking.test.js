const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { registerWorkspaceRoutes } = require('./workspace-routes');
const { appRequest } = require('./test-support/app-request');
const { makeWorkspaceDb } = require('./test-support/workspace-db');

function appFor(pool) {
  const app = express();
  app.use(express.json());
  registerWorkspaceRoutes(app, { pool });
  return app;
}

test('proposals with equal share ordered by look match; rows include look_match', async t => {
  const pool = await makeWorkspaceDb(t);
  pool.sqlite.exec(`UPDATE models SET look_tags='["brunette"]' WHERE id=1;
    INSERT INTO model_creator_proposals (model_id,username,share,status) VALUES (1,'a',0.5,'pending'),(1,'z',0.5,'pending'),(1,'none',0.4,'pending');
    INSERT INTO posts (id,account_handle,content_type,sort_status,ai_look_tags) VALUES
      (1,'a','talking','auto','["blonde"]'),(2,'Z','talking','auto','["brunette"]');`);
  const response = await appRequest(appFor(pool), { path: '/workspaces/1/proposals' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.map(row => [row.username, row.look_match]), [['z', 1], ['a', 0], ['none', 0]]);
});

test('suggestions with equal fit ordered by look match before suggestion_score', async t => {
  const pool = await makeWorkspaceDb(t);
  pool.sqlite.exec(`UPDATE models SET look_tags='["brunette"]' WHERE id=1;
    INSERT INTO suggested_accounts (username,suggestion_score) VALUES ('a',90),('z',10),('none',100);
    INSERT INTO model_suggestions (model_id,username,fit,status) VALUES (1,'a',0.5,'pending'),(1,'z',0.5,'pending'),(1,'none',0.4,'pending');
    INSERT INTO suggested_reels (id,username,rank,ai_type,ai_confidence,ai_classified_at,ai_look_tags) VALUES
      (1,'a',1,'talking',0.9,'2026-11-15','["blonde"]'),(2,'Z',1,'talking',0.9,'2026-11-15','["brunette"]');`);
  const response = await appRequest(appFor(pool), { path: '/workspaces/1/suggestions' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.map(row => [row.username, row.look_match]), [['z', 1], ['a', 0], ['none', 0]]);
});

test('workspace reels include look_match and ignore deleted model vocabulary tags', async t => {
  const pool = await makeWorkspaceDb(t);
  pool.sqlite.exec(`UPDATE models SET look_tags='["brunette","deleted"]' WHERE id=1;
    INSERT INTO posts (id,account_handle,content_type,sort_status,posted_at,video_cache_status,ai_look_tags) VALUES
      (1,'a','talking','auto','2026-07-01','cached','["brunette"]'),
      (2,'b','talking','auto','2026-07-02','cached','["deleted"]');`);
  const response = await appRequest(appFor(pool), { path: '/workspaces/1/reels' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.map(row => [row.id, row.look_match]), [[1, 1], [2, 0]]);
});

test('workspace reels rank niche matches first and include other sorted types within creator scope', async t => {
  const pool = await makeWorkspaceDb(t);
  pool.sqlite.exec(`UPDATE models SET look_tags = '["brunette"]' WHERE id = 1;
    INSERT INTO posts (id, account_handle, content_type, sort_status, posted_at, video_cache_status, ai_look_tags) VALUES
      (1, 'owned', 'talking', 'auto', '2026-07-01', 'cached', '[]'),
      (2, 'owned', 'dance', 'manual', '2026-07-03', 'cached', '["brunette"]'),
      (3, 'other', 'dance', 'auto', '2026-07-02', 'cached', '[]'),
      (4, 'owned', 'talking', 'unsorted', '2026-07-04', 'cached', '["brunette"]'),
      (5, 'owned', 'talking', 'needs_look', '2026-07-05', 'cached', '["brunette"]'),
      (6, 'owned', NULL, 'auto', '2026-07-06', 'cached', '["brunette"]');
    INSERT INTO model_taste (model_id, feature, affinity) VALUES (1, 'creator:owned', -0.5), (1, 'type:dance', 1)`);
  const app = appFor(pool);
  const fallback = await appRequest(app, { path: '/workspaces/1/reels' });
  assert.equal(fallback.status, 200);
  assert.deepEqual(fallback.body.map(row => row.id), [1, 2, 3]);
  pool.sqlite.exec("INSERT INTO model_creators (model_id, username) VALUES (1, 'owned')");
  const scoped = await appRequest(app, { path: '/workspaces/1/reels' });
  assert.equal(scoped.status, 200);
  assert.deepEqual(scoped.body.map(row => row.id), [1, 2]);
});

test('taste endpoint returns top five liked and disliked features', async t => {
  const pool = await makeWorkspaceDb(t);
  for (let i = 1; i <= 7; i++) {
    await pool.query('INSERT INTO model_taste (model_id,feature,affinity,positives,negatives) VALUES ($1,$2,$3,$4,$5)', [1, `creator:like${i}`, i / 10, i, 0]);
    await pool.query('INSERT INTO model_taste (model_id,feature,affinity,positives,negatives) VALUES ($1,$2,$3,$4,$5)', [1, `creator:dislike${i}`, -i / 10, 0, i]);
  }
  const response = await appRequest(appFor(pool), { path: '/workspaces/1/taste' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.liked.map(row => row.feature), [7, 6, 5, 4, 3].map(i => `creator:like${i}`));
  assert.deepEqual(response.body.disliked.map(row => row.feature), [7, 6, 5, 4, 3].map(i => `creator:dislike${i}`));
  assert.deepEqual((await appRequest(appFor(pool), { path: '/workspaces/2/taste' })).body, { liked: [], disliked: [] });
});

test('creator taste reorders equal-share proposals and equal-fit suggestions without filtering', async t => {
  const pool = await makeWorkspaceDb(t);
  pool.sqlite.exec(`INSERT INTO model_creator_proposals (model_id,username,share,status) VALUES (1,'a',0.5,'pending'),(1,'z',0.5,'pending');
    INSERT INTO suggested_accounts (username,suggestion_score) VALUES ('a',90),('z',10);
    INSERT INTO model_suggestions (model_id,username,fit,status) VALUES (1,'a',0.5,'pending'),(1,'z',0.5,'pending');
    INSERT INTO model_taste (model_id,feature,affinity) VALUES (1,'creator:a',-0.5),(1,'tag:brunette',0.5);
    INSERT INTO posts (id,account_handle,content_type,sort_status,ai_look_tags) VALUES (1,'z','talking','auto','["brunette"]');
    INSERT INTO suggested_reels (id,username,rank,ai_type,ai_confidence,ai_classified_at,ai_look_tags) VALUES (1,'z',1,'talking',0.9,'2026-11-15','["brunette"]');`);
  const app = appFor(pool);
  for (const section of ['proposals', 'suggestions']) {
    const response = await appRequest(app, { path: `/workspaces/1/${section}` });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.map(row => row.username), ['z', 'a']);
    assert.equal(response.body[0].look_match, 0, 'taste works with no model look');
  }
});
