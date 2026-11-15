const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { appRequest } = require('./test-support/app-request');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'content-types-api-'));
Object.assign(process.env, {
  NODE_ENV: 'test', NODE_USE_SYSTEM_CA: '0', DATABASE_URL: '', SQLITE_PATH: path.join(dir, 'db.sqlite'),
  AUTH_PASSWORD: 'fake-content-types-admin', SESSION_SECRET: 'fake-content-types-test-session-secret',
  INSTASCRAPER_API_KEY: '', GEMINI_API_KEY: '', APIFY_API_KEY: '', ANTHROPIC_API_KEY: '', NOTION_API_KEY: '', SENTRY_DSN: '',
});
const pool = require('./db');
const app = require('./index');
let adminCookie;
const request = (method, url, body, cookie = adminCookie) => appRequest(app, {
  method, path: url, body, headers: cookie ? { Cookie: cookie } : {},
});

before(async () => {
  await pool.initDB();
  const login = await request('POST', '/login', { password: 'fake-content-types-admin' }, null);
  assert.equal(login.status, 200);
  adminCookie = login.headers['set-cookie'][0].split(';')[0];
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('content-type description CRUD preserves stable values and supports partial updates', async () => {
  const created = await request('POST', '/content-types', { label: 'Tutorial', description: '  A step-by-step demonstration.  ' });
  assert.equal(created.status, 201);
  assert.equal(created.body.description, 'A step-by-step demonstration.');
  const { id } = created.body;
  const duplicate = await request('POST', '/content-types', { label: 'Tutorial', description: 'Do not overwrite' });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.description, created.body.description);

  const renamed = await request('PATCH', `/content-types/${id}`, { label: 'How to' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.value, 'tutorial');
  assert.equal(renamed.body.label, 'How to');
  assert.equal(renamed.body.description, created.body.description);
  const updated = await request('PATCH', `/content-types/${id}`, { description: '  Someone explains a process.  ' });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.label, 'How to');
  assert.equal(updated.body.description, 'Someone explains a process.');
  const listed = (await request('GET', '/content-types')).body.find(row => row.id === id);
  assert.deepEqual(listed, updated.body);

  assert.equal((await request('PATCH', `/content-types/${id}`, { description: '' })).body.description, '');
  assert.equal((await request('PATCH', `/content-types/${id}`, { description: null })).body.description, null);
  assert.equal((await request('DELETE', `/content-types/${id}`)).status, 200);
  assert.equal((await request('PATCH', `/content-types/${id}`, { description: 'Deleted' })).status, 404);
  assert.equal((await request('POST', '/content-types', { label: 'No definition' })).body.description, null);
});

test('content-type writes validate descriptions and patch fields before updating', async () => {
  const types = (await request('GET', '/content-types')).body;
  const talking = types.find(row => row.value === 'talking');
  assert.match(talking.description, /own words/);
  assert.match(types.find(row => row.value === 'lipsync').description, /pre-recorded/);
  for (const body of [{}, { label: '   ' }, { description: {} }, { description: [] }, { description: 9 }]) {
    assert.equal((await request('PATCH', `/content-types/${talking.id}`, body)).status, 400);
  }
  for (const description of [{}, [], 9, false]) {
    assert.equal((await request('POST', '/content-types', { label: 'Invalid', description })).status, 400);
  }
  for (const id of ['bad', '0', '-1', '1.5', '2147483648']) {
    assert.equal((await request('PATCH', `/content-types/${id}`, { label: 'Invalid' })).status, 400);
  }
  assert.deepEqual((await request('GET', '/content-types')).body.find(row => row.id === talking.id), talking);
});

test('content-type endpoints require admin authorization', async () => {
  for (const [method, url, body] of [
    ['GET', '/content-types'], ['POST', '/content-types', { label: 'Forbidden', description: 'Forbidden' }],
    ['PATCH', '/content-types/1', { description: 'Forbidden' }], ['DELETE', '/content-types/1'],
  ]) assert.equal((await request(method, url, body, null)).status, 403, `${method} ${url}`);
});
