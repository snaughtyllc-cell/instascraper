const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { appRequest } = require('./test-support/app-request');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-proposals-'));
Object.assign(process.env, {
  NODE_ENV: 'test', DATABASE_URL: '', SQLITE_PATH: path.join(dir, 'db.sqlite'),
  AUTH_PASSWORD: 'fake-proposals-admin', SESSION_SECRET: 'fake-proposals-session-secret',
  INSTASCRAPER_API_KEY: '', GEMINI_API_KEY: '', APIFY_API_KEY: '', ANTHROPIC_API_KEY: '', NOTION_API_KEY: '', SENTRY_DSN: '',
});
const pool = require('./db');
const proposals = require('./proposals');
const originalCompute = proposals.computeProposals;
const runs = [];
let computeFailure = null;
let computeBarrier = null;
proposals.computeProposals = (db, options) => {
  const promise = computeFailure ? Promise.reject(computeFailure)
    : computeBarrier || originalCompute(db, options);
  runs.push({ options, promise });
  return promise;
};
const app = require('./index');
proposals.computeProposals = originalCompute;
let adminCookie;
const request = (method, url, body, cookie = adminCookie) => appRequest(app, {
  method, path: url, body, headers: cookie ? { Cookie: cookie } : {},
});
async function finishRuns() {
  await new Promise(setImmediate);
  await Promise.all(runs.map(run => run.promise.catch(() => {})));
}
async function createModel(body = {}) {
  const response = await request('POST', '/models', { name: 'New model', primary_niche: 'talking', ...body });
  assert.equal(response.status, 200);
  await finishRuns();
  return response.body.id;
}
const proposedFor = async id => (await pool.query(
  'SELECT username FROM model_creator_proposals WHERE model_id = $1 ORDER BY username', [id]
)).rows.map(row => row.username);

before(async () => {
  await pool.initDB();
  await pool.query("INSERT INTO tracked_accounts (username) VALUES ('talker'), ('dancer'), ('skit-look')");
  await pool.query(`INSERT INTO posts (shortcode, account_handle, content_type, sort_status, ai_look_tags) VALUES
    ('proposal-talk', 'talker', 'talking', 'auto', '[]'),
    ('proposal-dance', 'dancer', 'dance', 'manual', '[]'),
    ('proposal-skit', 'skit-look', 'skit', 'auto', '["brunette"]')`);
  const login = await request('POST', '/login', { password: 'fake-proposals-admin' }, null);
  adminCookie = login.headers['set-cookie'][0].split(';')[0];
});
after(async () => {
  await finishRuns();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('create responds before starting a model-scoped proposal recompute', async () => {
  const beforeCount = runs.length;
  const response = await request('POST', '/models', { name: 'Created', primary_niche: 'dance' });
  assert.equal(response.status, 200);
  assert.equal(runs.length, beforeCount, 'compute starts after the response finishes');
  await finishRuns();
  assert.deepEqual(runs.slice(beforeCount).map(run => run.options), [{ modelId: response.body.id }]);
  assert.deepEqual(await proposedFor(response.body.id), ['dancer']);
});

test('primary and secondary niche edits each trigger proposal recompute', async () => {
  const id = await createModel();
  let beforeCount = runs.length;
  assert.equal((await request('PUT', `/models/${id}`, { name: 'Updated', primary_niche: 'dance' })).status, 200);
  assert.equal(runs.length, beforeCount);
  await finishRuns();
  assert.equal(runs.length, beforeCount + 1);
  assert.ok((await proposedFor(id)).includes('dancer'));
  beforeCount = runs.length;
  assert.equal((await request('PUT', `/models/${id}`, { name: 'Updated', primary_niche: 'dance', secondary_niches: 'skit' })).status, 200);
  await finishRuns();
  assert.equal(runs.length, beforeCount + 1);
  assert.ok((await proposedFor(id)).includes('skit-look'));
});

test('look tag edits trigger recompute and propose a creator outside her niches', async () => {
  const id = await createModel();
  const beforeCount = runs.length;
  assert.deepEqual(await proposedFor(id), ['talker']);
  const response = await request('PUT', `/models/${id}`, { name: 'Updated look', primary_niche: 'talking', look_tags: ['brunette'] });
  assert.equal(response.status, 200);
  await finishRuns();
  assert.equal(runs.length, beforeCount + 1);
  assert.deepEqual(await proposedFor(id), ['skit-look', 'talker']);
});

test('unrelated model edits and rejected create requests do not recompute', async () => {
  const id = await createModel({ look_tags: ['brunette'] });
  const beforeCount = runs.length;
  assert.equal((await request('PUT', `/models/${id}`, { name: 'Name only', primary_niche: 'talking' })).status, 200);
  assert.equal((await request('POST', '/models', { name: 'Invalid', primary_niche: 'unknown' })).status, 400);
  await finishRuns();
  assert.equal(runs.length, beforeCount);
});

test('a pending or failed background recompute does not change the create response', async t => {
  let release;
  computeBarrier = new Promise(resolve => { release = resolve; });
  const response = await request('POST', '/models', { name: 'Background', primary_niche: 'talking' });
  assert.equal(response.status, 200);
  await new Promise(setImmediate);
  release({ proposed: 0 });
  computeBarrier = null;
  await finishRuns();

  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args));
  computeFailure = new Error('test compute failure');
  try {
    assert.equal((await request('POST', '/models', { name: 'Failed compute', primary_niche: 'talking' })).status, 200);
    await finishRuns();
    assert.deepEqual(errors, [['[Proposals]', 'test compute failure']]);
  } finally { computeFailure = null; }
});

test('proposal refresh is admin-only and returns the number newly proposed', async () => {
  const id = await createModel();
  await pool.query('DELETE FROM model_creator_proposals WHERE model_id = $1', [id]);
  assert.equal((await request('POST', `/workspaces/${id}/proposals/refresh`, undefined, null)).status, 403);
  const response = await request('POST', `/workspaces/${id}/proposals/refresh`);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { proposed: 1 });
  assert.deepEqual(await proposedFor(id), ['talker']);
  assert.deepEqual((await request('POST', `/workspaces/${id}/proposals/refresh`)).body, { proposed: 0 });
});
