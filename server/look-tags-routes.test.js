const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { appRequest } = require('./test-support/app-request');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'look-tags-api-'));
Object.assign(process.env, {
  NODE_ENV: 'test', NODE_USE_SYSTEM_CA: '0', DATABASE_URL: '', SQLITE_PATH: path.join(dir, 'db.sqlite'),
  AUTH_PASSWORD: 'fake-look-tags-admin', SESSION_SECRET: 'fake-look-tags-test-session-secret',
  INSTASCRAPER_API_KEY: '', GEMINI_API_KEY: '', APIFY_API_KEY: '', ANTHROPIC_API_KEY: '', NOTION_API_KEY: '', SENTRY_DSN: '',
  GEMINI_PRICE_IN_PER_M: '0.30', GEMINI_PRICE_OUT_PER_M: '2.50',
});
const pool = require('./db');
const app = require('./index');
let adminCookie, modelCookie;
const request = (method, url, body, cookie = adminCookie) => appRequest(app, {
  method, path: url, body, headers: cookie ? { Cookie: cookie } : {},
});

before(async () => {
  await pool.initDB();
  await pool.query(`INSERT INTO models (id, name, primary_niche, email, password_hash, login_enabled, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7)`,
  [11, 'Logan', 'talking', 'look-tags@example.test', bcrypt.hashSync('fake-model-password', 4), 1, 'active']);
  await pool.query("INSERT INTO models (id, name, primary_niche, status) VALUES (12, 'Gigi', 'talking', 'active')");
  await pool.query("INSERT INTO tracked_accounts (username, status) VALUES ('creator', 'active')");
  await pool.query("INSERT INTO model_creators (model_id, username) VALUES (11, 'creator')");
  for (const [id, tags] of [[101, ['brunette', 'bedroom']], [102, ['brunette']], [103, ['bedroom']], [104, []]]) {
    await pool.query(`INSERT INTO posts (id, shortcode, account_handle, content_type, sort_status, video_cache_status, posted_at, ai_look_tags)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, `look-reel-${id}`, 'creator', 'talking', id === 102 ? 'manual' : 'auto', 'cached', `2026-11-${id - 100}`, JSON.stringify(tags)]);
  }
  const admin = await request('POST', '/login', { password: 'fake-look-tags-admin' }, null);
  assert.equal(admin.status, 200);
  adminCookie = admin.headers['set-cookie'][0].split(';')[0];
  const model = await request('POST', '/login', { email: 'look-tags@example.test', password: 'fake-model-password' }, null);
  assert.equal(model.status, 200);
  modelCookie = model.headers['set-cookie'][0].split(';')[0];
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('model look tags write as filtered JSON and read as arrays in models and workspace', async () => {
  const response = await request('PUT', '/models/11', { name: 'Logan', primary_niche: 'talking', look_tags: ['BRUNETTE', 'bedroom', 'unknown', 'brunette'] });
  assert.equal(response.status, 200);
  assert.equal((await pool.query('SELECT look_tags FROM models WHERE id = 11')).rows[0].look_tags, '["brunette","bedroom"]');
  const models = await request('GET', '/models');
  assert.equal(models.status, 200);
  assert.deepEqual(models.body.find(model => model.id === 11).look_tags, ['brunette', 'bedroom']);
  const summary = await request('GET', '/workspaces/11');
  assert.equal(summary.status, 200);
  assert.deepEqual(summary.body.model.look_tags, ['brunette', 'bedroom']);
});

test('Logan brunette and bedroom rank matching reels first while retaining every eligible row', async () => {
  const workspace = await request('GET', '/workspaces/11/reels');
  assert.equal(workspace.status, 200);
  assert.deepEqual(workspace.body.map(row => row.id), [101, 103, 102, 104]);
  assert.deepEqual(workspace.body.map(row => row.look_match), [1, 0.5, 0.5, 0]);
  const feed = await request('GET', '/me/feed', undefined, modelCookie);
  assert.equal(feed.status, 200);
  assert.deepEqual(feed.body.posts.map(row => row.id), [101, 103, 102, 104]);
  assert.deepEqual([...feed.body.posts.map(row => row.id)].sort(), [101, 102, 103, 104]);
});

test('creator look shows brunette 50 percent and manually added custom tag 100 percent', async () => {
  const added = await request('POST', '/look-tags', { label: 'Stage persona', category: 'custom' });
  assert.equal(added.status, 201);
  assert.equal((await request('POST', '/creators/CREATOR/look-tags', { tag: 'STAGE-PERSONA' })).status, 200);
  assert.equal((await request('POST', '/creators/creator/look-tags', { tag: 'missing' })).status, 400);
  const expected = [{ tag: 'stage-persona', share: 1, manual: true }, { tag: 'bedroom', share: 0.5, manual: false }, { tag: 'brunette', share: 0.5, manual: false }];
  assert.deepEqual((await request('GET', '/creators')).body.find(row => row.account_handle === 'creator').look, expected);
  assert.deepEqual((await request('GET', '/workspaces/11/creators')).body[0].look, expected);
  assert.deepEqual((await pool.query('SELECT username, tag FROM creator_look_tags')).rows, [{ username: 'creator', tag: 'stage-persona' }]);
  assert.equal((await request('DELETE', '/creators/CREATOR/look-tags/STAGE-PERSONA')).status, 200);
  assert.equal((await request('GET', '/workspaces/11/creators')).body[0].look.some(tag => tag.tag === 'stage-persona'), false);
});

test('look vocabulary CRUD is idempotent and admin only', async () => {
  for (const cookie of [null, modelCookie]) {
    for (const [method, url, body] of [
      ['GET', '/look-tags'], ['POST', '/look-tags', { label: 'Forbidden', category: 'custom' }],
      ['DELETE', '/look-tags/1'], ['POST', '/creators/creator/look-tags', { tag: 'brunette' }],
      ['DELETE', '/creators/creator/look-tags/brunette'], ['GET', '/sort/look-backfill/estimate'],
    ]) assert.equal((await request(method, url, body, cookie)).status, 403, `${method} ${url}`);
  }
  assert.equal((await request('POST', '/look-tags', { label: 'Bad category', category: 'unknown' })).status, 400);
  const first = await request('POST', '/look-tags', { label: 'Soft glam', category: 'aesthetic' });
  const second = await request('POST', '/look-tags', { label: ' SOFT GLAM ', category: 'aesthetic' });
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(first.body.id, second.body.id);
  const vocabulary = await request('GET', '/look-tags');
  assert.equal(vocabulary.body.filter(tag => tag.value === 'soft-glam').length, 1);
  assert.deepEqual(vocabulary.body.map(({ category, sort_order, label }) => [category, sort_order, label]),
    [...vocabulary.body].sort((a, b) => a.category.localeCompare(b.category) || a.sort_order - b.sort_order || a.label.localeCompare(b.label)).map(({ category, sort_order, label }) => [category, sort_order, label]));
});

test('deleting an in-use vocabulary tag leaves clean model, workspace and creator reads', async () => {
  const vocabulary = (await request('GET', '/look-tags')).body;
  const tag = vocabulary.find(row => row.value === 'soft-glam');
  assert.equal((await request('PUT', '/models/12', { name: 'Gigi', primary_niche: 'talking', look_tags: ['soft-glam', 'brunette'] })).status, 200);
  assert.equal((await request('POST', '/creators/creator/look-tags', { tag: 'soft-glam' })).status, 200);
  await pool.query('UPDATE posts SET ai_look_tags = $1 WHERE id = $2', ['["brunette","bedroom","soft-glam"]', 101]);
  assert.equal((await request('DELETE', `/look-tags/${tag.id}`)).status, 200);
  assert.equal((await request('GET', '/look-tags')).body.some(row => row.value === 'soft-glam'), false);
  assert.deepEqual((await request('GET', '/models')).body.find(row => row.id === 12).look_tags, ['brunette']);
  assert.deepEqual((await request('GET', '/workspaces/12')).body.model.look_tags, ['brunette']);
  assert.equal((await request('GET', '/creators')).body.find(row => row.account_handle === 'creator').look.some(row => row.tag === 'soft-glam'), false);
  assert.equal((await pool.query('SELECT look_tags FROM models WHERE id = 12')).rows[0].look_tags, '["soft-glam","brunette"]', 'stored historical tags may remain while reads ignore deleted vocabulary');
});

test('look backfill estimate counts only untagged cached sorted reels and reports cost', async () => {
  for (const [id, status, cache, tags, deleted, archived] of [
    [201, 'auto', 'cached', null, 0, 0], [202, 'manual', 'cached', null, 0, 0], [203, 'needs_look', 'cached', null, 0, 0],
    [204, 'unsorted', 'cached', null, 0, 0], [205, 'auto', 'cached', '[]', 0, 0], [206, 'auto', 'failed', null, 0, 0],
    [207, 'auto', 'cached', null, 1, 0], [208, 'auto', 'cached', null, 0, 1],
  ]) await pool.query(`INSERT INTO posts (id, shortcode, account_handle, sort_status, video_cache_status, ai_look_tags, soft_deleted, archived)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [id, `estimate-${id}`, 'estimate-only', status, cache, tags, deleted, archived]);
  const estimate = await request('GET', '/sort/look-backfill/estimate');
  assert.equal(estimate.status, 200);
  assert.equal(estimate.body.count, 3);
  assert.ok(Math.abs(estimate.body.estUsd - 3 * (3400 / 1e6 * 0.30 + 100 / 1e6 * 2.50)) < 1e-12);
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM look_backfill_attempts')).rows[0].n, 0, 'estimating never starts a background call');
});
