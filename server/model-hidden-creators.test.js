const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { registerWorkspaceRoutes } = require('./workspace-routes');
const { buildMeFeedQuery } = require('./me-feed');
const { makeWorkspaceDb } = require('./test-support/workspace-db');
const { appRequest } = require('./test-support/app-request');

function appFor(pool) {
  const app = express();
  app.use(express.json());
  registerWorkspaceRoutes(app, { pool });
  return app;
}

async function feedIds(pool, options = {}) {
  const built = buildMeFeedQuery(['talking'], options);
  return (await pool.query(built.sql, built.params)).rows.map(row => row.id).sort((a, b) => a - b);
}

test('hidden creator routes normalize, deduplicate and preserve existing ownership and tracking', async t => {
  const pool = await makeWorkspaceDb(t);
  const app = appFor(pool);
  pool.sqlite.exec(`INSERT INTO tracked_accounts (username, status) VALUES ('creator', 'active');
    INSERT INTO model_creators (model_id, username, source, added_at) VALUES (1, 'creator', 'va', '2026-11-01');
    INSERT INTO suggested_accounts (username, status) VALUES ('creator', 'pending');
    INSERT INTO model_hidden_creators (model_id, username, hidden_at) VALUES (2, 'other', '2026-11-01')`);
  const unchanged = ['model_creators', 'tracked_accounts', 'suggested_accounts'];
  const snapshots = unchanged.map(table => pool.sqlite.prepare(`SELECT * FROM ${table}`).all());
  assert.deepEqual((await appRequest(app, { path: '/workspaces/1/hidden-creators' })).body, []);
  const added = await appRequest(app, {
    method: 'POST', path: '/workspaces/1/hidden-creators',
    body: { usernames: [' @Creator ', 'CREATOR', 'https://www.tiktok.com/@TikTok.Creator/video/123?lang=en'] },
  });
  assert.equal(added.status, 200);
  assert.deepEqual(added.body.map(row => row.username), ['creator', 'tiktok.creator']);
  for (const row of added.body) {
    assert.deepEqual(Object.keys(row).sort(), ['hidden_at', 'username']);
    assert.ok(Number.isFinite(Date.parse(row.hidden_at)));
  }
  const repeated = await appRequest(app, { method: 'POST', path: '/workspaces/1/hidden-creators', body: { usernames: ['@CREATOR'] } });
  assert.equal(repeated.status, 200);
  assert.deepEqual(repeated.body, added.body, 'repeated hides preserve their original timestamps');
  const listed = await appRequest(app, { path: '/workspaces/1/hidden-creators' });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body, added.body);
  const removed = await appRequest(app, { method: 'DELETE', path: '/workspaces/1/hidden-creators/%40CREATOR' });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body, added.body.filter(row => row.username !== 'creator'));
  assert.deepEqual((await appRequest(app, { method: 'DELETE', path: '/workspaces/1/hidden-creators/creator' })).body, removed.body);
  assert.deepEqual((await appRequest(app, { path: '/workspaces/2/hidden-creators' })).body, [{ username: 'other', hidden_at: '2026-11-01' }]);
  for (const [index, table] of unchanged.entries()) {
    assert.deepEqual(pool.sqlite.prepare(`SELECT * FROM ${table}`).all(), snapshots[index], `${table} is unchanged`);
  }
});

test('hidden creator validation rejects entire invalid batches and invalid delete handles', async t => {
  const pool = await makeWorkspaceDb(t);
  const app = appFor(pool);
  const invalidBodies = [
    undefined, {}, { usernames: 'creator' }, { usernames: [] }, { usernames: Array(51).fill('creator') },
    ...[null, 1, {}, '', ' ', '@', '@@creator', 'has-hyphen', 'has space', 'a'.repeat(31),
      "x'); DROP TABLE posts;--", 'https://instagram.com/creator', 'https://evil.test/@creator',
      'https://www.tiktok.com/@bad-handle'].map(value => ({ usernames: ['valid', value] })),
  ];
  for (const body of invalidBodies) {
    const response = await appRequest(app, { method: 'POST', path: '/workspaces/1/hidden-creators', body });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.deepEqual(pool.sqlite.prepare('SELECT * FROM model_hidden_creators').all(), [], 'invalid batches make no partial writes');
  }
  for (const username of ['@', 'bad-handle', 'a'.repeat(31), "x' OR 1=1--"]) {
    const response = await appRequest(app, { method: 'DELETE', path: `/workspaces/1/hidden-creators/${encodeURIComponent(username)}` });
    assert.equal(response.status, 400, username);
  }
  const boundary = await appRequest(app, {
    method: 'POST', path: '/workspaces/1/hidden-creators',
    body: { usernames: ['a'.repeat(30), ...Array.from({ length: 49 }, (_, index) => `creator_${index}`)] },
  });
  assert.equal(boundary.status, 200);
  assert.equal(boundary.body.length, 50);
  assert.ok(pool.sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'posts'").get());
});

test('hidden creator routes return unknown model 404 and newest-first lists', async t => {
  const pool = await makeWorkspaceDb(t);
  const app = appFor(pool);
  for (const [method, suffix] of [['GET', ''], ['POST', ''], ['DELETE', '/creator']]) {
    const response = await appRequest(app, { method, path: `/workspaces/999/hidden-creators${suffix}`, body: method === 'POST' ? { usernames: ['creator'] } : undefined });
    assert.equal(response.status, 404, method);
  }
  pool.sqlite.exec(`INSERT INTO model_hidden_creators (model_id, username, hidden_at) VALUES
    (1, 'old', '2026-11-01T00:00:00Z'), (1, 'z-new', '2026-11-20T00:00:00Z'),
    (1, 'a-new', '2026-11-20T00:00:00Z'), (2, 'other-model', '2026-11-21T00:00:00Z')`);
  const response = await appRequest(app, { path: '/workspaces/1/hidden-creators' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.map(row => row.username), ['a-new', 'z-new', 'old']);
});

for (const approved of [false, true]) {
  test(`hidden creators are excluded from all model Find variants with approved creators ${approved}`, async t => {
    const pool = await makeWorkspaceDb(t);
    const app = appFor(pool);
    pool.sqlite.exec(`INSERT INTO posts (id, account_handle, content_type, sort_status, video_cache_status) VALUES
      (1, 'HiDdEn', 'talking', 'auto', 'cached'), (2, 'visible', 'talking', 'auto', 'cached'),
      (3, 'outside', 'talking', 'auto', 'cached')`);
    if (approved) pool.sqlite.exec("INSERT INTO model_creators (model_id, username) VALUES (1, 'hidden'), (1, 'visible')");
    const before = approved ? [1, 2] : [1, 2, 3];
    assert.deepEqual(await feedIds(pool, { modelId: 1 }), before);
    const hide = await appRequest(app, { method: 'POST', path: '/workspaces/1/hidden-creators', body: { usernames: ['@HIDDEN'] } });
    assert.equal(hide.status, 200);
    for (const options of [{}, { niche: 'talking' }, { shuffle: true }, { lookTags: ['alt'], taste: { creators: [['hidden', 1]] } }]) {
      assert.deepEqual(await feedIds(pool, { modelId: 1, ...options }), before.filter(id => id !== 1));
    }
    assert.deepEqual(await feedIds(pool, { modelId: 2 }), [1, 2, 3], 'another model still sees the hidden creator');
    assert.deepEqual(await feedIds(pool, { all: true, modelId: 1 }), [2, 3], 'all mode applies hides without approved-creator scope');
    assert.deepEqual(await feedIds(pool, { all: true }), [1, 2, 3], 'unscoped all mode is unchanged');
    assert.deepEqual(await feedIds(pool), [1, 2, 3], 'unscoped feed is unchanged');
    const unhide = await appRequest(app, { method: 'DELETE', path: '/workspaces/1/hidden-creators/hidden' });
    assert.equal(unhide.status, 200);
    assert.deepEqual(await feedIds(pool, { modelId: 1 }), before);
  });
}
