const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { downloadVideo, VIDEO_MAX_MB } = require('./videos');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vidtest-'));
after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} });

// fetch mock: body is a REAL Readable so pipeline/flush behave like production.
function fetchOf({ status = 200, headers = {}, chunks = [Buffer.alloc(1000, 1)] } = {}) {
  return async () => ({
    status, ok: status >= 200 && status < 300,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    body: Readable.from(chunks),
  });
}

test('downloadVideo streams to disk and returns cached (bytes present, flushed)', async () => {
  const r = await downloadVideo({ id: 1, video_url: 'http://x/v.mp4' },
    { fs, fetch: fetchOf({ headers: { 'content-type': 'video/mp4' }, chunks: [Buffer.alloc(1000, 1), Buffer.alloc(1000, 2)] }), videoDir: DIR, inflight: new Map() });
  assert.strictEqual(r.status, 'cached');
  assert.strictEqual(fs.statSync(path.join(DIR, '1.mp4')).size, 2000); // proves flush-before-rename
});
test('downloadVideo returns expired on 403', async () => {
  const r = await downloadVideo({ id: 2, video_url: 'http://x' },
    { fs, fetch: fetchOf({ status: 403 }), videoDir: DIR, inflight: new Map() });
  assert.strictEqual(r.status, 'expired');
});
test('downloadVideo skips when content-length exceeds the cap', async () => {
  const big = String((VIDEO_MAX_MB + 5) * 1024 * 1024);
  const r = await downloadVideo({ id: 3, video_url: 'http://x' },
    { fs, fetch: fetchOf({ headers: { 'content-length': big, 'content-type': 'video/mp4' } }), videoDir: DIR, inflight: new Map() });
  assert.strictEqual(r.status, 'skipped');
  assert.ok(!fs.existsSync(path.join(DIR, '3.mp4')));
});
test('downloadVideo skips a too-big body with NO content-length [CX-6, R2-6]', async () => {
  const oneMB = Buffer.alloc(1024 * 1024, 1);
  const chunks = Array.from({ length: VIDEO_MAX_MB + 2 }, () => oneMB); // exceeds cap, no header
  const r = await downloadVideo({ id: 4, video_url: 'http://x' },
    { fs, fetch: fetchOf({ headers: { 'content-type': 'video/mp4' }, chunks }), videoDir: DIR, inflight: new Map() });
  assert.strictEqual(r.status, 'skipped');
  assert.ok(!fs.existsSync(path.join(DIR, '4.mp4')), 'temp cleaned up, no final file');
  assert.deepStrictEqual(fs.readdirSync(DIR).filter(f => f.startsWith('4.')), [], 'no leftover .tmp file for id 4');
});
test('downloadVideo returns error on an empty (0-byte) 200 body [R3-4]', async () => {
  const r = await downloadVideo({ id: 9, video_url: 'http://x' },
    { fs, fetch: fetchOf({ headers: { 'content-type': 'video/mp4' }, chunks: [] }), videoDir: DIR, inflight: new Map() });
  assert.strictEqual(r.status, 'error');
  assert.ok(!fs.existsSync(path.join(DIR, '9.mp4')), 'no 0-byte file left behind');
  assert.deepStrictEqual(fs.readdirSync(DIR).filter(f => f.startsWith('9.')), [], 'no leftover .tmp file for id 9');
});
test('downloadVideo returns cached without refetching if file exists', async () => {
  fs.writeFileSync(path.join(DIR, '5.mp4'), Buffer.alloc(5));
  let fetched = false;
  const r = await downloadVideo({ id: 5, video_url: 'http://x' },
    { fs, fetch: async () => { fetched = true; return {}; }, videoDir: DIR, inflight: new Map() });
  assert.strictEqual(r.status, 'cached');
  assert.strictEqual(fetched, false);
});
test('downloadVideo dedups concurrent fetches of the same id+url [CX-5]', async () => {
  let calls = 0;
  const slow = async () => { calls++; await new Promise(r => setTimeout(r, 20)); return { status: 200, ok: true, headers: { get: () => null }, body: Readable.from([Buffer.alloc(10, 1)]) }; };
  const inflight = new Map();
  const post = { id: 6, video_url: 'http://x/v.mp4' };
  const [a, b] = await Promise.all([downloadVideo(post, { fs, fetch: slow, videoDir: DIR, inflight }), downloadVideo(post, { fs, fetch: slow, videoDir: DIR, inflight })]);
  assert.strictEqual(a.status, 'cached');
  assert.strictEqual(b.status, 'cached');
  assert.strictEqual(calls, 1, 'same id+url fetched once');
});
test('downloadVideo does NOT dedup concurrent fetches of the same id but different url [CX-5]', async () => {
  let calls = 0;
  const slow = async () => { calls++; await new Promise(r => setTimeout(r, 20)); return { status: 200, ok: true, headers: { get: () => null }, body: Readable.from([Buffer.alloc(10, 1)]) }; };
  const inflight = new Map();
  const [a, b] = await Promise.all([
    downloadVideo({ id: 7, video_url: 'http://x/a.mp4' }, { fs, fetch: slow, videoDir: DIR, inflight }),
    downloadVideo({ id: 7, video_url: 'http://x/b.mp4' }, { fs, fetch: slow, videoDir: DIR, inflight }),
  ]);
  assert.strictEqual(a.status, 'cached');
  assert.strictEqual(b.status, 'cached');
  assert.strictEqual(calls, 2, 'different urls for same id are each fetched (not deduped)');
});
