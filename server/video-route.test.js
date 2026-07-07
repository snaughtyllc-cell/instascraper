// server/video-route.test.js
// [CX-12, R2-1, R2-10, R3-6, R5-1, R5-2] Unit tests for the GET /video/:id route's
// pure branching logic, extracted from index.js so they're testable WITHOUT
// booting Express or hitting the DB: videoUrlIsFresh (302 gate), isValidVideoId
// (the id guard), and serveVideo (sendFile/302/404 branches, given fake fs/res).
const { test } = require('node:test');
const assert = require('node:assert');
const app = require('./index');
const { videoUrlIsFresh, isValidVideoId, serveVideo } = app;

// ── videoUrlIsFresh ──────────────────────────────────────────────

test('videoUrlIsFresh: (a) fresh video_url_refreshed_at -> true', () => {
  assert.strictEqual(
    videoUrlIsFresh({ video_url_refreshed_at: new Date().toISOString() }),
    true
  );
});

test('videoUrlIsFresh: (b) 30-day-old refresh -> false (aged out -> poster, not a 302)', () => {
  assert.strictEqual(
    videoUrlIsFresh({ video_url_refreshed_at: new Date(Date.now() - 30 * 86400000).toISOString() }),
    false
  );
});

test('videoUrlIsFresh: (c) null video_url_refreshed_at -> false', () => {
  assert.strictEqual(videoUrlIsFresh({ video_url_refreshed_at: null }), false);
});

test("videoUrlIsFresh: (d) video_cache_status='pruning' with a FRESH refresh time -> false (pruning always wins)", () => {
  assert.strictEqual(
    videoUrlIsFresh({ video_cache_status: 'pruning', video_url_refreshed_at: new Date().toISOString() }),
    false
  );
});

test('videoUrlIsFresh: (e) a pending row refreshed 20 days ago -> false (pending is NOT eternal)', () => {
  assert.strictEqual(
    videoUrlIsFresh({
      video_cache_status: 'pending',
      video_url_refreshed_at: new Date(Date.now() - 20 * 86400000).toISOString(),
    }),
    false
  );
});

// ── id validation ────────────────────────────────────────────────
// [R2-10, R4-4] Number('abc'), 0, -1, and a value past int4 max must all
// short-circuit to 404 before any pool.query.

test('isValidVideoId rejects Number("abc") (NaN)', () => {
  assert.strictEqual(isValidVideoId(Number('abc')), false);
});

test('isValidVideoId rejects 0', () => {
  assert.strictEqual(isValidVideoId(0), false);
});

test('isValidVideoId rejects -1', () => {
  assert.strictEqual(isValidVideoId(-1), false);
});

test('isValidVideoId rejects 3000000000 (over Postgres int4 max)', () => {
  assert.strictEqual(isValidVideoId(3000000000), false);
});

test('isValidVideoId accepts an ordinary positive id', () => {
  assert.strictEqual(isValidVideoId(42), true);
});

test('isValidVideoId accepts the int4 max boundary (2147483647)', () => {
  assert.strictEqual(isValidVideoId(2147483647), true);
});

// ── serveVideo: fake fs/res, no Express boot, no DB ─────────────

function fakeRes() {
  return {
    headersSent: false,
    _status: null,
    _sent: null,
    _redirect: null,
    _sendFileArgs: null,
    status(code) { this._status = code; return this; },
    send(body) { this._sent = body; return this; },
    end() { return this; },
    redirect(code, url) { this._redirect = [code, url]; return this; },
    sendFile(file, opts, cb) { this._sendFileArgs = [file, opts, cb]; return this; },
  };
}

function statSyncOk(size = 100) {
  return () => ({ size });
}
function statSyncEnoent() {
  return () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
}

test('serveVideo: cached file -> res.sendFile with acceptRanges (Express handles Range/416/Content-Type)', () => {
  const res = fakeRes();
  serveVideo({ id: 1 }, { fs: { statSync: statSyncOk() }, videoDir: '/videos', res });
  assert.ok(res._sendFileArgs, 'sendFile should be called');
  assert.strictEqual(res._sendFileArgs[0], '/videos/1.mp4');
  assert.deepStrictEqual(res._sendFileArgs[1], { acceptRanges: true });
});

test("[R5-2, R4-2] serveVideo: video_cache_status='pruning' with a present file does NOT call res.sendFile (falls through)", () => {
  const res = fakeRes();
  // fs says the file is there (size 100) but the row is mid-prune — must not be served.
  serveVideo(
    { id: 2, video_cache_status: 'pruning', video_url: null },
    { fs: { statSync: statSyncOk() }, videoDir: '/videos', res }
  );
  assert.strictEqual(res._sendFileArgs, null, 'sendFile must not be called for a pruning row');
  assert.strictEqual(res._status, 404);
});

test('serveVideo: uncached, fresh video_url -> 302 redirect', () => {
  const res = fakeRes();
  const post = {
    id: 3,
    video_url: 'https://cdn.example/x.mp4',
    video_url_refreshed_at: new Date().toISOString(),
  };
  serveVideo(post, { fs: { statSync: statSyncEnoent() }, videoDir: '/videos', res });
  assert.deepStrictEqual(res._redirect, [302, 'https://cdn.example/x.mp4']);
  assert.strictEqual(res._sendFileArgs, null);
});

test('serveVideo: uncached, stale video_url -> 404 (no wasted 302->403)', () => {
  const res = fakeRes();
  const post = {
    id: 4,
    video_url: 'https://cdn.example/x.mp4',
    video_url_refreshed_at: new Date(Date.now() - 30 * 86400000).toISOString(),
  };
  serveVideo(post, { fs: { statSync: statSyncEnoent() }, videoDir: '/videos', res });
  assert.strictEqual(res._status, 404);
  assert.strictEqual(res._redirect, null);
});

test('serveVideo: uncached, no video_url at all -> 404', () => {
  const res = fakeRes();
  serveVideo({ id: 5, video_url: null }, { fs: { statSync: statSyncEnoent() }, videoDir: '/videos', res });
  assert.strictEqual(res._status, 404);
  assert.strictEqual(res._redirect, null);
});

test('[CX-9] serveVideo: sendFile TOCTOU error -> 404 when headers not yet sent', () => {
  const res = fakeRes();
  serveVideo({ id: 6 }, { fs: { statSync: statSyncOk() }, videoDir: '/videos', res });
  const [, , errCb] = res._sendFileArgs;
  errCb(new Error('file vanished mid-stream'));
  assert.strictEqual(res._status, 404);
});

test('serveVideo: sendFile error callback is a no-op once headers are already sent', () => {
  const res = fakeRes();
  res.headersSent = true;
  serveVideo({ id: 7 }, { fs: { statSync: statSyncOk() }, videoDir: '/videos', res });
  const [, , errCb] = res._sendFileArgs;
  errCb(new Error('stream error after headers sent'));
  assert.strictEqual(res._status, null, 'must not call res.status once headers are already sent');
});
