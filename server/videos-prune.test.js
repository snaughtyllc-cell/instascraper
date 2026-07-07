const { test, after } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pruneOldVideos, videoFilePath } = require('./videos');

// Fixed "now" so cutoffs are deterministic across tests.
const NOW = Date.parse('2026-07-07T00:00:00.000Z');
const DAY = 86400000;

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-test-'));
after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} });

// Adapter matching the `db.query(sql, params)` shape used in db.js (see
// content-types-seed.test.js), extended to also report rowCount for
// non-SELECT statements (mirrors the real SQLite branch in db.js, which
// returns `{ rows: [], rowCount: info.changes }` for UPDATE/DELETE) — the
// two-phase claim in pruneOldVideos depends on rowCount to detect races.
function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE posts (
    id INTEGER PRIMARY KEY,
    shortcode TEXT,
    video_url TEXT,
    video_cache_status TEXT,
    video_cache_error TEXT,
    video_cached_at TEXT,
    posted_at TEXT
  )`);
  const query = async (sql, params = []) => {
    const norm = sql.replace(/\$\d+/g, '?');
    if (/^\s*select/i.test(norm)) {
      const rows = sqlite.prepare(norm).all(...params);
      return { rows, rowCount: rows.length };
    }
    const info = sqlite.prepare(norm).run(...params);
    return { rows: [], rowCount: info.changes };
  };
  return { sqlite, query };
}

function insertPost(sqlite, row) {
  sqlite.prepare(`INSERT INTO posts
    (id, shortcode, video_url, video_cache_status, video_cache_error, video_cached_at, posted_at)
    VALUES (@id, @shortcode, @video_url, @video_cache_status, @video_cache_error, @video_cached_at, @posted_at)`
  ).run({
    shortcode: null,
    video_url: null,
    video_cache_error: null,
    video_cached_at: null,
    posted_at: null,
    ...row,
  });
}

function isoDaysAgo(days) {
  return new Date(NOW - days * DAY).toISOString();
}

function writeFileFor(id) {
  fs.writeFileSync(videoFilePath({ id }, DIR), Buffer.from('fake-video-bytes'));
}

test('pruneOldVideos: a 40-day-old cached post is unlinked and cleared; a 5-day-old post is untouched', async () => {
  const { sqlite, query } = makeDb();
  insertPost(sqlite, { id: 1, video_cache_status: 'cached', video_cached_at: isoDaysAgo(40), posted_at: isoDaysAgo(40) });
  writeFileFor(1);
  insertPost(sqlite, { id: 2, video_cache_status: 'cached', video_cached_at: isoDaysAgo(5), posted_at: isoDaysAgo(5) });
  writeFileFor(2);

  const res = await pruneOldVideos({ maxAgeDays: 30 }, { db: { query }, fs, videoDir: DIR, now: () => NOW });

  assert.equal(res.deleted, 1);
  assert.ok(!fs.existsSync(videoFilePath({ id: 1 }, DIR)), 'old file was unlinked');
  const row1 = sqlite.prepare(`SELECT * FROM posts WHERE id = 1`).get();
  assert.equal(row1.video_cache_status, null, 'old row status cleared to NULL');
  assert.equal(row1.video_cached_at, null, 'old row video_cached_at cleared');

  assert.ok(fs.existsSync(videoFilePath({ id: 2 }, DIR)), 'recent file untouched');
  const row2 = sqlite.prepare(`SELECT * FROM posts WHERE id = 2`).get();
  assert.equal(row2.video_cache_status, 'cached', 'recent row untouched');
});

test('pruneOldVideos: a missing file (ENOENT) still finalizes to NULL and does not throw', async () => {
  const { sqlite, query } = makeDb();
  insertPost(sqlite, { id: 3, video_cache_status: 'pending', posted_at: isoDaysAgo(40) });
  // deliberately no file written for id 3

  const res = await pruneOldVideos({ maxAgeDays: 30 }, { db: { query }, fs, videoDir: DIR, now: () => NOW });

  assert.equal(res.deleted, 1);
  const row = sqlite.prepare(`SELECT * FROM posts WHERE id = 3`).get();
  assert.equal(row.video_cache_status, null);
});

test("pruneOldVideos: an already-'pruning' orphan (from an interrupted prior run) IS reclaimed to NULL and its file unlinked [R4-1]", async () => {
  const { sqlite, query } = makeDb();
  // Simulates a row left mid-prune by a crashed earlier run: Phase 1 already
  // ran (status='pruning', video_cached_at already NULLed) but Phase 2/3 never
  // completed, so the file is still present on disk.
  insertPost(sqlite, { id: 4, video_cache_status: 'pruning', video_cached_at: null, posted_at: isoDaysAgo(40) });
  writeFileFor(4);

  const res = await pruneOldVideos({ maxAgeDays: 30 }, { db: { query }, fs, videoDir: DIR, now: () => NOW });

  assert.equal(res.deleted, 1, 'orphan reclaimed without needing a fresh Phase-1 claim');
  assert.ok(!fs.existsSync(videoFilePath({ id: 4 }, DIR)), 'orphaned file was unlinked');
  const row = sqlite.prepare(`SELECT * FROM posts WHERE id = 4`).get();
  assert.equal(row.video_cache_status, null, 'orphan finalized to NULL');
});

test('pruneOldVideos: a simulated non-ENOENT unlink error leaves status pruning (retryable), not NULL', async () => {
  const { sqlite, query } = makeDb();
  insertPost(sqlite, { id: 5, video_cache_status: 'cached', video_cached_at: isoDaysAgo(40), posted_at: isoDaysAgo(40) });
  writeFileFor(5);

  const throwingFs = {
    unlinkSync: () => { const e = new Error('EPERM: operation not permitted'); e.code = 'EPERM'; throw e; },
  };

  const logs = [];
  const orig = console.error; console.error = (...a) => logs.push(a.join(' '));
  let res;
  try {
    res = await pruneOldVideos({ maxAgeDays: 30 }, { db: { query }, fs: throwingFs, videoDir: DIR, now: () => NOW });
  } finally { console.error = orig; }

  assert.equal(res.deleted, 0, 'non-ENOENT unlink failure does not count as deleted');
  const row = sqlite.prepare(`SELECT * FROM posts WHERE id = 5`).get();
  assert.equal(row.video_cache_status, 'pruning', 'left in pruning for retry, not finalized');
  assert.ok(fs.existsSync(videoFilePath({ id: 5 }, DIR)), 'file was never actually deleted (mock threw)');
  assert.ok(logs.some(l => l.includes('[Prune] unlink failed')), 'logs the failure for visibility');
});

test('pruneOldVideos: emits a [Metric] video_prune log line', async () => {
  const { sqlite, query } = makeDb();
  insertPost(sqlite, { id: 6, video_cache_status: 'cached', posted_at: isoDaysAgo(40) });
  writeFileFor(6);

  const logs = [];
  const orig = console.log; console.log = (...a) => logs.push(a.join(' '));
  try {
    await pruneOldVideos({ maxAgeDays: 30 }, { db: { query }, fs, videoDir: DIR, now: () => NOW });
  } finally { console.log = orig; }

  assert.ok(logs.some(l => l.includes('[Metric] video_prune')), 'emits a metric line');
});
