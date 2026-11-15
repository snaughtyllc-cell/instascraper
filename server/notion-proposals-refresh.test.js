const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { appRequest } = require('./test-support/app-request');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notion-proposals-'));
Object.assign(process.env, {
  NODE_ENV: 'test', DATABASE_URL: '', SQLITE_PATH: path.join(dir, 'db.sqlite'),
  AUTH_PASSWORD: 'fake-notion-proposals-admin', SESSION_SECRET: 'fake-notion-proposals-session',
  NOTION_API_KEY: 'fake-notion-token', NOTION_PERSONAS_DB_ID: 'fake-personas-db', ANTHROPIC_API_KEY: 'fake-claude-key',
  INSTASCRAPER_API_KEY: '', GEMINI_API_KEY: '', APIFY_API_KEY: '', SENTRY_DSN: '',
});
const pool = require('./db');
const notionSync = require('./notion-sync');
const notionCalls = [];
const originals = {};
const notionClient = { pages: { retrieve: async ({ page_id }) => ({
  id: page_id,
  properties: {
    'Model Name': { title: [{ plain_text: 'Notion model' }] },
    'Persona Status': { select: { name: 'Approved' } },
    Status: { select: { name: page_id === 'offboarded' ? 'Offboarded' : 'Active' } },
  },
}) } };
const claude = { messages: { create: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({
  proposedPrimary: 'dance', proposedSecondary: ['skit'], characterContext: 'Preview context', seedKeywords: [],
}) }] }) } };
for (const method of ['previewPersona', 'importPersona', 'resyncModel']) {
  originals[method] = notionSync[method];
  notionSync[method] = (deps, ...args) => {
    notionCalls.push({ method, args });
    return originals[method]({ ...deps, notionClient, claude }, ...args);
  };
}
const proposals = require('./proposals');
const originalCompute = proposals.computeProposals;
const runs = [];
proposals.computeProposals = (db, options) => {
  const promise = originalCompute(db, options);
  runs.push({ options, promise });
  return promise;
};
const app = require('./index');
proposals.computeProposals = originalCompute;
let adminCookie;
const request = (url, body) => appRequest(app, {
  method: 'POST', path: url, body, headers: adminCookie ? { Cookie: adminCookie } : {},
});
async function finishRuns() {
  await new Promise(setImmediate);
  await Promise.all(runs.map(run => run.promise));
}
async function linkedModel(pageId) {
  return (await pool.query(`INSERT INTO models (name, primary_niche, secondary_niches, notion_page_id)
    VALUES ($1, $2, $3, $4) RETURNING id`, ['Linked model', 'talking', '', pageId])).rows[0].id;
}
const proposedFor = async id => (await pool.query(
  'SELECT username FROM model_creator_proposals WHERE model_id = $1 ORDER BY username', [id]
)).rows.map(row => row.username);

before(async () => {
  await pool.initDB();
  await pool.query("INSERT INTO tracked_accounts (username) VALUES ('talker'), ('dancer'), ('skitter')");
  await pool.query(`INSERT INTO posts (shortcode, account_handle, content_type, sort_status) VALUES
    ('notion-talk', 'talker', 'talking', 'auto'), ('notion-dance', 'dancer', 'dance', 'manual'),
    ('notion-skit', 'skitter', 'skit', 'auto')`);
  const login = await request('/login', { password: 'fake-notion-proposals-admin' });
  assert.equal(login.status, 200);
  adminCookie = login.headers['set-cookie'][0].split(';')[0];
});
after(async () => {
  await finishRuns();
  Object.assign(notionSync, originals);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Notion import computes proposals for its model after the response', async () => {
  const otherId = await linkedModel('other');
  const beforeCount = runs.length;
  const response = await request('/notion/personas/imported/import', {
    primary_niche: 'dance', email: 'notion-model@example.test', password: 'fake-model-password', addRadarTerms: false,
  });
  assert.equal(response.status, 200);
  assert.equal(notionCalls.at(-1).method, 'importPersona');
  assert.equal(runs.length, beforeCount, 'compute starts after the import response finishes');
  await finishRuns();
  assert.deepEqual(runs.slice(beforeCount).map(run => run.options), [{ modelId: response.body.id }]);
  assert.deepEqual(await proposedFor(response.body.id), ['dancer']);
  assert.deepEqual(await proposedFor(otherId), []);
});

test('applying changed primary or secondary niches through Notion resync recomputes proposals', async () => {
  const id = await linkedModel('changed');
  for (const secondary of ['', 'skit']) {
    const beforeCount = runs.length;
    const response = await request(`/models/${id}/resync-notion`, {
      confirm: true, confirmed: { primary_niche: 'dance', secondary_niches: secondary },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { applied: true, offboarded: false });
    assert.equal(notionCalls.at(-1).method, 'resyncModel');
    assert.equal(runs.length, beforeCount, 'resync response finishes before compute starts');
    await finishRuns();
    assert.deepEqual(runs.slice(beforeCount).map(run => run.options), [{ modelId: id }]);
  }
  assert.deepEqual(await proposedFor(id), ['dancer', 'skitter']);
});

test('Notion preview, unchanged resync, and offboarding do not recompute proposals', async () => {
  const id = await linkedModel('unchanged');
  const offboardedId = await linkedModel('offboarded');
  const beforeCount = runs.length;
  const personaPreview = await request('/notion/personas/previewed/preview', {});
  assert.equal(personaPreview.status, 200);
  assert.equal(personaPreview.body.proposedPrimary, 'dance');
  const resyncPreview = await request(`/models/${id}/resync-notion`, {});
  assert.equal(resyncPreview.status, 200);
  assert.equal(resyncPreview.body.diff.proposed.primary_niche, 'dance');
  assert.equal((await request(`/models/${id}/resync-notion`, {
    confirm: true, confirmed: { primary_niche: 'talking', secondary_niches: '', character_context: 'Context only' },
  })).status, 200);
  const offboarded = await request(`/models/${offboardedId}/resync-notion`, {
    confirm: true, confirmed: { primary_niche: 'dance', secondary_niches: 'skit' },
  });
  assert.equal(offboarded.status, 200);
  assert.deepEqual(offboarded.body, { applied: true, offboarded: true });
  assert.equal((await pool.query('SELECT status FROM models WHERE id = $1', [offboardedId])).rows[0].status, 'inactive');
  await finishRuns();
  assert.equal(runs.length, beforeCount);
});
