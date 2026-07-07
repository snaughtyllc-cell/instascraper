const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { sweepVideos } = require('./videos');

// Fixed "now" so cutoffs and video_cached_at are deterministic across tests.
const NOW = Date.parse('2026-07-07T00:00:00.000Z');
const DAY = 86400000;

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE posts (
    id INTEGER PRIMARY KEY,
    shortcode TEXT,
    video_url TEXT,
    video_cache_status TEXT,
    video_cache_error TEXT,
    video_cached_at TEXT,
    video_url_refreshed_at TEXT,
    posted_at TEXT,
    scraped_at TEXT
  )`);
  // Adapter matching the `db.query(sql, params)` shape used in db.js (see content-types-seed.test.js)
  const query = async (sql, params = []) => {
    const norm = sql.replace(/\$\d+/g, '?');
    if (/^\s*select/i.test(norm)) return { rows: sqlite.prepare(norm).all(...params) };
    sqlite.prepare(norm).run(...params);
    return { rows: [] };
  };
  return { sqlite, query };
}

function insertPost(sqlite, row) {
  sqlite.prepare(`INSERT INTO posts
    (id, shortcode, video_url, video_cache_status, video_cache_error, video_cached_at, video_url_refreshed_at, posted_at, scraped_at)
    VALUES (@id, @shortcode, @video_url, @video_cache_status, @video_cache_error, @video_cached_at, @video_url_refreshed_at, @posted_at, @scraped_at)`
  ).run({
    video_cache_status: null,
    video_cache_error: null,
    video_cached_at: null,
    video_url_refreshed_at: null,
    posted_at: null,
    scraped_at: null,
    ...row,
  });
}

function isoDaysAgo(days) {
  return new Date(NOW - days * DAY).toISOString();
}

// scraped_at is a DB-default column: SQLite renders it space-formatted (no T/Z),
// which is the format sweepVideos' legacy-catch-up cutoff uses when DATABASE_URL
// is unset (the test environment). Seed scraped_at in that same format.
function spaceDaysAgo(days) {
  return new Date(NOW - days * DAY).toISOString().slice(0, 19).replace('T', ' ');
}

test('sweepVideos: a pending in-retention row is downloaded and marked cached with video_cached_at set', async () => {
  const { sqlite, query } = makeDb();
  insertPost(sqlite, { id: 1, shortcode: 'a', video_url: 'http://x/1.mp4', video_cache_status: 'pending', posted_at: isoDaysAgo(5) });

  const res = await sweepVideos({}, {
    db: { query },
    download: async () => ({ status: 'cached' }),
    delay: () => Promise.resolve(),
    now: () => NOW,
  });

  assert.equal(res.attempted, 1);
  assert.equal(res.cached, 1);
  const row = sqlite.prepare(`SELECT * FROM posts WHERE id = 1`).get();
  assert.equal(row.video_cache_status, 'cached');
  assert.equal(row.video_cached_at, new Date(NOW).toISOString());
});

test('sweepVideos: an already-cached row is not reselected', async () => {
  const { sqlite, query } = makeDb();
  insertPost(sqlite, { id: 2, shortcode: 'b', video_url: 'http://x/2.mp4', video_cache_status: 'cached', posted_at: isoDaysAgo(5) });

  const seen = [];
  const res = await sweepVideos({}, {
    db: { query },
    download: async (p) => { seen.push(p.shortcode); return { status: 'cached' }; },
    delay: () => Promise.resolve(),
    now: () => NOW,
  });

  assert.equal(res.attempted, 0);
  assert.deepStrictEqual(seen, []);
});

test('sweepVideos: a NULL-status row with a FRESH video_url_refreshed_at IS selected (legacy pre-column-backfill branch)', async () => {
  const { sqlite, query } = makeDb();
  // NULL status (row predates the video_cache_status column / scrape enqueue), but
  // video_url_refreshed_at is within freshnessDays (default 2) -> the refreshed-at
  // branch must still pick it up so pre-existing rows aren't stranded uncached.
  insertPost(sqlite, { id: 9, shortcode: 'legacy-fresh', video_url: 'http://x/9.mp4', video_cache_status: null, video_url_refreshed_at: isoDaysAgo(1), posted_at: isoDaysAgo(5) });

  const res = await sweepVideos({}, {
    db: { query },
    download: async () => ({ status: 'cached' }),
    delay: () => Promise.resolve(),
    now: () => NOW,
  });

  assert.equal(res.attempted, 1);
  assert.equal(res.cached, 1);
  const row = sqlite.prepare(`SELECT * FROM posts WHERE id = 9`).get();
  assert.equal(row.video_cache_status, 'cached');
});

test('sweepVideos: a NULL-status row with a stale/NULL video_url_refreshed_at is NOT selected', async () => {
  const { sqlite, query } = makeDb();
  // NULL status, video_url_refreshed_at older than freshnessDays (default 2) AND
  // scraped_at NULL (no legacy-catch-up either) -> excluded
  insertPost(sqlite, { id: 3, shortcode: 'stale', video_url: 'http://x/3.mp4', video_cache_status: null, video_url_refreshed_at: isoDaysAgo(20), posted_at: isoDaysAgo(5) });
  // NULL status, video_url_refreshed_at IS NULL -> excluded
  insertPost(sqlite, { id: 4, shortcode: 'nullrefresh', video_url: 'http://x/4.mp4', video_cache_status: null, video_url_refreshed_at: null, posted_at: isoDaysAgo(5) });

  const seen = [];
  const res = await sweepVideos({}, {
    db: { query },
    download: async (p) => { seen.push(p.shortcode); return { status: 'cached' }; },
    delay: () => Promise.resolve(),
    now: () => NOW,
  });

  assert.equal(res.attempted, 0);
  assert.deepStrictEqual(seen, []);
});

test('sweepVideos: legacy catch-up — a NULL/NULL row with a RECENT scraped_at IS selected (fills the cache for pre-Plan-3 posts)', async () => {
  const { sqlite, query } = makeDb();
  // The real-world "none of my videos play" case: a pre-Plan-3 post — never
  // enqueued (status NULL), video_url_refreshed_at NULL — but scraped recently,
  // so its IG video_url is likely still alive. The scraped_at legacy branch must
  // pick it up so the cache fills without re-scraping (no Apify cost).
  insertPost(sqlite, { id: 10, shortcode: 'legacy-scraped', video_url: 'http://x/10.mp4', video_cache_status: null, video_url_refreshed_at: null, posted_at: isoDaysAgo(5), scraped_at: spaceDaysAgo(1) });

  const res = await sweepVideos({}, {
    db: { query },
    download: async () => ({ status: 'cached' }),
    delay: () => Promise.resolve(),
    now: () => NOW,
  });

  assert.equal(res.attempted, 1);
  assert.equal(res.cached, 1);
  const row = sqlite.prepare(`SELECT * FROM posts WHERE id = 10`).get();
  assert.equal(row.video_cache_status, 'cached');
});

test('sweepVideos: legacy catch-up — a NULL/NULL row with an OLD scraped_at is NOT selected (URL almost certainly dead)', async () => {
  const { sqlite, query } = makeDb();
  // scraped 5 days ago, older than legacyDays (3) — its signed URL is stale, so
  // don't waste a download; it will re-cache when its account is next re-scraped.
  insertPost(sqlite, { id: 11, shortcode: 'legacy-old', video_url: 'http://x/11.mp4', video_cache_status: null, video_url_refreshed_at: null, posted_at: isoDaysAgo(5), scraped_at: spaceDaysAgo(5) });

  const seen = [];
  const res = await sweepVideos({}, {
    db: { query },
    download: async (p) => { seen.push(p.shortcode); return { status: 'cached' }; },
    delay: () => Promise.resolve(),
    now: () => NOW,
  });

  assert.equal(res.attempted, 0);
  assert.deepStrictEqual(seen, []);
});

test('sweepVideos: a pending row whose posted_at is older than maxAgeDays is NOT selected (retention gate)', async () => {
  const { sqlite, query } = makeDb();
  insertPost(sqlite, { id: 5, shortcode: 'old', video_url: 'http://x/5.mp4', video_cache_status: 'pending', posted_at: isoDaysAgo(40) });

  const seen = [];
  const res = await sweepVideos({}, {
    db: { query },
    download: async (p) => { seen.push(p.shortcode); return { status: 'cached' }; },
    delay: () => Promise.resolve(),
    now: () => NOW,
  });

  assert.equal(res.attempted, 0);
  assert.deepStrictEqual(seen, []);
});

test('sweepVideos: a pending row with posted_at IS NULL is NOT selected (never cache the unprunable)', async () => {
  const { sqlite, query } = makeDb();
  insertPost(sqlite, { id: 6, shortcode: 'nulldate', video_url: 'http://x/6.mp4', video_cache_status: 'pending', posted_at: null });

  const seen = [];
  const res = await sweepVideos({}, {
    db: { query },
    download: async (p) => { seen.push(p.shortcode); return { status: 'cached' }; },
    delay: () => Promise.resolve(),
    now: () => NOW,
  });

  assert.equal(res.attempted, 0);
  assert.deepStrictEqual(seen, []);
});

test('sweepVideos: stale-URL race — a URL changed mid-flight is not clobbered by the status write [CX-3]', async () => {
  const { sqlite, query } = makeDb();
  insertPost(sqlite, { id: 7, shortcode: 'race', video_url: 'http://x/old.mp4', video_cache_status: 'pending', posted_at: isoDaysAgo(5) });

  // Simulate a concurrent re-scrape: while this worker is "downloading" the URL it
  // selected, another process upserts a fresh video_url onto the same row.
  const download = async (post) => {
    sqlite.prepare(`UPDATE posts SET video_url = ? WHERE id = ?`).run('http://x/new.mp4', post.id);
    return { status: 'cached' };
  };

  const res = await sweepVideos({}, { db: { query }, download, delay: () => Promise.resolve(), now: () => NOW });

  assert.equal(res.attempted, 1);
  assert.equal(res.cached, 1); // tally reflects the download outcome regardless of the guarded write
  const row = sqlite.prepare(`SELECT * FROM posts WHERE id = 7`).get();
  assert.equal(row.video_cache_status, 'pending', 'status write did not apply — URL no longer matched');
  assert.equal(row.video_cached_at, null, 'video_cached_at was not stamped');
  assert.equal(row.video_url, 'http://x/new.mp4', 'the fresh URL from the concurrent re-scrape survives untouched');
});

test('sweepVideos: never throws when a download rejects, and logs a metric line', async () => {
  const { sqlite, query } = makeDb();
  insertPost(sqlite, { id: 8, shortcode: 'boom', video_url: 'http://x/8.mp4', video_cache_status: 'pending', posted_at: isoDaysAgo(5) });

  const logs = [];
  const orig = console.log; console.log = (...a) => logs.push(a.join(' '));
  let res;
  try {
    res = await sweepVideos({}, { db: { query }, download: async () => { throw new Error('boom'); }, delay: () => Promise.resolve(), now: () => NOW });
  } finally { console.log = orig; }

  assert.equal(res.errored, 1);
  const row = sqlite.prepare(`SELECT * FROM posts WHERE id = 8`).get();
  assert.equal(row.video_cache_status, 'error');
  assert.equal(row.video_cache_error, 'boom');
  assert.ok(logs.some(l => l.includes('[Metric] video_sweep')), 'emits a metric line');
});
