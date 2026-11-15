const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { appRequest } = require('./test-support/app-request');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sort-api-'));
process.env.SQLITE_PATH = path.join(dir, 'db.sqlite');
process.env.DATABASE_URL = '';
process.env.AUTH_PASSWORD = 'local-sort-test-password';
process.env.GEMINI_API_KEY = '';
process.env.APIFY_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
const pool = require('./db');
const sortRoutes = require('./sort-routes');
const originalRedecide = sortRoutes.redecideNeedsLook;
let redecideCalls = 0;
sortRoutes.redecideNeedsLook = async () => {
  redecideCalls += 1;
  return { redecided: 0, promoted: 0 };
};
const app = require('./index');
sortRoutes.redecideNeedsLook = originalRedecide;
let adminCookie, modelCookie;
async function request(method, url, body, cookie) {
  const response = await appRequest(app, { method, path: url, body, headers: cookie ? { Cookie: cookie } : {} });
  return { ...response, data: response.body };
}
before(async () => {
  await pool.initDB();
  await pool.query("INSERT INTO models (id,name,primary_niche,email,password_hash,login_enabled,status) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [1, 'Test model', 'dance', 'sort-test@example.test', bcrypt.hashSync('fake-model-password', 4), 1, 'active']);
  for (const [id, status, type] of [[1, 'auto', 'dance'], [2, 'unsorted', 'dance'], [3, 'needs_look', null], [4, 'manual', null], [5, 'auto', 'dance']]) {
    await pool.query('INSERT INTO posts (id,shortcode,account_handle,sort_status,content_type,video_cache_status,posted_at,soft_deleted) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, `reel${id}`, 'creator', status, type, 'cached', new Date().toISOString(), id === 5 ? 1 : 0]);
  }
  await pool.query("INSERT INTO creator_types (account_handle,content_type) VALUES ('creator','dance')");
  await pool.query('INSERT INTO model_saved_posts (model_id,post_id) VALUES (1,3)');
  await pool.query("INSERT INTO idea_cards (model_id,batch_id,concept,source_post_ids) VALUES (1,'test-batch','Idea','reel1,reel2,reel3')");
  const admin = await request('POST', '/login', { password: 'local-sort-test-password' });
  adminCookie = admin.headers['set-cookie'][0].split(';')[0];
  const model = await request('POST', '/login', { email: 'sort-test@example.test', password: 'fake-model-password' });
  modelCookie = model.headers['set-cookie'][0].split(';')[0];
});
after(async () => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('all sort endpoints are behind admin authorization', async () => {
  for (const cookie of [undefined, modelCookie]) {
    assert.equal((await request('GET', '/sort/needs-look', undefined, cookie)).status, 403);
    assert.equal((await request('GET', '/admin/sort-usage', undefined, cookie)).status, 403);
    assert.equal((await request('GET', '/sort/transcript-backfill/estimate', undefined, cookie)).status, 403);
    assert.equal((await request('POST', '/sort/transcript-backfill', undefined, cookie)).status, 403);
  }
});
test('actual feed and ideas exclude unsorted source reels; saves preserve history', async () => {
  const feed = await request('GET', '/me/feed', undefined, modelCookie);
  assert.equal(feed.status, 200);
  assert.deepEqual(feed.data.posts.map(p => p.id), [1]);
  const ideas = await request('GET', '/me/ideas', undefined, modelCookie);
  assert.equal(ideas.status, 200);
  assert.deepEqual(ideas.data.ideas[0].sourceReels.map(p => p.id), [1]);
  const saves = await request('GET', '/me/saves', undefined, modelCookie);
  assert.equal(saves.status, 200);
  assert.deepEqual(saves.data.posts.map(p => p.id), [3]);
});
test('export includes only decided non-deleted reels and supports CSV type filter', async () => {
  const json = await request('GET', '/export', undefined, adminCookie);
  assert.deepEqual(json.data.map(p => p.id), [1]);
  assert.match(json.headers['content-disposition'], /content-all\.json/);
  const csv = await request('GET', '/export?format=csv&contentType=dance', undefined, adminCookie);
  assert.equal(csv.status, 200);
  assert.match(csv.headers['content-disposition'], /content-dance\.csv/);
  assert.ok(csv.text.split('\n')[0].includes('"content_type"'));
  assert.ok(!csv.text.split('\n')[0].includes('"tag"'));
});
test('single human type changes mark manual, including null, and old tag route is gone', async () => {
  assert.equal((await request('POST', '/content/2/content-type', { contentType: 'talking' }, adminCookie)).status, 200);
  assert.deepEqual((await pool.query('SELECT sort_status,content_type FROM posts WHERE id=2')).rows[0], { sort_status: 'manual', content_type: 'talking' });
  assert.equal((await request('POST', '/content/2/content-type', { contentType: null }, adminCookie)).status, 200);
  assert.deepEqual((await pool.query('SELECT sort_status,content_type FROM posts WHERE id=2')).rows[0], { sort_status: 'manual', content_type: null });
  assert.equal((await request('POST', '/content/2/tag', { tag: 'recreate' }, adminCookie)).status, 404);
});
test('per-reel type changes do not redecide the pile; only a new type does', async () => {
  const before = redecideCalls;
  for (const contentType of ['talking', 'dance', null]) {
    const response = await request('POST', '/content/2/content-type', { contentType }, adminCookie);
    assert.equal(response.status, 200);
    assert.equal(redecideCalls, before);
  }
  // A positive control proves that the route's captured redecide spy is wired.
  const created = await request('POST', '/content-types', { label: 'Regression type' }, adminCookie);
  assert.equal(created.status, 201);
  assert.equal(redecideCalls, before + 1);
  const reused = await request('POST', '/content-types', { label: 'Regression type' }, adminCookie);
  assert.equal(reused.status, 200);
  assert.equal(redecideCalls, before + 1);
});
test('admin reel APIs expose the empty transcript sentinel as null', async () => {
  await pool.query("UPDATE posts SET ai_transcript='' WHERE id IN (1,3)");
  await pool.query('UPDATE posts SET ai_transcript=$1 WHERE id=$2', ['Hola.\nSin traducir.', 2]);
  try {
    const content = await request('GET', '/content', undefined, adminCookie);
    assert.equal(content.data.posts.find(post => post.id === 1).ai_transcript, null);
    assert.equal(content.data.posts.find(post => post.id === 2).ai_transcript, 'Hola.\nSin traducir.');
    const workspace = await request('GET', '/workspaces/1/reels', undefined, adminCookie);
    assert.equal(workspace.data.find(post => post.id === 1).ai_transcript, null);
    const pile = await request('GET', '/sort/needs-look', undefined, adminCookie);
    assert.equal(pile.data.posts.find(post => post.id === 3).ai_transcript, null);
    const exported = await request('GET', '/export', undefined, adminCookie);
    assert.equal(exported.data.find(post => post.id === 1).ai_transcript, null);
    assert.equal((await pool.query('SELECT ai_transcript FROM posts WHERE id=1')).rows[0].ai_transcript, '', 'sentinel stays in storage');
  } finally {
    await pool.query('UPDATE posts SET ai_transcript=NULL WHERE id IN (1,2,3)');
  }
});

test('start fresh can be undone with the existing delete-log restore endpoint', async () => {
  const fresh = await request('POST', '/sort/start-fresh', { confirm: true }, adminCookie);
  assert.deepEqual(fresh.data, { hidden: 4 });
  const deletionLog = await request('GET', '/delete-log?page=1&limit=2', undefined, adminCookie);
  assert.equal(deletionLog.status, 200);
  assert.equal(deletionLog.data.entries.length, 2);
  assert.equal(deletionLog.data.total, 4);
  assert.equal(deletionLog.data.totalPages, 2);
  assert.equal(deletionLog.data.stats.last_7_days, 4);
  assert.equal(deletionLog.data.stats.last_30_days, 4);
  const log = (await pool.query("SELECT id FROM deletion_log WHERE post_id=1 AND reason='manual:start_fresh'")).rows[0];
  assert.equal((await request('POST', `/delete-log/${log.id}/restore`, {}, adminCookie)).status, 200);
  assert.equal((await pool.query('SELECT soft_deleted FROM posts WHERE id=1')).rows[0].soft_deleted, 0);
});
test('delete-log stats include SQLite timestamps on the cutoff calendar day', async () => {
  const before = await request('GET', '/delete-log', undefined, adminCookie);
  const cutoffDay = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  await pool.query('INSERT INTO deletion_log (post_id,shortcode,account_handle,reason,deleted_at) VALUES ($1,$2,$3,$4,$5)',
    [1, 'reel1', 'creator', 'manual:test', `${cutoffDay} 23:59:59`]);
  const result = await request('GET', '/delete-log', undefined, adminCookie);
  assert.equal(Number(result.data.stats.last_7_days), Number(before.data.stats.last_7_days) + 1);
});
