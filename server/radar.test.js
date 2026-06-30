const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const radar = require('./radar');

// Mirror of the SQLite DDL initDB will create (asserts the shape is creatable & insertable).
function makeSchema(db) {
  db.exec(`CREATE TABLE watch_terms (
    id INTEGER PRIMARY KEY AUTOINCREMENT, term TEXT, kind TEXT, source TEXT,
    status TEXT DEFAULT 'active', model_id INTEGER DEFAULT NULL,
    added_at TEXT, last_run_at TEXT DEFAULT NULL, notes TEXT DEFAULT '',
    UNIQUE(term, kind))`);
  db.exec(`CREATE TABLE radar_reels (
    id INTEGER PRIMARY KEY AUTOINCREMENT, shortcode TEXT UNIQUE NOT NULL, account_handle TEXT,
    video_url TEXT, thumbnail_url TEXT, caption TEXT,
    like_count INTEGER, comment_count INTEGER, view_count INTEGER,
    posted_at TEXT, post_url TEXT, discovered_via TEXT,
    author_followers INTEGER DEFAULT NULL, author_median_views INTEGER DEFAULT NULL,
    breakout_score REAL DEFAULT 0, niche_fit_score REAL DEFAULT 0, total_score REAL DEFAULT 0,
    status TEXT DEFAULT 'new', discovered_at TEXT)`);
}

test('schema: watch_terms enforces UNIQUE(term,kind) and radar_reels UNIQUE(shortcode)', () => {
  const db = new Database(':memory:');
  makeSchema(db);
  db.prepare("INSERT INTO watch_terms (term,kind,source) VALUES ('fitgirl','hashtag','auto')").run();
  assert.throws(() => db.prepare("INSERT INTO watch_terms (term,kind,source) VALUES ('fitgirl','hashtag','admin')").run());
  db.prepare("INSERT INTO radar_reels (shortcode,account_handle) VALUES ('ABC','x')").run();
  assert.throws(() => db.prepare("INSERT INTO radar_reels (shortcode,account_handle) VALUES ('ABC','y')").run());
});

test('radarConfig: defaults and env override', () => {
  const d = radar.radarConfig({});
  assert.strictEqual(d.termsPerCycle, 10);
  assert.strictEqual(d.minViews, 50000);
  assert.strictEqual(d.wBreakout, 0.7);
  const o = radar.radarConfig({ RADAR_TERMS_PER_CYCLE: '3', RADAR_MIN_VIEWS: '1000' });
  assert.strictEqual(o.termsPerCycle, 3);
  assert.strictEqual(o.minViews, 1000);
});

test('selectWatchTerms: active only, excluded suppresses twin, NULL-first ordering, cap', () => {
  const terms = [
    { id: 1, term: 'a', kind: 'hashtag', status: 'active',  last_run_at: '2026-06-01T00:00:00Z' },
    { id: 2, term: 'b', kind: 'hashtag', status: 'active',  last_run_at: null },
    { id: 3, term: 'c', kind: 'hashtag', status: 'paused',  last_run_at: null },
    { id: 4, term: 'd', kind: 'hashtag', status: 'active',  last_run_at: '2026-05-01T00:00:00Z' },
    { id: 5, term: 'd', kind: 'hashtag', status: 'excluded',last_run_at: null }, // excludes term 'd'
  ];
  const out = radar.selectWatchTerms(terms, 10).map(t => t.term);
  assert.deepStrictEqual(out, ['b', 'a']);
});

test('passesFloors: views/likes/age boundaries', () => {
  const cfg = radar.radarConfig({});
  const now = Date.parse('2026-06-30T00:00:00Z');
  const ok = { view_count: 60000, like_count: 2000, posted_at: '2026-06-25T00:00:00Z' };
  assert.strictEqual(radar.passesFloors(ok, cfg, now), true);
  assert.strictEqual(radar.passesFloors({ ...ok, view_count: 40000 }, cfg, now), false);
  assert.strictEqual(radar.passesFloors({ ...ok, like_count: 10 }, cfg, now), false);
  assert.strictEqual(radar.passesFloors({ ...ok, posted_at: '2026-01-01T00:00:00Z' }, cfg, now), false);
  assert.strictEqual(radar.passesFloors({ ...ok, view_count: null }, cfg, now), false);
});

test('dedupeReels / excludeAuthors', () => {
  const reels = [
    { shortcode: 'A', account_handle: 'x' },
    { shortcode: 'A', account_handle: 'x' },
    { shortcode: 'B', account_handle: 'y' },
    { shortcode: 'C', account_handle: 'z' },
  ];
  const d = radar.dedupeReels(reels, { knownShortcodes: new Set(['C']) });
  assert.deepStrictEqual(d.map(r => r.shortcode), ['A', 'B']);
  const e = radar.excludeAuthors(d, { blockedHandles: new Set(['x']) });
  assert.deepStrictEqual(e.map(r => r.shortcode), ['B']);
});

test('scoreReel: breakout vs known median, cap, unknown-median fallback', () => {
  const cfg = radar.radarConfig({});
  const known = radar.scoreReel({ view_count: 500000, _hashtagOverlap: 0 }, { median_views: 50000 }, cfg);
  assert.strictEqual(known.breakout_score, 10);      // 500k / 50k
  const capped = radar.scoreReel({ view_count: 999000000 }, { median_views: 1000 }, cfg);
  assert.strictEqual(capped.breakout_score, 50);     // breakoutCap
  const unknown = radar.scoreReel({ view_count: 50000 }, null, cfg);
  assert.strictEqual(unknown.breakout_score, 1);     // 50k / minViews(50k)
  assert.ok(known.total_score > unknown.total_score);
});

test('scoreReel: niche overlap raises niche_fit', () => {
  const cfg = radar.radarConfig({});
  const a = radar.scoreReel({ view_count: 50000, _hashtagOverlap: 0 }, null, cfg).niche_fit_score;
  const b = radar.scoreReel({ view_count: 50000, _hashtagOverlap: 3 }, null, cfg).niche_fit_score;
  assert.ok(b > a);
});

const { extractViews } = require('./scraper');

test('normalizeHashtagItem: maps video item, drops non-video', () => {
  const item = {
    shortCode: 'XYZ', ownerUsername: 'Creator1', caption: 'leg day #fitness #gym',
    likesCount: 5000, commentsCount: 120, videoPlayCount: 300000,
    type: 'Video', displayUrl: 'https://cdn/x.jpg', url: 'https://instagram.com/reel/XYZ/',
    timestamp: '2026-06-20T12:00:00Z',
  };
  const r = radar.normalizeHashtagItem(item, 'fitness');
  assert.strictEqual(r.shortcode, 'XYZ');
  assert.strictEqual(r.account_handle, 'creator1');  // lowercased
  assert.strictEqual(r.view_count, 300000);
  assert.strictEqual(r.like_count, 5000);
  assert.strictEqual(r.discovered_via, 'fitness');
  assert.ok(Array.isArray(r._hashtags) && r._hashtags.includes('#fitness'));
  assert.strictEqual(radar.normalizeHashtagItem({ ...item, type: 'Image', productType: undefined }, 'fitness'), null);
});

test('authorMedianFromReels: median of positive view counts', () => {
  assert.strictEqual(radar.authorMedianFromReels([100, 300, 200]), 200);
  assert.strictEqual(radar.authorMedianFromReels([100, 300]), 200);
  assert.strictEqual(radar.authorMedianFromReels([]), null);
  assert.strictEqual(radar.authorMedianFromReels([0, -5, null]), null);
});
