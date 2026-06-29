const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { downloadThumbnail } = require('./thumbnails');

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
