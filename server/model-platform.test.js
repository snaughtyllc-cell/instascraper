const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { appRequest } = require('./test-support/app-request');

Object.assign(process.env, {
  NODE_ENV: 'test', DATABASE_URL: '', SQLITE_PATH: ':memory:',
  AUTH_PASSWORD: 'fake-platform-admin', SESSION_SECRET: 'fake-platform-session-secret',
  INSTASCRAPER_API_KEY: '', GEMINI_API_KEY: '', APIFY_API_KEY: '', ANTHROPIC_API_KEY: '', NOTION_API_KEY: '', SENTRY_DSN: '',
});
const pool = require('./db');
const app = require('./index');
let modelCookie;
const request = url => appRequest(app, { path: url, headers: { Cookie: modelCookie } });
const assertPlatforms = posts => {
  const byId = new Map(posts.map(post => [post.id, post]));
  for (const id of [1, 2]) {
    assert.equal(byId.get(id)?.platform, 'tiktok');
    assert.equal(byId.get(id)?.post_url, `https://www.tiktok.com/@tik.creator/video/${id}`);
  }
  for (const id of [3, 4]) {
    assert.equal(byId.get(id)?.platform, null, 'legacy Instagram platform stays null');
    assert.equal(byId.get(id)?.post_url, `https://www.instagram.com/reel/ig000${id}/`);
  }
};

before(async () => {
  await pool.initDB();
  await pool.query(`INSERT INTO models (id, name, primary_niche, email, password_hash, login_enabled)
    VALUES ($1, $2, $3, $4, $5, $6)`, [1, 'Platform Model', 'talking', 'platform@example.test', bcrypt.hashSync('fake-model-password', 4), 1]);
  for (const id of [1, 2, 3, 4]) {
    const tiktok = id <= 2;
    await pool.query(`INSERT INTO posts (id, shortcode, account_handle, platform, content_type, sort_status,
      video_cache_status, posted_at, post_url, audio_id, view_count)
      VALUES ($1, $2, $3, $4, 'talking', 'auto', 'cached', $5, $6, $7, $8)`,
    [id, tiktok ? `tt_1000${id}` : `ig000${id}`, tiktok ? 'tik.creator' : 'ig.creator', tiktok ? 'tiktok' : null,
      new Date().toISOString(), tiktok ? `https://www.tiktok.com/@tik.creator/video/${id}` : `https://www.instagram.com/reel/ig000${id}/`,
      tiktok ? 'tt_sound' : 'ig_sound', id * 100]);
  }
  await pool.query("INSERT INTO idea_cards (model_id, batch_id, concept, source_post_ids) VALUES (1, 'platform', 'Both sources', 'https://www.tiktok.com/@tik.creator/video/10001,https://www.tiktok.com/@tik.creator/video/10002,ig0003,ig0004')");
  const login = await appRequest(app, { method: 'POST', path: '/login', body: { email: 'platform@example.test', password: 'fake-model-password' } });
  assert.equal(login.status, 200);
  modelCookie = login.headers['set-cookie'][0].split(';')[0];
});

test('model feed, ideas and audio retain TikTok platform and legacy Instagram source URLs', async () => {
  const feed = await request('/me/feed');
  assert.equal(feed.status, 200);
  assertPlatforms(feed.body.posts);
  const ideas = await request('/me/ideas');
  assert.equal(ideas.status, 200);
  assertPlatforms(ideas.body.ideas[0].sourceReels);
  const trending = await request('/me/audio/trending');
  assert.equal(trending.status, 200);
  assertPlatforms(trending.body.audio.flatMap(audio => audio.exampleReels));
  const reels = [];
  for (const audioId of ['tt_sound', 'ig_sound']) {
    const response = await request(`/me/audio/${audioId}/reels`);
    assert.equal(response.status, 200);
    reels.push(...response.body.reels);
  }
  assertPlatforms(reels);
});

test('saved and assigned model posts retain each platform', async () => {
  await pool.query('INSERT INTO model_saved_posts (model_id, post_id) VALUES (1, 1), (1, 2), (1, 3), (1, 4)');
  await pool.query("INSERT INTO model_assigned_posts (model_id, post_id, status) VALUES (1, 1, 'assigned'), (1, 2, 'assigned'), (1, 3, 'assigned'), (1, 4, 'assigned')");
  for (const url of ['/me/saves', '/me/assignments']) {
    const response = await request(url);
    assert.equal(response.status, 200);
    assertPlatforms(response.body.posts);
  }
});

test('admin delete log and engagement links retain platform and source URLs', async () => {
  const login = await appRequest(app, { method: 'POST', path: '/login', body: { password: 'fake-platform-admin' } });
  assert.equal(login.status, 200);
  const headers = { Cookie: login.headers['set-cookie'][0].split(';')[0] };
  await pool.query(`INSERT INTO deletion_log (post_id, shortcode, account_handle)
    SELECT id, shortcode, account_handle FROM posts`);
  const log = await appRequest(app, { path: '/delete-log', headers });
  assert.equal(log.status, 200);
  assertPlatforms(log.body.entries.map(entry => ({ ...entry, id: entry.post_id })));
  for (const [handle, platform] of [['tik.creator', 'tiktok'], ['ig.creator', null]]) {
    const summary = await appRequest(app, { path: `/engagement/summary/${handle}`, headers });
    assert.equal(summary.status, 200);
    for (const post of [summary.body.best, summary.body.worst]) {
      assert.equal(post.platform, platform);
      assert.match(post.post_url, platform === 'tiktok' ? /^https:\/\/www\.tiktok\.com\// : /^https:\/\/www\.instagram\.com\//);
    }
  }
});
