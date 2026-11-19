const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { appRequest } = require('./test-support/app-request');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-soft-filter-'));
Object.assign(process.env, {
  NODE_ENV: 'test', DATABASE_URL: '', SQLITE_PATH: path.join(dir, 'db.sqlite'),
  AUTH_PASSWORD: 'fake-soft-filter-admin', SESSION_SECRET: 'fake-soft-filter-session-secret',
  INSTASCRAPER_API_KEY: '', GEMINI_API_KEY: '', APIFY_API_KEY: '', ANTHROPIC_API_KEY: '', NOTION_API_KEY: '', SENTRY_DSN: '',
});
const pool = require('./db');
const app = require('./index');
let adminCookie, modelCookie;
const request = (method, url, body, cookie = modelCookie) => appRequest(app, {
  method, path: url, body, headers: cookie ? { Cookie: cookie } : {},
});
const ids = response => response.body.posts.map(post => post.id);

before(async () => {
  await pool.initDB();
  await pool.query(`INSERT INTO models (id, name, primary_niche, secondary_niches, look_tags, email, password_hash, login_enabled)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
  [11, 'Logan', 'talking', 'dance', '["brunette"]', 'soft-filter@example.test', bcrypt.hashSync('fake-model-password', 4), 1]);
  await pool.query("INSERT INTO model_creators (model_id, username) VALUES (11, 'owned')");
  const now = Date.now();
  for (const [id, creator, type, status, tags] of [
    [1, 'owned', 'talking', 'auto', '[]'], [2, 'owned', 'skit', 'manual', '["brunette"]'],
    [3, 'owned', 'dance', 'manual', '[]'], [4, 'owned', 'skit', 'unsorted', '["brunette"]'],
    [5, 'owned', 'talking', 'needs_look', '["brunette"]'], [6, 'owned', null, 'auto', '["brunette"]'],
    [7, 'other', 'skit', 'auto', '[]'], [8, 'other', 'talking', 'auto', '[]'],
    [9, 'other', 'skit', 'unsorted', '[]'], [10, 'other', null, 'needs_look', '[]'],
    [11, 'owned', 'skit', 'manual', '["brunette"]'],
  ]) {
    await pool.query(`INSERT INTO posts (id, shortcode, account_handle, content_type, sort_status, ai_look_tags,
      video_cache_status, posted_at, audio_id, view_count) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [id, `soft-${id}`, creator, type, status, tags, 'cached', new Date(now - (20 - id) * 60000).toISOString(), id <= 8 ? 'sound' : null, id === 2 ? 9999 : id * 100]);
  }
  await pool.query("INSERT INTO model_taste (model_id, feature, affinity) VALUES (11, 'type:skit', 0.9)");
  await pool.query("INSERT INTO model_assigned_posts (model_id, post_id, status) VALUES (11, 9, 'assigned')");
  await pool.query('INSERT INTO model_saved_posts (model_id, post_id) VALUES (11, 10)');
  await pool.query("INSERT INTO model_post_feedback (model_id, post_id, feedback) VALUES (11, 11, 'not_my_style')");
  const admin = await request('POST', '/login', { password: 'fake-soft-filter-admin' }, null);
  adminCookie = admin.headers['set-cookie'][0].split(';')[0];
  const model = await request('POST', '/login', { email: 'soft-filter@example.test', password: 'fake-model-password' }, null);
  modelCookie = model.headers['set-cookie'][0].split(';')[0];
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('feed and workspace agree: niche first, then other sorted reels from allowed creators', async () => {
  const feed = await request('GET', '/me/feed');
  assert.equal(feed.status, 200);
  assert.deepEqual(ids(feed), [1, 3, 2], 'primary niche, then secondary niche, outrank stronger look and learned taste');
  const workspace = await request('GET', '/workspaces/11/reels', undefined, adminCookie);
  assert.equal(workspace.status, 200);
  assert.deepEqual(workspace.body.map(post => post.id), ids(feed));
  const shuffled = await request('GET', '/me/feed?refresh=1');
  assert.deepEqual(ids(shuffled).sort((a, b) => a - b), [1, 2, 3]);
});

test('the explicit niche selector still filters and rejects unconfigured selections', async () => {
  const response = await request('GET', '/me/feed?niche=dance');
  assert.equal(response.status, 200);
  assert.deepEqual(ids(response), [3]);
  assert.equal(response.body.activeNiche, 'dance');
  assert.equal((await request('GET', '/me/feed?niche=skit')).status, 403);
});

test('zero creators fallback shows all sorted creators with niche matches first', async () => {
  await pool.query('DELETE FROM model_creators WHERE model_id = 11');
  try {
    const feed = await request('GET', '/me/feed');
    assert.equal(feed.status, 200);
    assert.deepEqual(ids(feed), [8, 1, 3, 2, 7], 'look and taste still rank the non-niche group');
    assert.deepEqual(ids(await request('GET', '/me/feed?niche=talking')), [8, 1]);
  } finally {
    await pool.query("INSERT INTO model_creators (model_id, username) VALUES (11, 'owned')");
  }
});

test('model audio includes non-niche sorted reels while hiding unsorted and unowned ones', async () => {
  const reels = await request('GET', '/me/audio/sound/reels');
  assert.equal(reels.status, 200);
  assert.deepEqual(reels.body.reels.map(post => post.id), [3, 1, 2]);
  const trending = await request('GET', '/me/audio/trending');
  assert.equal(trending.status, 200);
  assert.equal(trending.body.audio[0].reel_count, 3);
  assert.deepEqual(trending.body.audio[0].exampleReels.map(post => post.id), [3, 1, 2]);
});

test('non-niche sorted reels can be saved, while historical saved and assigned reels remain', async () => {
  assert.equal((await request('POST', '/me/saves/2')).status, 200);
  assert.deepEqual([...ids(await request('GET', '/me/saves'))].sort((a, b) => a - b), [2, 10]);
  assert.deepEqual(ids(await request('GET', '/me/assignments')), [9]);
  assert.equal((await request('POST', '/me/saves/4')).status, 404);
  assert.equal((await request('POST', '/me/saves/5')).status, 404);
  assert.equal((await request('POST', '/me/saves/7')).status, 404);
  assert.deepEqual(ids(await request('GET', '/me/feed')), [1, 3]);
});
