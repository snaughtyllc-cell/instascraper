const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

Object.assign(process.env, {
  NODE_ENV: 'test', DATABASE_URL: '', SQLITE_PATH: ':memory:', GEMINI_API_KEY: '', SENTRY_DSN: '',
  APIFY_DISABLE_REEL_FALLBACK: '', PERF_MIN_REELS: '5',
});
const pool = require('./db');
let items = [];
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent?.filename === require.resolve('./scraper')) {
    if (request === 'node-fetch') return async () => ({ ok: true, json: async () => items });
    if (request === './thumbnails') return { sweepThumbnails: async () => {} };
  }
  return originalLoad.apply(this, arguments);
};
let InstagramScraper;
try { InstagramScraper = require('./scraper'); }
finally { Module._load = originalLoad; }
const { mapTikTokItem, calcER, TIKTOK_ACTOR_ID } = InstagramScraper;
const videos = require('./videos');
const sortRunner = require('./sort-runner');
const nowIso = '2026-11-16T10:00:00.000Z';

// Matches the fields verified in the plan's real clockworks actor dataset.
const fixture = {
  id: '7450000000000000000', text: 'Dance with me', createTimeISO: '2026-11-15T08:00:00.000Z',
  playCount: 100000, diggCount: 6000, commentCount: 200, shareCount: 100, collectCount: 50,
  webVideoUrl: 'https://www.tiktok.com/@pardisscarelllo/video/7450000000000000000',
  mediaUrls: ['https://api.apify.com/v2/key-value-stores/test/records/video.mp4'],
  videoMeta: { coverUrl: 'https://example.test/cover.jpg', duration: 12,
    downloadAddr: 'https://api.apify.com/v2/key-value-stores/test/records/fallback.mp4' },
  authorMeta: { name: 'PardissCarelllo', fans: 321000, privateAccount: false },
  musicMeta: { musicId: '12345', musicName: 'Dance sound', musicAuthor: 'Artist', musicOriginal: true },
  isSlideshow: false, isPinned: true, isAd: false,
};

before(async () => {
  await pool.initDB();
  const query = pool.query.bind(pool);
  pool.query = (sql, params = []) => {
    assert.deepEqual([...sql.matchAll(/\$(\d+)/g)].map(match => Number(match[1])),
      params.map((_, i) => i + 1), 'ascending, single-use SQLite placeholders');
    return query(sql, params);
  };
});

beforeEach(async t => {
  items = [];
  t.mock.method(videos, 'sweepVideos', async () => {});
  t.mock.method(sortRunner, 'runAutoSort', async () => {});
  for (const table of ['posts', 'tracked_accounts', 'scrape_jobs']) await pool.query(`DELETE FROM ${table}`);
});

test('mapTikTokItem maps every shared post field, namespaces IDs and lowercases handles', () => {
  const er = calcER(6000, 200, 100000);
  assert.deepEqual(mapTikTokItem(fixture, { query: 'pardisscarelllo', nowIso }), {
    _type: 'Video', _productType: '', platform: 'tiktok', shortcode: `tt_${fixture.id}`,
    videoUrl: fixture.mediaUrls[0], thumbnailUrl: fixture.videoMeta.coverUrl,
    caption: 'Dance with me', likeCount: 6000, commentCount: 200, viewCount: 100000,
    postedAt: fixture.createTimeISO, accountHandle: 'pardisscarelllo', postUrl: fixture.webVideoUrl,
    sourceQuery: 'pardisscarelllo', followersAtScrape: 321000, erPercent: er.er_percent, erLabel: er.er_label,
    audioId: 'tt_12345', audioTitle: 'Dance sound', audioAuthor: 'Artist', isOriginalAudio: 1,
    videoUrlRefreshedAt: nowIso,
  });
  const fallback = mapTikTokItem({ ...fixture, mediaUrls: [], authorMeta: {}, musicMeta: {}, playCount: undefined },
    { query: '@Creator', nowIso });
  assert.equal(fallback.videoUrl, fixture.videoMeta.downloadAddr);
  assert.equal(fallback.accountHandle, 'creator');
  assert.equal(fallback.audioId, null);
  assert.equal(fallback.viewCount, null);
});

test('mapTikTokItem skips slideshows, ads, private accounts, errors and incomplete video stubs', () => {
  for (const item of [null, {}, { id: fixture.id }, { ...fixture, isSlideshow: true },
    { ...fixture, isAd: true }, { ...fixture, authorMeta: { privateAccount: true } },
    { ...fixture, error: 'not_found' }, { ...fixture, id: undefined }]) {
    assert.equal(mapTikTokItem(item, { query: 'creator', nowIso }), null);
  }
});

test('TikTok input normalizes handles, @handles and full profile/video URLs', () => {
  const scraper = new InstagramScraper('fake-key');
  for (const query of ['Creator', '@Creator', 'https://www.tiktok.com/@Creator',
    'https://www.tiktok.com/@Creator/video/7450000000000000000?lang=en', 'tiktok.com/@Creator/']) {
    assert.deepEqual(scraper._buildInput(query, 'tiktok_username'), {
      actorId: TIKTOK_ACTOR_ID,
      input: { profiles: ['creator'], resultsPerPage: 50, shouldDownloadVideos: true,
        shouldDownloadCovers: false, profileScrapeSections: ['videos'] },
    });
  }
  assert.deepEqual(scraper._buildInput('@Creator', 'username'), {
    actorId: InstagramScraper.REEL_ACTOR_ID, input: { username: ['Creator'], resultsLimit: 50 },
  });
});

test('TikTok launches use the shared Apify entry point and propagate type to polling', async t => {
  const scraper = new InstagramScraper('fake-key');
  let launched, polled;
  t.mock.method(scraper, '_startApifyRun', async (...args) => { launched = args; return { id: 'tt-run' }; });
  t.mock.method(scraper, '_pollAndStore', async (...args) => { polled = args; });
  const result = await scraper.startScrapeJob({ query: 'https://www.tiktok.com/@Creator', queryType: 'tiktok_username' });
  assert.equal(launched[0], TIKTOK_ACTOR_ID);
  assert.equal(launched[2].purpose, 'scrape');
  assert.equal(launched[2].scrapeJobId, result.jobId);
  assert.equal(polled[2].queryType, 'tiktok_username');
  assert.equal(polled[2].query, 'creator');
  const job = (await pool.query('SELECT query, query_type FROM scrape_jobs WHERE id = $1', [result.jobId])).rows[0];
  assert.deepEqual(job, { query: 'creator', query_type: 'tiktok_username' });
});

async function scrape(t, data) {
  items = data;
  const scraper = new InstagramScraper('fake-key');
  t.mock.method(scraper, '_startApifyRun', async () => assert.fail('TikTok must never launch an Instagram fallback'));
  const job = await pool.query("INSERT INTO scrape_jobs (query, query_type, status) VALUES ('pardisscarelllo','tiktok_username','running') RETURNING id");
  const jobId = job.rows[0].id;
  await scraper._fetchAndStoreResults('tt-run', jobId, { query: 'pardisscarelllo', queryType: 'tiktok_username' });
  return (await pool.query('SELECT status, error, posts_found FROM scrape_jobs WHERE id = $1', [jobId])).rows[0];
}

test('empty/private/error TikTok results fail with zero rows and no Instagram fallback', async t => {
  await pool.query("INSERT INTO tracked_accounts (username, platform) VALUES ('pardisscarelllo','tiktok')");
  for (const data of [[], [{ authorMeta: { privateAccount: true } }], [{ id: fixture.id }],
    [{ error: 'not_found' }], [{ ...fixture, isSlideshow: true }], [{ ...fixture, isAd: true }]]) {
    assert.deepEqual(await scrape(t, data), { status: 'failed', error: 'TikTok account private or not found', posts_found: 0 });
    assert.equal((await pool.query('SELECT COUNT(*) AS n FROM posts')).rows[0].n, 0);
  }
  assert.equal((await pool.query('SELECT consecutive_failures FROM tracked_accounts')).rows[0].consecutive_failures, 6);
});

test('TikTok saves real videos, refreshes source URLs/performance and uses shared cache/sort sweeps', async t => {
  await pool.query("INSERT INTO tracked_accounts (username, platform, consecutive_failures) VALUES ('pardisscarelllo','tiktok',2)");
  const data = Array.from({ length: 5 }, (_, i) => ({ ...fixture, id: `${fixture.id.slice(0, -1)}${i}`,
    playCount: i ? 100 : 400 }));
  let swept = 0;
  t.mock.method(videos, 'sweepVideos', async () => { swept++; });
  assert.equal((await scrape(t, [null, ...data, { error: 'not_found' }, { ...fixture, isAd: true }])).posts_found, 5);
  const rows = (await pool.query('SELECT * FROM posts ORDER BY id')).rows;
  assert.equal(rows[0].shortcode, `tt_${fixture.id}`);
  assert.equal(rows[0].platform, 'tiktok');
  assert.equal(rows[0].post_url, fixture.webVideoUrl);
  assert.equal(rows[0].audio_id, 'tt_12345');
  assert.equal(rows[0].video_url, fixture.mediaUrls[0]);
  assert.equal(rows[0].tagged_users, null);
  assert.equal(rows[0].video_cache_status, 'pending');
  assert.match(rows[0].video_url_refreshed_at, /^\d{4}-.*Z$/);
  assert.deepEqual(rows.map(row => row.perf_score), [2, 0, 0, 0, 0]);
  assert.equal(swept, 1);
  const tracked = (await pool.query('SELECT followers, consecutive_failures FROM tracked_accounts')).rows[0];
  assert.deepEqual(tracked, { followers: 321000, consecutive_failures: 0 });
  const freshUrl = 'https://www.tiktok.com/@newhandle/video/7450000000000000000';
  assert.equal((await scrape(t, [{ ...fixture, webVideoUrl: freshUrl, authorMeta: { ...fixture.authorMeta, name: 'NewHandle' } }])).posts_found, 1);
  assert.deepEqual((await pool.query('SELECT post_url, account_handle FROM posts WHERE shortcode = $1', [`tt_${fixture.id}`])).rows[0],
    { post_url: freshUrl, account_handle: 'newhandle' });
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM posts')).rows[0].n, 5);
});

test('discovery skips TikTok tracked creators without launching an Instagram actor', async t => {
  await pool.query("INSERT INTO tracked_accounts (username, platform) VALUES ('creator','tiktok')");
  const scraper = new InstagramScraper('fake-key');
  t.mock.method(scraper, '_startApifyRun', async () => assert.fail('TikTok discovery is out of scope'));
  assert.deepEqual(await scraper.discoverRelated('Creator'), []);
});
