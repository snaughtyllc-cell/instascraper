const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { downloadThumbnail, sweepThumbnails } = require('./thumbnails');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'thumbtest-'));
}
function okFetch(bytes = Buffer.from('JPEGDATA')) {
  return async () => ({ ok: true, status: 200, headers: { get: () => 'image/jpeg' }, buffer: async () => bytes });
}

test('downloads and caches a fresh thumbnail atomically', async () => {
  const dir = tmpDir();
  const r = await downloadThumbnail({ shortcode: 'abc', thumbnail_url: 'http://x/a.jpg' },
    { fetch: okFetch(), thumbDir: dir, inflight: new Map() });
  assert.equal(r.status, 'cached');
  assert.ok(fs.existsSync(path.join(dir, 'abc.jpg')));
  assert.ok(fs.readdirSync(dir).every(f => !f.includes('.tmp')), 'no temp files left behind');
});

test('returns cached without refetching when a valid file already exists', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'abc.jpg'), 'EXISTING');
  let called = false;
  const r = await downloadThumbnail({ shortcode: 'abc', thumbnail_url: 'http://x/a.jpg' },
    { fetch: async () => { called = true; return {}; }, thumbDir: dir, inflight: new Map() });
  assert.equal(r.status, 'cached');
  assert.equal(called, false);
});

test('marks expired on 403 and does not write a file', async () => {
  const dir = tmpDir();
  const r = await downloadThumbnail({ shortcode: 'gone', thumbnail_url: 'http://x/g.jpg' },
    { fetch: async () => ({ ok: false, status: 403, headers: { get: () => null } }), thumbDir: dir, inflight: new Map() });
  assert.equal(r.status, 'expired');
  assert.equal(fs.existsSync(path.join(dir, 'gone.jpg')), false);
});

test('rejects a zero-byte body as error', async () => {
  const dir = tmpDir();
  const r = await downloadThumbnail({ shortcode: 'empty', thumbnail_url: 'http://x/e.jpg' },
    { fetch: okFetch(Buffer.alloc(0)), thumbDir: dir, inflight: new Map() });
  assert.equal(r.status, 'error');
  assert.equal(fs.existsSync(path.join(dir, 'empty.jpg')), false);
});

test('dedups concurrent downloads of the same shortcode', async () => {
  const dir = tmpDir();
  let calls = 0;
  const slow = async () => { calls++; await new Promise(r => setTimeout(r, 20)); return { ok: true, status: 200, headers: { get: () => 'image/jpeg' }, buffer: async () => Buffer.from('X') }; };
  const inflight = new Map();
  const post = { shortcode: 'dup', thumbnail_url: 'http://x/d.jpg' };
  const [a, b] = await Promise.all([
    downloadThumbnail(post, { fetch: slow, thumbDir: dir, inflight }),
    downloadThumbnail(post, { fetch: slow, thumbDir: dir, inflight }),
  ]);
  assert.equal(a.status, 'cached');
  assert.equal(b.status, 'cached');
  assert.equal(calls, 1, 'fetch should run once for two concurrent callers');
});

test('sweep downloads only pending/null recent posts and tallies outcomes', async () => {
  const rows = [
    { id: 1, shortcode: 'a', thumbnail_url: 'http://x/a' },
    { id: 2, shortcode: 'b', thumbnail_url: 'http://x/b' },
  ];
  const updates = [];
  const db = {
    query: async (sql, params) => {
      if (/SELECT/i.test(sql)) return { rows };
      updates.push({ sql, params });
      return { rows: [] };
    },
  };
  const download = async (post) => post.shortcode === 'a'
    ? { status: 'cached' } : { status: 'expired', error: 'HTTP 403' };

  const res = await sweepThumbnails({ batchLimit: 10 }, { db, download, delay: () => Promise.resolve() });
  assert.equal(res.attempted, 2);
  assert.equal(res.cached, 1);
  assert.equal(res.expired, 1);
  assert.equal(updates.length, 2, 'writes a cache-status update per post');
});

test('sweep never throws when a download rejects', async () => {
  const db = { query: async (sql) => /SELECT/i.test(sql) ? { rows: [{ id: 1, shortcode: 'a', thumbnail_url: 'u' }] } : { rows: [] } };
  const download = async () => { throw new Error('boom'); };
  const res = await sweepThumbnails({}, { db, download, delay: () => Promise.resolve() });
  assert.equal(res.errored, 1);
});

test('sweep heals re-scraped old (pending) posts regardless of age, but recency-filters legacy NULL rows', async () => {
  const Database = require('better-sqlite3');
  const sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE posts (id INTEGER PRIMARY KEY, shortcode TEXT, thumbnail_url TEXT,
    thumbnail_cache_status TEXT, thumbnail_cache_error TEXT, scraped_at TEXT)`);
  const ins = sqlite.prepare(`INSERT INTO posts (id,shortcode,thumbnail_url,thumbnail_cache_status,scraped_at) VALUES (?,?,?,?,?)`);
  // legacy: old scraped_at, NULL status (pre-migration, URL likely expired) -> SKIP
  ins.run(1, 'legacy_old', 'u', null, '2020-01-01T00:00:00Z');
  // re-scraped old post: old scraped_at BUT status='pending' (upsert just set a FRESH url) -> MUST be swept (heal path / CX-011)
  ins.run(2, 'rescraped_old', 'u', 'pending', '2020-02-02T00:00:00Z');
  // recent legacy NULL within window -> swept
  ins.run(3, 'recent_legacy', 'u', null, '2026-06-28T00:00:00Z');
  const db = { query: async (sql, params = []) => {
    const conv = sql.replace(/\$(\d+)/g, '?');
    if (/^\s*SELECT/i.test(sql)) return { rows: sqlite.prepare(conv).all(...params) };
    sqlite.prepare(conv).run(...params); return { rows: [] };
  }};
  const seen = [];
  const download = async (p) => { seen.push(p.shortcode); return { status: 'cached' }; };
  await sweepThumbnails({ maxAgeDays: 14 },
    { db, download, delay: () => Promise.resolve(), now: () => Date.parse('2026-06-29T00:00:00Z') });
  assert.ok(seen.includes('rescraped_old'), 'a re-scraped old post (pending, fresh URL) IS healed by the sweep');
  assert.ok(seen.includes('recent_legacy'), 'a recent legacy post IS swept');
  assert.ok(!seen.includes('legacy_old'), 'an old legacy NULL-status post is SKIPPED (do not hammer expired URLs)');
});
