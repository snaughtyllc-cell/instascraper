const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

Object.assign(process.env, {
  NODE_ENV: 'test', DATABASE_URL: '', SQLITE_PATH: ':memory:', PERF_MIN_REELS: '5',
  APIFY_DISABLE_REEL_FALLBACK: '1', GEMINI_API_KEY: '', SENTRY_DSN: '',
});
const pool = require('./db');
let items = [];
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent?.filename === require.resolve('./scraper')) {
    if (request === 'node-fetch') return async () => ({ json: async () => items });
    if (request === './thumbnails') return { sweepThumbnails: async () => {} };
  }
  return originalLoad.apply(this, arguments);
};
let InstagramScraper;
try {
  InstagramScraper = require('./scraper');
} finally {
  Module._load = originalLoad;
}
const videos = require('./videos');
const sortRunner = require('./sort-runner');

before(async () => {
  await pool.initDB();
  const query = pool.query.bind(pool);
  pool.query = (sql, params = []) => {
    assert.deepEqual([...sql.matchAll(/\$(\d+)/g)].map(match => Number(match[1])),
      params.map((_, i) => i + 1), 'ascending, single-use SQLite placeholders');
    return query(sql, params);
  };
});

beforeEach(async (t) => {
  items = [];
  t.mock.method(videos, 'sweepVideos', async () => {});
  t.mock.method(sortRunner, 'runAutoSort', async () => {});
  for (const table of ['posts', 'tracked_accounts', 'scrape_jobs']) {
    await pool.query(`DELETE FROM ${table}`);
  }
});

async function seedCreator(handle, count = 5) {
  for (let i = 0; i < count; i++) {
    await pool.query('INSERT INTO posts (shortcode, account_handle, view_count) VALUES ($1,$2,$3)',
      [`${handle}-${i}`, handle, 100]);
  }
}

function reel(handle, shortcode, views) {
  return { ownerUsername: handle, shortCode: shortcode, videoPlayCount: views,
    type: 'Video', videoUrl: 'https://example.test/reel.mp4' };
}

async function scrape() {
  const result = await pool.query("INSERT INTO scrape_jobs (query, query_type, status) VALUES ('#test','hashtag','running') RETURNING id");
  const jobId = result.rows[0].id;
  await new InstagramScraper('fake-key')._fetchAndStoreResults('fake-run', jobId, { query: '#test' });
  return (await pool.query('SELECT status, posts_found FROM scrape_jobs WHERE id = $1', [jobId])).rows[0];
}

function importer() {
  const scraper = new InstagramScraper('fake-key');
  scraper._startApifyRun = async () => ({ id: 'fake-run' });
  scraper._waitForRun = async () => items;
  return scraper;
}

test('scrape refreshes every saved creator using persisted handles on upsert', async () => {
  await seedCreator('Mixed.Owner');
  await seedCreator('other');
  await seedCreator('untouched');
  items = [reel('mixed.owner', 'Mixed.Owner-0', 400), reel('other', 'other-0', 25),
    reel('other', 'other-1', 100)];

  assert.deepEqual(await scrape(), { status: 'completed', posts_found: 3 });
  const rows = (await pool.query('SELECT shortcode, account_handle, perf_score FROM posts ORDER BY id')).rows;
  assert.deepEqual(rows.slice(0, 5).map(row => row.perf_score), [2, 0, 0, 0, 0]);
  assert.equal(rows[0].account_handle, 'Mixed.Owner');
  assert.deepEqual(rows.slice(5, 10).map(row => row.perf_score), [-2, 0, 0, 0, 0]);
  assert.ok(rows.slice(10).every(row => row.perf_score === null));
});

test('URL imports refresh existing and new reels when a creator reaches the minimum', async () => {
  await seedCreator('first', 4);
  await seedCreator('second', 4);
  items = [reel('first', 'new-first', 400), reel('second', 'new-second', 25),
    reel('first', 'first-0', 999)];
  assert.deepEqual(await importer().importByUrls(['https://example.test/one', 'https://example.test/two']),
    { imported: 2, total: 2, scraped: 3 });
  const rows = (await pool.query('SELECT shortcode, view_count, perf_score FROM posts ORDER BY id')).rows;
  assert.ok(rows.slice(0, 8).every(row => row.perf_score === 0));
  assert.equal(rows[0].view_count, 100, 'duplicate imports keep existing views');
  assert.deepEqual(rows.slice(8).map(row => row.perf_score), [2, -2]);
});

for (const path of ['scrape', 'import']) {
  test(`performance refresh errors are logged and cannot fail ${path}`, async (t) => {
    const errors = [];
    t.mock.method(console, 'error', (...args) => errors.push(args));
    const query = pool.query.bind(pool);
    t.mock.method(pool, 'query', (sql, params) => {
      if (/SELECT id, view_count, perf_score FROM posts/.test(sql)) throw new Error('score refresh unavailable');
      return query(sql, params);
    });
    items = [reel('creator', 'new', 100)];
    if (path === 'scrape') {
      assert.deepEqual(await scrape(), { status: 'completed', posts_found: 1 });
    } else {
      assert.deepEqual(await importer().importByUrls(['https://example.test/reel']),
        { imported: 1, total: 1, scraped: 1 });
    }
    assert.ok(errors.some(args => args[0].startsWith('[PerfScore]') && args[1] === 'score refresh unavailable'));
    assert.equal((await query('SELECT COUNT(*) AS n FROM posts')).rows[0].n, 1);
  });
}
