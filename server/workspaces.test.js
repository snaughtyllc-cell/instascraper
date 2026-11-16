const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { execFileSync } = require('node:child_process');
const { makeWorkspaceDb } = require('./test-support/workspace-db');
const { appRequest } = require('./test-support/app-request');
const { addCreator, removeCreator, listWorkspaceCreators } = require('./workspaces');
const { registerWorkspaceRoutes } = require('./workspace-routes');

function appFor(pool) {
  const app = express();
  app.use(express.json());
  registerWorkspaceRoutes(app, { pool });
  return app;
}

test('add creates the tracked account active and links it', async t => {
  const pool = await makeWorkspaceDb(t);
  pool.sqlite.exec("INSERT INTO suggested_accounts (username, followers, bio, avg_er) VALUES ('Mia.Talks', 123, 'hello', 4)");
  assert.deepEqual(await addCreator(pool, 1, ' @Mia.Talks '), { added: true });
  assert.deepEqual(pool.sqlite.prepare('SELECT username, status, followers, bio, avg_er FROM tracked_accounts').get(),
    { username: 'mia.talks', status: 'active', followers: 123, bio: 'hello', avg_er: 4 });
  assert.equal(pool.sqlite.prepare('SELECT source FROM model_creators').get().source, 'va');
  assert.deepEqual(await addCreator(pool, 1, 'MIA.TALKS'), { added: false });
});

test('add reactivates a paused creator', async t => {
  const pool = await makeWorkspaceDb(t);
  pool.sqlite.exec("INSERT INTO tracked_accounts (username, status) VALUES ('Mia.Talks', 'paused')");
  await addCreator(pool, 1, 'mia.talks');
  assert.equal(pool.sqlite.prepare('SELECT status FROM tracked_accounts').get().status, 'active');
  assert.equal(pool.sqlite.prepare('SELECT COUNT(*) AS n FROM tracked_accounts').get().n, 1);
});

test('creator platform defaults on insert and only changes when explicitly provided', async t => {
  const pool = await makeWorkspaceDb(t);
  await addCreator(pool, 1, 'instagram.creator');
  assert.equal(pool.sqlite.prepare("SELECT platform FROM tracked_accounts WHERE username = 'instagram.creator'").get().platform, 'instagram');
  await addCreator(pool, 1, 'https://www.tiktok.com/@TikTok.Creator/video/123?lang=en', 'va', 'tiktok');
  assert.equal(pool.sqlite.prepare("SELECT platform FROM tracked_accounts WHERE username = 'tiktok.creator'").get().platform, 'tiktok');
  await addCreator(pool, 2, '@TIKTOK.CREATOR');
  assert.equal(pool.sqlite.prepare("SELECT platform FROM tracked_accounts WHERE username = 'tiktok.creator'").get().platform, 'tiktok');
  assert.equal((await listWorkspaceCreators(pool, 2))[0].platform, 'tiktok');
  await addCreator(pool, 2, 'tiktok.creator', 'va', 'instagram');
  assert.equal(pool.sqlite.prepare("SELECT platform FROM tracked_accounts WHERE username = 'tiktok.creator'").get().platform, 'instagram');
});

test('workspace creator route accepts TikTok platform and rejects unsupported platforms', async t => {
  const pool = await makeWorkspaceDb(t);
  const app = appFor(pool);
  const response = await appRequest(app, { method: 'POST', path: '/workspaces/1/creators',
    body: { username: 'https://www.tiktok.com/@TikTok.Creator', platform: 'tiktok' } });
  assert.equal(response.status, 200);
  assert.deepEqual(pool.sqlite.prepare('SELECT username, platform FROM tracked_accounts').get(), { username: 'tiktok.creator', platform: 'tiktok' });
  for (const platform of ['youtube', '', null, 1, {}]) {
    assert.equal((await appRequest(app, { method: 'POST', path: '/workspaces/1/creators', body: { username: 'other', platform } })).status, 400);
  }
  assert.equal(pool.sqlite.prepare('SELECT COUNT(*) AS n FROM tracked_accounts').get().n, 1);
});

test('add recreates a tracked row removed before activation', async t => {
  const pool = await makeWorkspaceDb(t);
  pool.sqlite.exec("INSERT INTO tracked_accounts (username, status) VALUES ('mia.talks', 'paused')");
  const query = pool.query;
  let deleted = false;
  pool.query = async (sql, params) => {
    if (!deleted && /^UPDATE tracked_accounts SET status/.test(sql)) {
      deleted = true;
      pool.sqlite.prepare("DELETE FROM tracked_accounts WHERE username = 'mia.talks'").run();
    }
    return query(sql, params);
  };
  await addCreator(pool, 1, 'mia.talks');
  assert.deepEqual(pool.sqlite.prepare('SELECT username, status FROM tracked_accounts').get(), { username: 'mia.talks', status: 'active' });
  assert.equal(pool.sqlite.prepare('SELECT COUNT(*) AS n FROM model_creators').get().n, 1);
});

test('remove pauses when it was the last model', async t => {
  const pool = await makeWorkspaceDb(t);
  await addCreator(pool, 1, 'mia.talks');
  assert.deepEqual(await removeCreator(pool, 1, 'Mia.Talks'), { removed: true, paused: true });
  assert.equal(pool.sqlite.prepare('SELECT status FROM tracked_accounts').get().status, 'paused');
});

test('remove keeps active when another model owns', async t => {
  const pool = await makeWorkspaceDb(t);
  await addCreator(pool, 1, 'mia.talks');
  await addCreator(pool, 2, 'Mia.Talks');
  assert.deepEqual(await removeCreator(pool, 1, 'MIA.TALKS'), { removed: true, paused: false });
  assert.equal(pool.sqlite.prepare('SELECT status FROM tracked_accounts').get().status, 'active');
});

test('removing a nonexistent pair does not pause a never-assigned creator', async t => {
  const pool = await makeWorkspaceDb(t);
  pool.sqlite.exec("INSERT INTO tracked_accounts (username) VALUES ('legacy')");
  assert.deepEqual(await removeCreator(pool, 1, 'legacy'), { removed: false, paused: false });
  assert.equal(pool.sqlite.prepare('SELECT status FROM tracked_accounts').get().status, 'active');
});

test('invalid modelId → 400', async t => {
  const app = appFor(await makeWorkspaceDb(t));
  for (const id of ['abc', '0', '-1', '1.5', '1abc']) {
    assert.equal((await appRequest(app, { path: `/workspaces/${id}` })).status, 400);
  }
});

test('unknown model → 404', async t => {
  const app = appFor(await makeWorkspaceDb(t));
  assert.equal((await appRequest(app, { path: '/workspaces/999' })).status, 404);
});

test('workspace fallback switches with its first creator and creators include mix', async t => {
  const pool = await makeWorkspaceDb(t);
  const app = appFor(pool);
  assert.equal((await appRequest(app, { path: '/workspaces/1' })).body.fallback, true);
  await appRequest(app, { method: 'POST', path: '/workspaces/1/creators', body: { username: 'Mia.Talks' } });
  pool.sqlite.exec("INSERT INTO posts (id, account_handle, content_type, sort_status) VALUES (1, 'Mia.Talks', 'talking', 'auto')");
  const workspace = (await appRequest(app, { path: '/workspaces/1' })).body;
  assert.equal(workspace.creatorCount, 1);
  assert.equal(workspace.fallback, false);
  assert.deepEqual((await listWorkspaceCreators(pool, 1))[0].mix, [{ type: 'talking', pct: 100 }]);
});

test('real SQLite adapter serializes concurrent ownership transactions and recovers after rollback', () => {
  execFileSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const pool = require('./db');
    const { addCreator, removeCreator } = require('./workspaces');
    (async () => {
      await pool.initDB();
      await pool.query("INSERT INTO models (id, name, primary_niche) VALUES (1, 'One', 'talking'), (2, 'Two', 'dance')");
      await Promise.all([addCreator(pool, 1, 'alice'), addCreator(pool, 2, 'bob')]);
      await Promise.all([removeCreator(pool, 1, 'alice'), addCreator(pool, 2, 'ALICE')]);
      assert.deepEqual((await pool.query("SELECT model_id FROM model_creators WHERE username = 'alice'")).rows, [{ model_id: 2 }]);
      assert.equal((await pool.query("SELECT status FROM tracked_accounts WHERE username = 'alice'")).rows[0].status, 'active');
      const failed = pool.transaction(async db => {
        await db.query("UPDATE tracked_accounts SET status = 'paused' WHERE username = 'alice'");
        throw new Error('rollback requested');
      });
      const next = addCreator(pool, 1, 'charlie');
      await assert.rejects(failed, /rollback requested/);
      await next;
      assert.equal((await pool.query("SELECT status FROM tracked_accounts WHERE username = 'alice'")).rows[0].status, 'active');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { cwd: __dirname, env: { ...process.env, NODE_USE_SYSTEM_CA: '0', GEMINI_API_KEY: '', DATABASE_URL: '', SQLITE_PATH: ':memory:' }, stdio: 'pipe' });
});
