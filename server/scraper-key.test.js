const { test } = require('node:test');
const assert = require('node:assert/strict');

Object.assign(process.env, {
  NODE_ENV: 'test', DATABASE_URL: '', SQLITE_PATH: ':memory:',
  AUTH_PASSWORD: '', SESSION_SECRET: 'fake-scraper-key-session',
  APIFY_API_KEY: '', REACT_APIFY_API_KEY: 'fake-react-only-key',
  ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', SENTRY_DSN: '',
});
const InstagramScraper = require('./scraper');
const radar = require('./radar');
const app = require('./index');
const { appRequest } = require('./test-support/app-request');

test('React-only key leaves the ordinary scraper and radar without an Apify key', async () => {
  const scraper = new InstagramScraper(process.env.APIFY_API_KEY || '');
  assert.equal(scraper.apiKey, '');
  scraper._startApifyRun = async () => assert.fail('radar must not launch an Apify run');
  assert.deepEqual(await radar.runRadar(scraper), { started: false, reason: 'no_api_key' });
});

test('React-only key does not enable ordinary scrape or URL import routes', async () => {
  for (const [path, body] of [
    ['/scrape', { query: 'example', queryType: 'username' }],
    ['/scrape/import-urls', { urls: ['https://www.instagram.com/reel/Example123/'] }],
  ]) {
    const response = await appRequest(app, { method: 'POST', path, body });
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: 'APIFY_API_KEY not configured' });
  }
});
