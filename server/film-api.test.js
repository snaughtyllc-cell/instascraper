const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { appRequest } = require('./test-support/app-request');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'film-api-'));
const projectId = '11111111-2222-3333-4444-555555555555';
const itemId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
Object.assign(process.env, {
  NODE_ENV: 'test', NODE_USE_SYSTEM_CA: '0', DATABASE_URL: '', SQLITE_PATH: path.join(dir, 'db.sqlite'),
  AUTH_PASSWORD: 'fake-film-admin-password', SESSION_SECRET: 'fake-film-test-session-secret',
  INSTASCRAPER_API_KEY: '', GEMINI_API_KEY: '', APIFY_API_KEY: '', ANTHROPIC_API_KEY: '', NOTION_API_KEY: '', SENTRY_DSN: '',
  FILM_SERVICE_KEY: 'fake-film-service-key', FILM_MEDIA_SECRET: 'fake-film-media-secret', PUBLIC_BASE_URL: '',
  HQ_PUBLIC_URL: 'https://hq.example.test', REACT_REF_DIR: path.join(dir, 'react-refs'),
});

// Keep real sendFile/Range behavior while isolating test media from the cache.
require('./thumbnails').DEFAULT_THUMB_DIR = path.join(dir, 'thumbnails');
require('./videos').DEFAULT_VIDEO_DIR = path.join(dir, 'videos');
const modelTaste = require('./model-taste');
const refreshTaste = modelTaste.refreshTaste;
let refreshed = [];
modelTaste.refreshTaste = async (db, modelId) => {
  refreshed.push(modelId);
  return refreshTaste(db, modelId);
};
const pool = require('./db');
const app = require('./index');
let modelCookie;
const filmPath = `/film/v1/models/${projectId}`;
const request = (method, url, body, headers = {}) => appRequest(app, {
  method, path: url, body, headers: { Authorization: 'Bearer fake-film-service-key', ...headers },
});
function signedPath(kind, id, exp = Math.floor(Date.now() / 1000) + 3600) {
  const sig = crypto.createHmac('sha256', process.env.FILM_MEDIA_SECRET).update(`${id}.${exp}`).digest('hex');
  return `/film/v1/${kind}/${id}?exp=${exp}&sig=${sig}`;
}
async function addPost(id, overrides = {}) {
  const post = {
    shortcode: `film-${id}`, account_handle: 'mine', content_type: 'talking', sort_status: 'auto',
    video_cache_status: 'cached', posted_at: '2026-11-10T18:22:00Z', ai_look_tags: '[]',
    caption: 'A reel', view_count: 120000, like_count: 9100, soft_deleted: 0, archived: 0,
    ...overrides,
  };
  const columns = ['id', ...Object.keys(post)];
  await pool.query(`INSERT INTO posts (${columns.join(',')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(',')})`, [id, ...Object.values(post)]);
}

before(async () => {
  await pool.initDB();
  const query = pool.query.bind(pool);
  pool.query = (sql, params = []) => {
    assert.deepEqual([...sql.matchAll(/\$(\d+)/g)].map(match => Number(match[1])), params.map((_, i) => i + 1), 'ascending, single-use SQLite placeholders');
    return query(sql, params);
  };
  fs.mkdirSync(path.join(dir, 'videos'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'thumbnails'), { recursive: true });
});

beforeEach(async () => {
  process.env.FILM_SERVICE_KEY = 'fake-film-service-key';
  process.env.FILM_MEDIA_SECRET = 'fake-film-media-secret';
  process.env.PUBLIC_BASE_URL = '';
  process.env.HQ_PUBLIC_URL = 'https://hq.example.test';
  fs.rmSync(process.env.REACT_REF_DIR, { recursive: true, force: true });
  refreshed = [];
  for (const table of ['film_react_analysis', 'film_react_refs', 'film_reel_items', 'model_taste', 'model_saved_posts', 'model_post_feedback', 'model_assigned_posts', 'model_creators', 'posts', 'models']) {
    await pool.query(`DELETE FROM ${table}`);
  }
  await pool.query(`INSERT INTO models (id,name,primary_niche,secondary_niches,look_tags,hq_project_id,email,password_hash,login_enabled)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
  [1, 'Logan', 'talking', 'dance', '["brunette","bedroom","deleted-tag"]', projectId, 'film-model@example.test', bcrypt.hashSync('fake-model-password', 4), 1]);
  await pool.query("INSERT INTO models (id,name,primary_niche) VALUES (2,'Other model','skit')");
  await pool.query("INSERT INTO model_creators (model_id,username) VALUES (1,'mine'),(1,'liked'),(2,'outside')");
  await addPost(101, { ai_look_tags: '["brunette","bedroom"]', caption: 'My caption', ai_transcript: 'My spoken words.\nMy next sentence.' });
  await addPost(102, { posted_at: '2026-11-14T18:22:00Z' });
  await addPost(103, { account_handle: 'liked', ai_look_tags: '["brunette","alt"]' });
  await addPost(104, { account_handle: 'outside' });
  await addPost(105, { content_type: 'skit' });
  await addPost(106, { sort_status: 'unsorted' });
  await addPost(107, { archived: 1 });
  await addPost(108, { soft_deleted: 1 });
  await addPost(109, { video_cache_status: 'pending' });
  await addPost(110, { content_type: 'dance', sort_status: 'manual' });
  await pool.query("INSERT INTO model_taste (model_id,feature,affinity) VALUES (1,'creator:liked',0.9),(1,'tag:alt',0.9)");
});

after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('Film routes fail closed for absent, wrong and unset service keys', async () => {
  for (const authorization of ['', 'Bearer wrong', 'Basic fake-film-service-key']) {
    const response = await request('GET', filmPath, undefined, { Authorization: authorization });
    assert.equal(response.status, 401);
    assert.deepEqual(Object.keys(response.body), ['error']);
  }
  assert.equal((await request('POST', `${filmPath}/reels/101/save`, '{', { Authorization: '' })).status, 401, 'authenticate before parsing the body');
  const unknown = await request('GET', '/film/v1/admin');
  assert.equal(unknown.status, 404);
  assert.deepEqual(unknown.body, { error: 'not_found' });
  process.env.FILM_SERVICE_KEY = '';
  assert.equal((await request('GET', filmPath)).status, 401);
});

test('Film service key cannot authorize admin or model-session endpoints', async () => {
  for (const url of ['/models', '/content', '/workspaces/1', '/me/feed']) {
    const response = await request('GET', url);
    assert.ok([401, 403].includes(response.status), `${url}: ${response.status}`);
  }
  assert.equal((await request('POST', '/models', { name: 'intruder', primary_niche: 'talking' })).status, 403);
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM models')).rows[0].n, 2);
});

test('all model endpoints return model_not_linked for an unknown or unlinked HQ ID', async () => {
  const base = '/film/v1/models/99999999-2222-3333-4444-555555555555';
  for (const [method, suffix, body] of [
    ['GET', ''], ['GET', '/feed'], ['GET', '/saves'], ['POST', '/reels/101/save', { saved: true }],
    ['POST', '/reels/101/skip', {}], ['POST', '/reels/101/filming', { hqItemId: itemId }],
  ]) {
    const response = await request(method, base + suffix, body);
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { error: 'model_not_linked' });
  }
  assert.deepEqual((await request('GET', '/film/v1/models/2')).body, { error: 'model_not_linked' });
});

test('deleted models lose Film access and HQ UUID lookup accepts canonical casing', async () => {
  const mixedCaseId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  await pool.query('UPDATE models SET hq_project_id = $1 WHERE id = $2', [mixedCaseId, 1]);
  assert.equal((await request('GET', `/film/v1/models/${mixedCaseId.toUpperCase()}`)).status, 200);
  await pool.query("UPDATE models SET status = 'inactive', login_enabled = 0 WHERE id = $1", [1]);
  for (const [method, suffix, body] of [
    ['GET', ''], ['GET', '/feed'], ['GET', '/saves'], ['POST', '/reels/101/save', { saved: true }],
    ['POST', '/reels/101/skip', {}], ['POST', '/reels/101/filming', { hqItemId: itemId }],
  ]) {
    const response = await request(method, `/film/v1/models/${mixedCaseId}${suffix}`, body);
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { error: 'model_not_linked' });
  }
});

test('linked model metadata uses labels and current look-tag vocabulary only', async () => {
  const response = await request('GET', filmPath);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    name: 'Logan', niches: [{ value: 'talking', label: 'Talking' }, { value: 'dance', label: 'Dance' }],
    lookTags: ['brunette', 'bedroom'], linked: true,
  });
  assert.equal(response.headers['set-cookie'], undefined, 'Film requests bypass sessions');
});

test('feed matches /me/feed ranking, paginates in order, and emits exactly the Reel contract', async () => {
  await pool.query('UPDATE posts SET ai_look_tags = $1, posted_at = $2 WHERE id = $3', ['["brunette","bedroom","alt"]', '2026-11-15T18:22:00Z', 105]);
  const login = await appRequest(app, { method: 'POST', path: '/login', body: { email: 'film-model@example.test', password: 'fake-model-password' } });
  assert.equal(login.status, 200);
  modelCookie = login.headers['set-cookie'][0].split(';')[0];
  const me = await appRequest(app, { path: '/me/feed', headers: { Cookie: modelCookie } });
  const start = Math.floor(Date.now() / 1000);
  const response = await request('GET', `${filmPath}/feed?limit=2`, undefined, { Host: 'film-source.example:4000', 'X-Forwarded-Proto': 'https' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.reels.map(row => row.id), [103, 101]);
  assert.equal(response.body.page, 1);
  assert.equal(response.body.hasMore, true);
  const second = await request('GET', `${filmPath}/feed?page=2&limit=2`);
  assert.deepEqual(second.body.reels.map(row => row.id), [102, 110]);
  assert.equal(second.body.hasMore, true);
  const third = await request('GET', `${filmPath}/feed?page=3&limit=2`);
  assert.deepEqual(third.body.reels.map(row => row.id), [105], 'nonpreferred type follows preferred niches despite its stronger look, taste, and recency');
  assert.equal(third.body.hasMore, false);
  const reels = [...response.body.reels, ...second.body.reels, ...third.body.reels];
  assert.deepEqual(reels.map(row => row.id), me.body.posts.map(row => row.id));
  assert.deepEqual(reels.map(row => row.nicheMatch), [true, true, true, true, false]);
  const reel = response.body.reels[1];
  assert.deepEqual(Object.keys(reel).sort(), ['id', 'type', 'typeLabel', 'lookTags', 'caption', 'transcript', 'creatorHandle', 'postedAt', 'viewCount', 'likeCount', 'nicheMatch', 'videoUrl', 'thumbUrl', 'instagramUrl', 'platform', 'sourceUrl', 'saved'].sort());
  assert.deepEqual({ ...reel, videoUrl: undefined, thumbUrl: undefined }, {
    id: 101, type: 'talking', typeLabel: 'Talking', lookTags: ['brunette', 'bedroom'], caption: 'My caption', transcript: 'My spoken words.\nMy next sentence.', creatorHandle: 'mine',
    postedAt: '2026-11-10T18:22:00Z', viewCount: 120000, likeCount: 9100, nicheMatch: true,
    videoUrl: undefined, thumbUrl: undefined, instagramUrl: 'https://www.instagram.com/reel/film-101/', platform: 'instagram',
    sourceUrl: 'https://www.instagram.com/reel/film-101/', saved: false,
  });
  for (const [kind, value] of [['media', reel.videoUrl], ['thumb', reel.thumbUrl]]) {
    const url = new URL(value);
    assert.equal(url.origin, 'https://film-source.example:4000');
    assert.equal(url.pathname, `/film/v1/${kind}/101`);
    const exp = Number(url.searchParams.get('exp'));
    assert.ok(exp >= start + 21600 && exp <= Math.floor(Date.now() / 1000) + 21600);
    assert.equal(url.pathname + url.search, signedPath(kind, 101, exp));
  }
  process.env.PUBLIC_BASE_URL = 'https://public.example/';
  assert.equal(new URL((await request('GET', `${filmPath}/feed`)).body.reels[0].videoUrl).origin, 'https://public.example');
});

test('TikTok Film reels use their source URL while Instagram keeps its legacy link', async () => {
  const postUrl = 'https://www.tiktok.com/@mine/video/7450000000000000000';
  await pool.query('UPDATE posts SET platform = $1, shortcode = $2, post_url = $3 WHERE id = $4',
    ['tiktok', 'tt_7450000000000000000', postUrl, 101]);
  await pool.query('UPDATE posts SET post_url = $1 WHERE id = $2', ['https://www.instagram.com/p/film-102/', 102]);
  for (const suffix of ['/feed', '/saves']) {
    if (suffix === '/saves') {
      for (const id of [101, 102]) await pool.query('INSERT INTO model_saved_posts (model_id,post_id) VALUES ($1,$2)', [1, id]);
    }
    const response = await request('GET', `${filmPath}${suffix}`);
    assert.equal(response.status, 200);
    const tiktok = response.body.reels.find(row => row.id === 101);
    assert.equal(tiktok.instagramUrl, postUrl);
    assert.equal(tiktok.sourceUrl, postUrl);
    assert.equal(tiktok.platform, 'tiktok');
    const instagram = response.body.reels.find(row => row.id === 102);
    assert.equal(instagram.instagramUrl, 'https://www.instagram.com/reel/film-102/');
    assert.equal(instagram.sourceUrl, 'https://www.instagram.com/p/film-102/');
    assert.equal(instagram.platform, 'instagram');
  }
});

test('TikTok references stay out of React mode and Instagram prefetch', async () => {
  const shortcode = 'tt_7450000000000000000';
  await pool.query('UPDATE posts SET platform = $1, shortcode = $2 WHERE id = $3', ['tiktok', shortcode, 101]);
  fs.writeFileSync(path.join(dir, 'videos', '101.mp4'), 'tiktok dance reference');
  const react = await request('POST', '/film/v1/react-reference', { shortcode });
  assert.equal(react.status, 404);
  const prefetch = await request('POST', '/film/v1/react-prefetch', { shortcodes: [shortcode, 'tt_7450000000000000001'] });
  assert.equal(prefetch.status, 202);
  assert.equal(prefetch.body.queued, 0);
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM film_react_refs')).rows[0].n, 0);
  const dance = await request('POST', '/film/v1/react-reference', { shortcode, mode: 'dance' });
  assert.equal(dance.status, 200);
  assert.equal(dance.body.analysis, null);
  const url = new URL(dance.body.originalVideoUrl);
  assert.equal((await request('GET', url.pathname + url.search)).text, 'tiktok dance reference');
});

test('Instagram tt_ shortcodes retain React reference access', async () => {
  for (const shortcode of ['tt_ABCDEFGH', 'tt_123456789']) {
    await pool.query('UPDATE posts SET shortcode = $1 WHERE id = $2', [shortcode, 101]);
    fs.writeFileSync(path.join(dir, 'videos', '101.mp4'), 'instagram reference');
    assert.equal((await request('POST', '/film/v1/react-reference', { shortcode })).status, 200);
  }
});

test('performance shares look and taste ranking across Film and /me/feed without changing the Reel contract', async (t) => {
  const previousWeight = process.env.FEED_PERF_WEIGHT;
  process.env.FEED_PERF_WEIGHT = '1';
  t.after(() => {
    if (previousWeight === undefined) delete process.env.FEED_PERF_WEIGHT;
    else process.env.FEED_PERF_WEIGHT = previousWeight;
  });
  for (const [id, score] of [[101, 1], [102, 2], [103, -1], [105, 2], [110, -2]]) {
    await pool.query('UPDATE posts SET perf_score = $1 WHERE id = $2', [score, id]);
  }
  await pool.query('UPDATE posts SET posted_at = $1 WHERE id = $2', ['2026-11-15T18:22:00Z', 103]);
  await pool.query('UPDATE posts SET ai_look_tags = $1, posted_at = $2 WHERE id = $3', ['["brunette","bedroom","alt"]', '2026-11-16T18:22:00Z', 105]);
  const login = await appRequest(app, { method: 'POST', path: '/login', body: { email: 'film-model@example.test', password: 'fake-model-password' } });
  assert.equal(login.status, 200);
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const me = await appRequest(app, { path: '/me/feed', headers: { Cookie: cookie } });
  const response = await request('GET', `${filmPath}/feed`);
  assert.equal(me.status, 200);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.reels.map(row => row.id), [101, 102, 103, 110, 105],
    'summed rank beats recency while preferred niches outrank the strongest nonpreferred reel');
  assert.deepEqual(response.body.reels.map(row => row.id), me.body.posts.map(row => row.id));
  assert.deepEqual(Object.keys(response.body).sort(), ['hasMore', 'page', 'reels']);
  const reelKeys = ['id', 'type', 'typeLabel', 'lookTags', 'caption', 'transcript', 'creatorHandle', 'postedAt', 'viewCount', 'likeCount', 'nicheMatch', 'videoUrl', 'thumbUrl', 'instagramUrl', 'platform', 'sourceUrl', 'saved'].sort();
  for (const reel of response.body.reels) assert.deepEqual(Object.keys(reel).sort(), reelKeys);
});

test('creator rounds match across model, workspace and paginated Film feeds with full post columns', async (t) => {
  const previousSpread = process.env.FEED_CREATOR_SPREAD;
  const previousWeight = process.env.FEED_PERF_WEIGHT;
  process.env.FEED_CREATOR_SPREAD = '2';
  process.env.FEED_PERF_WEIGHT = '1';
  t.after(() => {
    if (previousSpread === undefined) delete process.env.FEED_CREATOR_SPREAD;
    else process.env.FEED_CREATOR_SPREAD = previousSpread;
    if (previousWeight === undefined) delete process.env.FEED_PERF_WEIGHT;
    else process.env.FEED_PERF_WEIGHT = previousWeight;
  });
  await pool.query('DELETE FROM posts');
  await pool.query('DELETE FROM model_taste');
  await pool.query("INSERT INTO model_creators (model_id,username) VALUES (1,'third')");
  for (let index = 0; index < 10; index++) {
    await addPost(201 + index, {
      account_handle: index < 6 ? 'mine' : index < 8 ? 'liked' : 'third',
      perf_score: 20 - index, ai_transcript: `Transcript ${201 + index}`,
    });
  }
  const model = await appRequest(app, { method: 'POST', path: '/login', body: { email: 'film-model@example.test', password: 'fake-model-password' } });
  const admin = await appRequest(app, { method: 'POST', path: '/login', body: { password: 'fake-film-admin-password' } });
  assert.equal(model.status, 200);
  assert.equal(admin.status, 200);
  const me = await appRequest(app, { path: '/me/feed', headers: { Cookie: model.headers['set-cookie'][0].split(';')[0] } });
  const workspace = await appRequest(app, { path: '/workspaces/1/reels', headers: { Cookie: admin.headers['set-cookie'][0].split(';')[0] } });
  const first = await request('GET', `${filmPath}/feed?limit=5`);
  const second = await request('GET', `${filmPath}/feed?page=2&limit=5`);
  for (const response of [me, workspace, first, second]) assert.equal(response.status, 200);
  const expected = [201, 202, 207, 208, 209, 210, 203, 204, 205, 206];
  assert.deepEqual(me.body.posts.map(row => row.id), expected);
  assert.deepEqual(workspace.body.map(row => row.id), expected);
  assert.deepEqual(first.body.reels.map(row => row.id), expected.slice(0, 5));
  assert.deepEqual(second.body.reels.map(row => row.id), expected.slice(5));
  assert.equal(first.body.hasMore, true);
  assert.equal(second.body.hasMore, false);
  assert.equal(me.body.hasMore, false);
  const post = (await pool.query('SELECT * FROM posts WHERE id = $1', [201])).rows[0];
  assert.deepEqual(Object.keys(workspace.body[0]).sort(), [...Object.keys(post), 'niche', 'look_match'].sort());
  assert.equal(workspace.body[0].niche, 'talking');
  assert.equal(first.body.reels[0].transcript, post.ai_transcript);
  assert.equal(first.body.reels[0].creatorHandle, post.account_handle);
});

test('feed and saves return transcripts verbatim and expose missing or empty sentinels as null', async () => {
  const transcript = 'No traduzcas mis palabras.\nEsta es la próxima línea.';
  await pool.query('UPDATE posts SET ai_transcript = $1 WHERE id = $2', [transcript, 101]);
  await pool.query('UPDATE posts SET ai_transcript = $1 WHERE id = $2', ['', 102]);
  for (const suffix of ['/feed', '/saves']) {
    if (suffix === '/saves') {
      for (const id of [101, 102, 103]) await pool.query('INSERT INTO model_saved_posts (model_id,post_id,saved_at) VALUES ($1,$2,$3)', [1, id, '2026-11-15']);
    }
    const response = await request('GET', `${filmPath}${suffix}`);
    assert.equal(response.status, 200);
    const transcripts = new Map(response.body.reels.map(reel => [reel.id, reel.transcript]));
    assert.equal(transcripts.get(101), transcript);
    assert.equal(transcripts.get(102), null, 'empty-string sentinel is private storage state');
    assert.equal(transcripts.get(103), null, 'missing transcript is an explicit null');
  }
});

test('Film contract documents the additive transcript field and its limit', () => {
  const contract = fs.readFileSync(path.join(__dirname, '../docs/superpowers/specs/2026-11-15-film-api-contract.md'), 'utf8');
  assert.match(contract, /"transcript":/);
  assert.match(contract, /`transcript`.*`string \| null`.*4000 characters/);
  assert.match(contract, /original language/);
  assert.match(contract, /never contains song lyrics/);
});

test('feed hard niche filtering, shuffle, and zero-creator fallback preserve scope', async () => {
  const filtered = await request('GET', `${filmPath}/feed?niche=dance&shuffle=1`);
  assert.equal(filtered.status, 200);
  assert.deepEqual(filtered.body.reels.map(row => row.id), [110]);
  const talking = await request('GET', `${filmPath}/feed?niche=talking`);
  assert.deepEqual(talking.body.reels.map(row => row.id), [103, 101, 102]);
  const denied = await request('GET', `${filmPath}/feed?niche=skit`);
  assert.equal(denied.status, 403);
  const shuffled = await request('GET', `${filmPath}/feed?shuffle=1`);
  assert.deepEqual(shuffled.body.reels.map(row => row.id).sort(), [101, 102, 103, 105, 110]);
  assert.equal(shuffled.body.reels.find(row => row.id === 105).nicheMatch, false);
  await pool.query('DELETE FROM model_creators WHERE model_id = $1', [1]);
  assert.ok((await request('GET', `${filmPath}/feed`)).body.reels.some(row => row.id === 104));
});

test('model, workspace and Film feeds exempt React-mode types while saved reels remain available', async (t) => {
  const previous = process.env.FEED_REQUIRE_EASY_FILM;
  const previousExemptTypes = process.env.FEED_EASY_FILM_EXEMPT_TYPES;
  delete process.env.FEED_REQUIRE_EASY_FILM;
  delete process.env.FEED_EASY_FILM_EXEMPT_TYPES;
  t.after(() => {
    if (previous === undefined) delete process.env.FEED_REQUIRE_EASY_FILM;
    else process.env.FEED_REQUIRE_EASY_FILM = previous;
    if (previousExemptTypes === undefined) delete process.env.FEED_EASY_FILM_EXEMPT_TYPES;
    else process.env.FEED_EASY_FILM_EXEMPT_TYPES = previousExemptTypes;
  });
  for (const [id, layout] of [[102, 'self_filmed'], [103, 'split_screen'], [105, 'gameplay_overlay'], [110, 'needs_footage']]) {
    await pool.query('UPDATE posts SET ai_layout = $1 WHERE id = $2', [layout, id]);
  }
  for (const [id, overrides] of [
    [111, {}], [112, { account_handle: 'outside' }], [113, { archived: 1 }],
    [114, { video_cache_status: 'pending' }], [115, { soft_deleted: 1 }], [116, { sort_status: 'unsorted' }],
  ]) {
    await addPost(id, { content_type: 'omegle', ai_layout: 'split_screen', ...overrides });
  }
  const admin = await appRequest(app, { method: 'POST', path: '/login', body: { password: 'fake-film-admin-password' } });
  const model = await appRequest(app, { method: 'POST', path: '/login', body: { email: 'film-model@example.test', password: 'fake-model-password' } });
  assert.equal(admin.status, 200);
  assert.equal(model.status, 200);
  const adminHeaders = { Cookie: admin.headers['set-cookie'][0].split(';')[0] };
  const modelHeaders = { Cookie: model.headers['set-cookie'][0].split(';')[0] };
  const workspace = await appRequest(app, { path: '/workspaces/1/reels', headers: adminHeaders });
  const me = await appRequest(app, { path: '/me/feed', headers: modelHeaders });
  const film = await request('GET', `${filmPath}/feed`);
  for (const response of [workspace, me, film]) assert.equal(response.status, 200);
  for (const rows of [workspace.body, me.body.posts, film.body.reels]) {
    assert.deepEqual(rows.map(row => row.id).sort(), [101, 102, 111], 'NULL, self_filmed and split-screen Omegle stay visible without bypassing other filters');
  }
  const talking = await request('GET', `${filmPath}/feed?niche=talking`);
  assert.equal(talking.status, 200);
  assert.deepEqual(talking.body.reels.map(row => row.id).sort(), [101, 102], 'exempt types still respect the selected niche');
  for (const id of [103, 105, 110]) {
    const saved = await request('POST', `${filmPath}/reels/${id}/save`, { saved: true });
    assert.equal(saved.status, 200, 'layout does not restrict Film save availability');
    assert.deepEqual(saved.body, { saved: true });
  }
  const filmSaves = await request('GET', `${filmPath}/saves`);
  const meSaves = await appRequest(app, { path: '/me/saves', headers: modelHeaders });
  assert.equal(filmSaves.status, 200);
  assert.equal(meSaves.status, 200);
  for (const rows of [filmSaves.body.reels, meSaves.body.posts]) {
    assert.deepEqual(rows.map(row => row.id).sort(), [103, 105, 110], 'saved layouts needing footage remain visible');
  }
  for (const id of [103, 105, 110]) {
    assert.equal((await request('POST', `${filmPath}/reels/${id}/skip`, {})).status, 200, 'layout does not restrict Film skip availability');
  }
});

test('saves are newest first, paginated, model-specific and keep the saved scope exception', async () => {
  for (const [postId, savedAt] of [[101, '2026-11-10'], [105, '2026-11-12'], [104, '2026-11-11'], [106, '2026-11-15'], [109, '2026-11-09'], [107, '2026-11-16'], [108, '2026-11-16']]) {
    await pool.query('INSERT INTO model_saved_posts (model_id,post_id,saved_at) VALUES ($1,$2,$3)', [1, postId, savedAt]);
  }
  await pool.query("INSERT INTO model_saved_posts (model_id,post_id,saved_at) VALUES (2,102,'2026-11-15')");
  const first = await request('GET', `${filmPath}/saves?limit=2`);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.reels.map(row => [row.id, row.saved, row.nicheMatch]), [[105, true, false], [104, true, true]]);
  assert.equal(first.body.hasMore, true);
  const second = await request('GET', `${filmPath}/saves?page=2&limit=2`);
  assert.deepEqual(second.body.reels.map(row => row.id), [101, 109]);
  assert.equal(second.body.hasMore, false);
});

test('save toggles reuse reactions and refresh learned taste', async () => {
  assert.deepEqual((await request('POST', `${filmPath}/reels/101/save`, { saved: true })).body, { saved: true });
  assert.deepEqual(refreshed, [1]);
  assert.equal((await pool.query('SELECT feedback FROM model_post_feedback WHERE model_id = $1 AND post_id = $2', [1, 101])).rows[0].feedback, 'want_to_make');
  assert.ok((await pool.query('SELECT affinity FROM model_taste WHERE model_id = $1 AND feature = $2', [1, 'tag:brunette'])).rows[0].affinity > 0);
  assert.ok(!(await request('GET', `${filmPath}/feed`)).body.reels.some(row => row.id === 101));
  assert.deepEqual((await request('POST', `${filmPath}/reels/101/save`, { saved: false })).body, { saved: false });
  assert.deepEqual(refreshed, [1, 1]);
  assert.deepEqual((await pool.query('SELECT * FROM model_saved_posts WHERE model_id = $1', [1])).rows, []);
  assert.deepEqual((await pool.query('SELECT * FROM model_taste WHERE model_id = $1', [1])).rows, []);
  assert.ok((await request('GET', `${filmPath}/feed`)).body.reels.some(row => row.id === 101));
});

test('skip hides only that reel and refreshes negative taste', async () => {
  const response = await request('POST', `${filmPath}/reels/101/skip`, {});
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { skipped: true });
  assert.deepEqual(refreshed, [1]);
  assert.equal((await pool.query('SELECT feedback FROM model_post_feedback WHERE model_id = $1 AND post_id = $2', [1, 101])).rows[0].feedback, 'not_my_style');
  assert.ok(!(await request('GET', `${filmPath}/feed`)).body.reels.some(row => row.id === 101));
  assert.ok((await pool.query('SELECT affinity FROM model_taste WHERE model_id = $1 AND feature = $2', [1, 'tag:brunette'])).rows[0].affinity < 0);
});

test('workspace reel reject and undo require admin auth', async () => {
  const login = await appRequest(app, { method: 'POST', path: '/login', body: { email: 'film-model@example.test', password: 'fake-model-password' } });
  assert.equal(login.status, 200);
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  for (const method of ['POST', 'DELETE']) {
    for (const headers of [{}, { Authorization: 'Bearer fake-film-service-key' }, { Cookie: cookie }]) {
      const response = await appRequest(app, { method, path: '/workspaces/1/reels/101/reject', headers });
      assert.equal(response.status, 403);
      assert.deepEqual(response.body, { error: 'Admin only' });
    }
  }
  assert.deepEqual((await pool.query('SELECT * FROM model_post_feedback')).rows, []);
  assert.deepEqual(refreshed, []);
});

test('admin workspace rejection and undo update all model feeds and learned taste only for that model', async () => {
  const admin = await appRequest(app, { method: 'POST', path: '/login', body: { password: 'fake-film-admin-password' } });
  const model = await appRequest(app, { method: 'POST', path: '/login', body: { email: 'film-model@example.test', password: 'fake-model-password' } });
  assert.equal(admin.status, 200);
  assert.equal(model.status, 200);
  const headers = { Cookie: admin.headers['set-cookie'][0].split(';')[0] };
  const modelHeaders = { Cookie: model.headers['set-cookie'][0].split(';')[0] };
  await pool.query("INSERT INTO model_creators (model_id,username) VALUES (2,'mine')");
  const containsReel = async expected => {
    const workspace = await appRequest(app, { path: '/workspaces/1/reels', headers });
    const me = await appRequest(app, { path: '/me/feed', headers: modelHeaders });
    const film = await request('GET', `${filmPath}/feed`);
    for (const response of [workspace, me, film]) assert.equal(response.status, 200);
    for (const rows of [workspace.body, me.body.posts, film.body.reels]) {
      assert.equal(rows.some(row => row.id === 101), expected);
    }
    const other = await appRequest(app, { path: '/workspaces/2/reels', headers });
    assert.equal(other.status, 200);
    assert.ok(other.body.some(row => row.id === 101), 'another model can still see the same reel');
    assert.deepEqual((await pool.query('SELECT * FROM model_taste WHERE model_id = $1', [2])).rows, []);
  };
  await containsReel(true);
  const rejected = await appRequest(app, { method: 'POST', path: '/workspaces/1/reels/101/reject', headers });
  assert.equal(rejected.status, 200);
  assert.deepEqual(refreshed, [1]);
  await containsReel(false);
  const negatives = await pool.query('SELECT feature, affinity, negatives FROM model_taste WHERE model_id = $1 ORDER BY feature', [1]);
  assert.deepEqual(negatives.rows.map(row => row.feature), ['creator:mine', 'tag:bedroom', 'tag:brunette', 'type:talking']);
  for (const row of negatives.rows) {
    assert.ok(row.affinity < 0);
    assert.equal(row.negatives, 1);
  }
  const undone = await appRequest(app, { method: 'DELETE', path: '/workspaces/1/reels/101/reject', headers });
  assert.equal(undone.status, 200);
  assert.deepEqual(refreshed, [1, 1]);
  await containsReel(true);
  assert.deepEqual((await pool.query('SELECT * FROM model_post_feedback WHERE model_id = $1', [1])).rows, []);
  assert.deepEqual((await pool.query('SELECT * FROM model_taste WHERE model_id = $1', [1])).rows, []);
});

test('filming stores want_to_make and the HQ link atomically, upserts retries and refreshes taste', async () => {
  const url = `${filmPath}/reels/101/filming`;
  const response = await request('POST', url, { hqItemId: itemId });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true });
  assert.deepEqual(refreshed, [1]);
  const feedback = (await pool.query('SELECT feedback FROM model_post_feedback WHERE model_id = $1 AND post_id = $2', [1, 101])).rows[0];
  assert.equal(feedback.feedback, 'want_to_make');
  const link = (await pool.query('SELECT * FROM film_reel_items WHERE model_id = $1 AND post_id = $2', [1, 101])).rows[0];
  assert.equal(link.hq_item_id, itemId);
  assert.ok(Number.isFinite(Date.parse(link.created_at)));
  assert.deepEqual((await pool.query('SELECT * FROM model_saved_posts WHERE model_id = $1', [1])).rows, []);
  assert.equal((await request('POST', url, { hqItemId: itemId })).status, 200);
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM film_reel_items')).rows[0].n, 1);
  const query = pool.query;
  pool.query = (sql, params) => {
    if (/INSERT INTO film_reel_items/.test(sql)) throw new Error('simulated link write failure');
    return query(sql, params);
  };
  try { assert.equal((await request('POST', `${filmPath}/reels/102/filming`, { hqItemId: itemId })).status, 500); }
  finally { pool.query = query; }
  assert.deepEqual((await pool.query('SELECT * FROM model_post_feedback WHERE post_id = $1', [102])).rows, []);
  assert.deepEqual(refreshed, [1, 1], 'no taste refresh after rolled-back filming');
});

test('save, skip and filming accept scoped sorted reels outside preferred niches', async () => {
  for (const [suffix, body] of [['save', { saved: true }], ['save', { saved: false }], ['skip', {}], ['filming', { hqItemId: itemId }]]) {
    const response = await request('POST', `${filmPath}/reels/105/${suffix}`, body);
    assert.equal(response.status, 200, suffix);
  }
});

test('save, skip and filming reject unsorted, hidden and out-of-scope reels', async () => {
  for (const [suffix, body] of [['save', { saved: true }], ['save', { saved: false }], ['skip', {}], ['filming', { hqItemId: itemId }]]) {
    for (const postId of [104, 106, 107, 108, 9999, '2147483648', '1e2']) {
      const response = await request('POST', `${filmPath}/reels/${postId}/${suffix}`, body);
      assert.equal(response.status, 404, `${suffix} ${postId}`);
      assert.deepEqual(response.body, { error: 'reel_not_available' });
    }
  }
  await pool.query("INSERT INTO model_assigned_posts (model_id,post_id,status) VALUES (1,106,'assigned')");
  assert.equal((await request('POST', `${filmPath}/reels/106/save`, { saved: true })).status, 404, 'unsorted remains unavailable despite an assignment');
  await pool.query("INSERT INTO model_assigned_posts (model_id,post_id,status) VALUES (1,104,'assigned')");
  assert.equal((await request('POST', `${filmPath}/reels/104/filming`, { hqItemId: itemId })).status, 200, 'sorted assignment grants access outside creator scope');
});

test('invalid reaction bodies and malformed JSON produce JSON errors without writes', async () => {
  for (const saved of [undefined, null, 'true', 1]) assert.equal((await request('POST', `${filmPath}/reels/101/save`, { saved })).status, 400);
  for (const hqItemId of [undefined, null, 'bad', {}]) assert.equal((await request('POST', `${filmPath}/reels/101/filming`, { hqItemId })).status, 400);
  const malformed = await request('POST', `${filmPath}/reels/101/save`, '{');
  assert.equal(malformed.status, 400);
  assert.equal(typeof malformed.body.error, 'string');
  assert.deepEqual(refreshed, []);
});

test('signed media rejects bad, expired, altered, duplicated or missing signatures without bearer fallback', async () => {
  const valid = signedPath('media', 101);
  const exp = Math.floor(Date.now() / 1000) + 3600;
  for (const url of [
    '/film/v1/media/101', `${valid}0`, signedPath('media', 101, Math.floor(Date.now() / 1000) - 1),
    signedPath('media', 101, Math.floor(Date.now() / 1000)), valid.replace('/101?', '/102?'),
    `${valid}&exp=${exp}`, `${valid}&sig=${'a'.repeat(64)}`, valid.replace(`exp=${exp}`, 'exp=999999999999999999999'),
    `/film/v1/thumb/101?exp=${exp}&sig=${'a'.repeat(64)}`,
  ]) {
    const response = await request('GET', url);
    assert.equal(response.status, 403, url);
    assert.equal(typeof response.body.error, 'string');
  }
  process.env.FILM_MEDIA_SECRET = '';
  assert.equal((await request('GET', valid)).status, 503);
  assert.equal((await request('GET', `${filmPath}/feed`)).status, 503);
});

test('good signed video serves 200, 206 Range and JSON 416 without a session or bearer', async () => {
  fs.writeFileSync(path.join(dir, 'videos', '101.mp4'), '0123456789');
  const url = signedPath('media', 101);
  const full = await appRequest(app, { path: url });
  assert.equal(full.status, 200);
  assert.equal(full.text, '0123456789');
  assert.equal(full.headers['content-type'], 'video/mp4');
  assert.equal(full.headers['accept-ranges'], 'bytes');
  const partial = await appRequest(app, { path: url, headers: { Range: 'bytes=2-5' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.text, '2345');
  assert.equal(partial.headers['content-range'], 'bytes 2-5/10');
  const beyond = await appRequest(app, { path: url, headers: { Range: 'bytes=100-200' } });
  assert.equal(beyond.status, 416);
  assert.equal(typeof beyond.body.error, 'string');
});

test('signed media stays cached and visible only, and rejects traversal', async () => {
  for (const id of [106, 107, 108, 109]) {
    fs.writeFileSync(path.join(dir, 'videos', `${id}.mp4`), 'private bytes');
    assert.equal((await request('GET', signedPath('media', id))).status, 404, `${id}`);
  }
  assert.equal((await request('GET', signedPath('media', 9999))).status, 404);
  const traversal = await request('GET', signedPath('media', '..%2F..%2Fpackage.json'));
  assert.ok([403, 404].includes(traversal.status));
});

test('thumb serves cached JPEG only, returns 404 when absent and cannot escape cache directory', async () => {
  const url = signedPath('thumb', 101);
  await pool.query('UPDATE posts SET thumbnail_url = $1 WHERE id = $2', ['https://invalid.example/never-download.jpg', 101]);
  assert.equal((await appRequest(app, { path: url })).status, 404);
  fs.writeFileSync(path.join(dir, 'thumbnails', 'film-101.jpg'), 'cached jpeg');
  const thumb = await appRequest(app, { path: url });
  assert.equal(thumb.status, 200);
  assert.equal(thumb.text, 'cached jpeg');
  assert.equal(thumb.headers['content-type'], 'image/jpeg');
  fs.writeFileSync(path.join(dir, 'outside.jpg'), 'outside cache');
  await pool.query('UPDATE posts SET shortcode = $1 WHERE id = $2', ['../outside', 101]);
  assert.equal((await appRequest(app, { path: url })).status, 404);
});

test('React routes authenticate before validating or parsing their bodies', async () => {
  for (const route of ['react-reference', 'react-prefetch', 'react-render']) {
    for (const authorization of ['', 'Bearer wrong', 'Basic fake-film-service-key']) {
      const response = await request('POST', `/film/v1/${route}`, '{', { Authorization: authorization });
      assert.equal(response.status, 401);
      assert.deepEqual(response.body, { error: 'unauthorized' });
    }
    const malformed = await request('POST', `/film/v1/${route}`, '{');
    assert.equal(malformed.status, 400);
    assert.deepEqual(malformed.body, { error: 'invalid_json' });
  }
});

test('react-reference validates shortcodes and returns 404 for recently failed fetches', async () => {
  for (const shortcode of [undefined, null, {}, 'abcd', 'x'.repeat(65), '../outside']) {
    const response = await request('POST', '/film/v1/react-reference', { shortcode });
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: 'invalid_shortcode' });
  }
  for (const shortcode of ['missing-reel', 'film-110']) {
    await pool.query("INSERT INTO film_react_refs (shortcode, state, updated_at) VALUES ($1, 'failed', $2)", [shortcode, new Date().toISOString()]);
    const response = await request('POST', '/film/v1/react-reference', { shortcode });
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { error: 'reel_not_available' });
  }
});

test('react-reference signs and pins cached media and survives pruning cache and status', async () => {
  const cache = path.join(dir, 'videos', '101.mp4');
  fs.writeFileSync(cache, 'reference bytes');
  process.env.PUBLIC_BASE_URL = 'https://media.example.test/';
  const response = await request('POST', '/film/v1/react-reference', { shortcode: 'film-101' });
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.body).sort(), ['analysis', 'durationSec', 'originalVideoUrl', 'videoUrl']);
  assert.equal(response.body.analysis, null);
  assert.equal(response.body.durationSec, null, 'unprobeable file has no invented duration');
  const url = new URL(response.body.videoUrl);
  assert.equal(url.origin, 'https://media.example.test');
  assert.equal(url.pathname, '/film/v1/react-media/film-101');
  const exp = url.searchParams.get('exp');
  assert.equal(url.searchParams.get('sig'), crypto.createHmac('sha256', process.env.FILM_MEDIA_SECRET)
    .update(`react-media.film-101.${exp}`).digest('hex'));
  const originalUrl = new URL(response.body.originalVideoUrl);
  assert.equal(originalUrl.origin, url.origin);
  assert.equal(originalUrl.pathname, url.pathname);
  assert.equal(originalUrl.searchParams.get('variant'), 'original');
  assert.equal(originalUrl.searchParams.get('exp'), exp);
  assert.equal(originalUrl.searchParams.get('sig'), crypto.createHmac('sha256', process.env.FILM_MEDIA_SECRET)
    .update(`react-media.film-101.original.${exp}`).digest('hex'));
  assert.equal(fs.readFileSync(path.join(process.env.REACT_REF_DIR, 'film-101.mp4'), 'utf8'), 'reference bytes');
  fs.writeFileSync(`${cache}.replacement`, 'new cache bytes');
  fs.renameSync(`${cache}.replacement`, cache);
  assert.equal((await appRequest(app, { path: url.pathname + url.search })).text, 'reference bytes', 'React media stays pinned');
  assert.equal((await appRequest(app, { path: originalUrl.pathname + originalUrl.search })).text, 'reference bytes', 'original media stays pinned');
  assert.equal((await appRequest(app, { path: signedPath('media', 101) })).text, 'new cache bytes', 'feed media prefers normal cache');
  fs.unlinkSync(cache);
  await pool.query('UPDATE posts SET video_cache_status = NULL WHERE id = $1', [101]);
  const media = await appRequest(app, { path: url.pathname + url.search, headers: { Range: 'bytes=0-8' } });
  assert.equal(media.status, 206);
  assert.equal(media.text, 'reference');
  assert.equal(media.headers['content-range'], 'bytes 0-8/15');
  const originalMedia = await appRequest(app, { path: originalUrl.pathname + originalUrl.search });
  assert.equal(originalMedia.status, 200);
  assert.equal(originalMedia.text, 'reference bytes', 'without analysis both URLs serve the original after cache pruning');
});

test('react-reference can explicitly authorize an existing reel outside Find visibility', async () => {
  fs.writeFileSync(path.join(dir, 'videos', '106.mp4'), 'unsorted reference');
  assert.equal((await appRequest(app, { path: signedPath('media', 106) })).status, 404);
  const reference = await request('POST', '/film/v1/react-reference', { shortcode: 'film-106' });
  assert.equal(reference.status, 200, 'shortcode lookup is not limited to the Find feed');
  const url = new URL(reference.body.videoUrl);
  assert.equal((await appRequest(app, { path: url.pathname + url.search })).text, 'unsorted reference');
  assert.ok(!(await request('GET', `${filmPath}/feed`)).body.reels.some(row => row.id === 106), 'feed scope remains unchanged');
});

test('react-reference downloads an uncached reel before pinning', async () => {
  const videos = require('./videos');
  const originalDownload = videos.downloadVideo;
  const cache = path.join(dir, 'videos', '109.mp4');
  fs.rmSync(cache, { force: true });
  let downloaded = 0;
  videos.downloadVideo = async post => {
    assert.equal(post.id, 109);
    downloaded++;
    fs.writeFileSync(cache, 'downloaded reference');
    return { status: 'cached', path: cache };
  };
  try {
    const response = await request('POST', '/film/v1/react-reference', { shortcode: 'film-109' });
    assert.equal(response.status, 200);
    assert.equal(downloaded, 1);
    assert.equal(fs.readFileSync(path.join(process.env.REACT_REF_DIR, 'film-109.mp4'), 'utf8'), 'downloaded reference');
  } finally { videos.downloadVideo = originalDownload; }
});

test('react-render validates before enqueue and returns accepted for duplicate job IDs', async () => {
  const express = require('express');
  const { registerFilmApi } = require('./film-api');
  const api = express();
  const jobs = new Map();
  const worker = { enqueue: async body => { if (!jobs.has(body.jobId)) jobs.set(body.jobId, body); } };
  assert.equal(registerFilmApi(api, { pool, reactWorker: worker }), worker);
  const renderRequest = body => appRequest(api, {
    method: 'POST', path: '/film/v1/react-render', body,
    headers: { Authorization: 'Bearer fake-film-service-key' },
  });
  const body = {
    jobId: itemId, reference: { kind: 'instagram', shortcode: 'film-101' },
    rawUrl: 'https://hq.example.test/raw.mp4',
    uploadUrl: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=fake',
    callbackUrl: 'https://hq.example.test/api/filming/react/callback',
    crop: { top: 0, height: 0.5 }, syncMs: 500, output: 'stitched', referenceAudio: true,
  };
  for (const invalid of [
    { ...body, jobId: 'bad' }, { ...body, rawUrl: 'https://outside.example/raw.mp4' },
    { ...body, uploadUrl: 'https://outside.example/upload' },
    { ...body, callbackUrl: 'http://hq.example.test/callback' },
    { ...body, reference: { kind: 'url', url: 'https://outside.example/ref.mp4' } },
  ]) {
    const response = await renderRequest(invalid);
    assert.equal(response.status, 400);
    assert.equal(typeof response.body.error, 'string');
    assert.equal(jobs.size, 0);
  }
  for (let i = 0; i < 2; i++) {
    const response = await renderRequest(body);
    assert.equal(response.status, 202);
    assert.deepEqual(response.body, { accepted: true });
  }
  assert.equal(jobs.size, 1);
  assert.deepEqual(jobs.get(itemId), body);
  worker.enqueue = async () => { throw new Error('https://secret-capability.example'); };
  const failure = await renderRequest(body);
  assert.equal(failure.status, 503);
  assert.deepEqual(failure.body, { error: 'render_unavailable' });
});
