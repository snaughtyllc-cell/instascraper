const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');

// Mirror of the dual-mode DDL initDB creates — asserts the shape is creatable,
// defaults apply, and UNIQUE(term,kind) + ON CONFLICT DO NOTHING behave.
function makeWatchTerms(db) {
  db.exec(`CREATE TABLE watch_terms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    term TEXT NOT NULL,
    kind TEXT DEFAULT 'keyword',
    source TEXT DEFAULT 'user',
    status TEXT DEFAULT 'active',
    added_at TEXT,
    last_run_at TEXT DEFAULT NULL,
    notes TEXT DEFAULT '',
    UNIQUE(term, kind))`);
}

test('watch_terms: defaults apply and ON CONFLICT(term,kind) DO NOTHING is idempotent', () => {
  const db = new Database(':memory:');
  makeWatchTerms(db);
  db.prepare("INSERT INTO watch_terms (term) VALUES ('blonde') ON CONFLICT(term,kind) DO NOTHING").run();
  const dup = db.prepare("INSERT INTO watch_terms (term) VALUES ('blonde') ON CONFLICT(term,kind) DO NOTHING").run();
  assert.strictEqual(dup.changes, 0, 'second identical insert is a no-op');
  const rows = db.prepare('SELECT * FROM watch_terms').all();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].kind, 'keyword');   // default
  assert.strictEqual(rows[0].source, 'user');    // default
  assert.strictEqual(rows[0].status, 'active');  // default
});

const radar = require('./radar');

test('radarConfig: defaults, env override, non-numeric fallback', () => {
  const d = radar.radarConfig({});
  assert.strictEqual(d.termsPerCycle, 10);
  assert.strictEqual(d.maxPages, 1);
  assert.strictEqual(d.authorsMax, 30);
  assert.strictEqual(d.minViews, 20000);
  assert.strictEqual(d.maxAgeDays, 30);
  assert.strictEqual(d.actorId, 'data-slayer~instagram-search-reels');
  const o = radar.radarConfig({ RADAR_TERMS_PER_CYCLE: '3', RADAR_MIN_VIEWS: '1000', RADAR_ACTOR_ID: 'custom~actor' });
  assert.strictEqual(o.termsPerCycle, 3);
  assert.strictEqual(o.minViews, 1000);
  assert.strictEqual(o.actorId, 'custom~actor');
  // non-numeric env falls back to default
  assert.strictEqual(radar.radarConfig({ RADAR_MIN_VIEWS: 'abc' }).minViews, 20000);
});

test('normalizeSearchReel: maps a data-slayer item, drops incomplete, null views', () => {
  const item = {
    code: 'ABC123',
    user: { username: 'kameron.whit', full_name: 'Kameron' },
    ig_play_count: 50178, like_count: 1200, comment_count: 30,
    caption: { text: 'Blonde is the outfit', hashtags: ['blonde'] },
    taken_at_date: '2026-06-20T00:00:00Z',
    video_url: 'https://cdn/v.mp4', thumbnail_url: 'https://cdn/t.jpg',
  };
  const r = radar.normalizeSearchReel(item, 'blonde');
  assert.strictEqual(r.shortcode, 'ABC123');
  assert.strictEqual(r.ownerUsername, 'kameron.whit');
  assert.strictEqual(r.viewCount, 50178);
  assert.strictEqual(r.likeCount, 1200);
  assert.strictEqual(r.commentCount, 30);
  assert.strictEqual(r.caption, 'Blonde is the outfit');
  assert.strictEqual(r.permalink, 'https://www.instagram.com/reel/ABC123/');
  assert.strictEqual(r.term, 'blonde');
  // missing code / username → null
  assert.strictEqual(radar.normalizeSearchReel({ ...item, code: undefined }, 'blonde'), null);
  assert.strictEqual(radar.normalizeSearchReel({ ...item, user: {} }, 'blonde'), null);
  // null ig_play_count → viewCount null (not 0)
  assert.strictEqual(radar.normalizeSearchReel({ ...item, ig_play_count: null }, 'blonde').viewCount, null);
  // taken_at_date as epoch seconds → ISO string
  const epoch = radar.normalizeSearchReel({ ...item, taken_at_date: 1750377600 }, 'blonde');
  assert.strictEqual(typeof epoch.postedAt, 'string');
  assert.ok(epoch.postedAt.startsWith('2025-'));
});

test('passesFloors: minViews + age window, future-dated rejected', () => {
  const cfg = radar.radarConfig({}); // minViews 20000, maxAgeDays 30
  const now = Date.parse('2026-06-30T00:00:00Z');
  const ok = { viewCount: 60000, postedAt: '2026-06-25T00:00:00Z' };
  assert.strictEqual(radar.passesFloors(ok, cfg, now), true);
  assert.strictEqual(radar.passesFloors({ ...ok, viewCount: 10000 }, cfg, now), false);
  assert.strictEqual(radar.passesFloors({ ...ok, viewCount: null }, cfg, now), false);
  assert.strictEqual(radar.passesFloors({ ...ok, postedAt: '2026-01-01T00:00:00Z' }, cfg, now), false); // too old
  assert.strictEqual(radar.passesFloors({ ...ok, postedAt: '2026-07-05T00:00:00Z' }, cfg, now), false); // future
  assert.strictEqual(radar.passesFloors({ ...ok, postedAt: null }, cfg, now), false);
});

test('selectWatchTerms: active only, excluded suppresses twin, null-first, cap', () => {
  const terms = [
    { id: 1, term: 'a', kind: 'keyword', status: 'active',   last_run_at: '2026-06-01T00:00:00Z' },
    { id: 2, term: 'b', kind: 'keyword', status: 'active',   last_run_at: null },
    { id: 3, term: 'c', kind: 'keyword', status: 'paused',   last_run_at: null },
    { id: 4, term: 'd', kind: 'keyword', status: 'active',   last_run_at: '2026-05-01T00:00:00Z' },
    { id: 5, term: 'd', kind: 'keyword', status: 'excluded', last_run_at: null }, // excludes 'd'
  ];
  assert.deepStrictEqual(radar.selectWatchTerms(terms, 10).map(t => t.term), ['b', 'a']);
  assert.deepStrictEqual(radar.selectWatchTerms(terms, 1).map(t => t.term), ['b']); // cap
});

test('dedupeReels / excludeAuthors (author-centric shape)', () => {
  const reels = [
    { shortcode: 'A', ownerUsername: 'x' },
    { shortcode: 'A', ownerUsername: 'x' },
    { shortcode: 'B', ownerUsername: 'y' },
    { shortcode: 'C', ownerUsername: 'z' },
  ];
  const d = radar.dedupeReels(reels, { knownShortcodes: new Set(['C']) });
  assert.deepStrictEqual(d.map(r => r.shortcode), ['A', 'B']);
  const e = radar.excludeAuthors(d, { blockedHandles: new Set(['x']) });
  assert.deepStrictEqual(e.map(r => r.shortcode), ['B']);
});

test('selectRollupAuthors: distinct authors, best reel wins term, sorted, capped', () => {
  const cfg = radar.radarConfig({ RADAR_AUTHORS_MAX: '2' });
  const reels = [
    { ownerUsername: 'a', viewCount: 100000, term: 'blonde' },
    { ownerUsername: 'a', viewCount: 200000, term: 'petite' }, // best → term 'petite'
    { ownerUsername: 'b', viewCount: 150000, term: 'blonde' },
    { ownerUsername: 'c', viewCount: 50000,  term: 'blonde' }, // dropped by cap=2
  ];
  const out = radar.selectRollupAuthors(reels, cfg);
  assert.deepStrictEqual(out.map(a => a.username), ['a', 'b']); // sorted by best views desc, capped
  assert.strictEqual(out[0].source, 'radar:petite');
  assert.ok(out[0].reason.includes("found via 'petite'"));
  assert.ok(out[0].reason.includes('view reel'));
});
