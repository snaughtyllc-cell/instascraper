const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { appRequest } = require('./test-support/app-request');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-hq-link-'));
Object.assign(process.env, {
  NODE_ENV: 'test', NODE_USE_SYSTEM_CA: '0', DATABASE_URL: '', SQLITE_PATH: path.join(dir, 'db.sqlite'),
  AUTH_PASSWORD: 'fake-hq-link-admin', SESSION_SECRET: 'fake-hq-link-test-session-secret',
  INSTASCRAPER_API_KEY: '', FILM_SERVICE_KEY: 'fake-film-service-key',
  GEMINI_API_KEY: '', APIFY_API_KEY: '', ANTHROPIC_API_KEY: '', NOTION_API_KEY: '', SENTRY_DSN: '',
});
const pool = require('./db');
const app = require('./index');
let adminCookie;
const request = (method, url, body) => appRequest(app, {
  method, path: url, body, headers: adminCookie ? { Cookie: adminCookie } : {},
});
const firstHqId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const secondHqId = '11111111-2222-3333-4444-555555555555';

before(async () => {
  await pool.initDB();
  const login = await request('POST', '/login', { password: 'fake-hq-link-admin' });
  assert.equal(login.status, 200);
  adminCookie = login.headers['set-cookie'][0].split(';')[0];
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('models create, list, preserve, replace, and clear an HQ project link', async () => {
  const created = await request('POST', '/models', { name: 'Logan', primary_niche: 'talking', hq_project_id: ` ${firstHqId.toUpperCase()} ` });
  assert.equal(created.status, 200);
  const id = created.body.id;
  const listed = await request('GET', '/models');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.find(model => model.id === id).hq_project_id, firstHqId);
  assert.equal('password_hash' in listed.body.find(model => model.id === id), false);

  assert.equal((await request('PUT', `/models/${id}`, { name: 'Logan edited', primary_niche: 'talking' })).status, 200);
  assert.equal((await pool.query('SELECT hq_project_id FROM models WHERE id = $1', [id])).rows[0].hq_project_id, firstHqId);
  assert.equal((await request('PUT', `/models/${id}`, { name: 'Logan edited', primary_niche: 'talking', hq_project_id: secondHqId })).status, 200);
  assert.equal((await pool.query('SELECT hq_project_id FROM models WHERE id = $1', [id])).rows[0].hq_project_id, secondHqId);
  assert.equal((await request('PUT', `/models/${id}`, { name: 'Logan edited', primary_niche: 'talking', hq_project_id: null })).status, 200);
  assert.equal((await pool.query('SELECT hq_project_id FROM models WHERE id = $1', [id])).rows[0].hq_project_id, null);
});

test('models reject invalid and duplicate HQ project IDs with JSON errors', async () => {
  const first = await request('POST', '/models', { name: 'First', primary_niche: 'talking', hq_project_id: firstHqId });
  const second = await request('POST', '/models', { name: 'Second', primary_niche: 'talking', hq_project_id: null });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  for (const value of ['', 'not-a-uuid', 123, false, [], {}]) {
    for (const [method, url] of [['POST', '/models'], ['PUT', `/models/${second.body.id}`]]) {
      const invalid = await request(method, url, { name: 'Invalid', primary_niche: 'talking', hq_project_id: value });
      assert.equal(invalid.status, 400);
      assert.match(invalid.body.error, /UUID/);
    }
  }
  for (const [method, url] of [['POST', '/models'], ['PUT', `/models/${second.body.id}`]]) {
    const duplicate = await request(method, url, { name: 'Duplicate', primary_niche: 'talking', hq_project_id: firstHqId.toUpperCase() });
    assert.equal(duplicate.status, 409);
    assert.deepEqual(duplicate.body, { error: 'HQ project ID already linked' });
  }
  const unlinked = await request('POST', '/models', { name: 'Unlinked', primary_niche: 'talking' });
  assert.equal(unlinked.status, 200, 'multiple unlinked models are allowed');
});

test('Film service bearer cannot read or write admin model links', async () => {
  for (const [method, url, body] of [
    ['GET', '/models'],
    ['POST', '/models', { name: 'Forbidden', primary_niche: 'talking', hq_project_id: secondHqId }],
    ['PUT', '/models/1', { name: 'Forbidden', primary_niche: 'talking', hq_project_id: secondHqId }],
  ]) {
    const response = await appRequest(app, { method, path: url, body, headers: { Authorization: `Bearer ${process.env.FILM_SERVICE_KEY}` } });
    assert.equal(response.status, 403, `${method} ${url}`);
    assert.equal(typeof response.body.error, 'string');
  }
});
