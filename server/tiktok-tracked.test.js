const { test, before } = require('node:test');
const assert = require('node:assert/strict');

Object.assign(process.env, {
  NODE_ENV: 'test', DATABASE_URL: '', SQLITE_PATH: ':memory:',
  AUTH_PASSWORD: '', SESSION_SECRET: 'fake-tiktok-tracked-session',
  APIFY_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '',
  SCRAPE_MAX_PER_CYCLE: '1',
});
const pool = require('./db');
const InstagramScraper = require('./scraper');
const scheduler = require('./scheduler');
const app = require('./index');
const { appRequest } = require('./test-support/app-request');

function useSchedulerScraper(scraper) {
  const cron = require('node-cron');
  const schedule = cron.schedule;
  const timeout = global.setTimeout;
  // Register the test scraper without starting real cron jobs or boot sweeps.
  cron.schedule = () => {};
  global.setTimeout = () => {};
  try { scheduler.startScheduler(scraper); }
  finally { cron.schedule = schedule; global.setTimeout = timeout; }
}

before(async () => {
  await pool.initDB();
  await pool.query("INSERT INTO tracked_accounts (username, platform, status) VALUES ('tik.creator', 'tiktok', 'active'), ('ig.creator', NULL, 'paused')");
});

test('scheduler dispatches tracked TikTok accounts and legacy Instagram accounts to their actors', async () => {
  const calls = [];
  useSchedulerScraper({ startScrapeJob: async filters => { calls.push(filters); } });
  await scheduler.runAutoScrape();
  await pool.query("UPDATE tracked_accounts SET status = CASE WHEN username = 'ig.creator' THEN 'active' ELSE 'paused' END");
  await scheduler.runAutoScrape();
  assert.deepEqual(calls.map(({ query, queryType }) => ({ query, queryType })), [
    { query: 'tik.creator', queryType: 'tiktok_username' },
    { query: 'ig.creator', queryType: 'username' },
  ]);
  assert.equal(scheduler.getSchedulerStatus().autoScrape.status, 'idle');
});

test('single and bulk manual tracked scrapes preserve the tracked platform', async t => {
  const calls = [];
  const start = InstagramScraper.prototype.startScrapeJob;
  InstagramScraper.prototype.startScrapeJob = async filters => { calls.push(filters); return { jobId: calls.length }; };
  t.after(() => { InstagramScraper.prototype.startScrapeJob = start; });
  const single = await appRequest(app, { method: 'POST', path: '/tracked/TIK.CREATOR/scrape' });
  assert.equal(single.status, 200);
  const bulk = await appRequest(app, { method: 'POST', path: '/tracked/scrape-bulk', body: { usernames: ['tik.creator', 'ig.creator'] } });
  assert.equal(bulk.status, 200);
  assert.equal(bulk.body.started, 2);
  assert.deepEqual(calls.map(call => call.queryType), ['tiktok_username', 'tiktok_username', 'username']);
});

test('global Instagram suggestions ignore a same-name tracked TikTok creator', async () => {
  await pool.query("INSERT INTO models (id, name, primary_niche) VALUES (1, 'One', 'talking')");
  await pool.query("INSERT INTO suggested_accounts (username, source) VALUES ('tik.creator', 'instagram')");
  assert.deepEqual((await appRequest(app, { path: '/suggested' })).body, []);
  const single = await appRequest(app, { method: 'POST', path: '/suggested/tik.creator/approve', body: { modelIds: [1] } });
  assert.equal(single.status, 404);
  const bulk = await appRequest(app, { method: 'POST', path: '/suggested/approve-bulk', body: { modelIds: [1], usernames: ['tik.creator'] } });
  assert.equal(bulk.body.approved, 0);
});

test('discovery excludes paused TikTok candidates before enrichment while preserving paused Instagram discovery', async () => {
  await pool.query("UPDATE tracked_accounts SET status = CASE WHEN username = 'ig.creator' THEN 'active' ELSE 'paused' END");
  await pool.query("INSERT INTO tracked_accounts (username, platform, status) VALUES ('ig.paused', NULL, 'paused')");
  const sources = [], enriched = [], captured = [];
  useSchedulerScraper({
    apiKey: 'fake',
    discoverRelated: async username => {
      sources.push(username);
      return [{ username: 'tik.creator' }, { username: 'ig.paused' }];
    },
    enrichCandidates: async candidates => { enriched.push(...candidates.map(candidate => candidate.username)); },
    _classifyGenderBatch: async () => ({}),
    captureTopReels: async username => { captured.push(username); },
  });
  const timeout = global.setTimeout;
  global.setTimeout = callback => { queueMicrotask(callback); };
  try { await scheduler.runDiscovery(); }
  finally { global.setTimeout = timeout; }
  assert.deepEqual(sources, ['ig.creator']);
  assert.deepEqual(enriched, ['ig.paused']);
  assert.deepEqual(captured, ['ig.paused']);
  assert.equal(scheduler.getSchedulerStatus().discovery.status, 'idle');
});
