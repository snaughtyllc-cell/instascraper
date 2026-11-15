const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const Database = require('better-sqlite3');
const { ensureFilmTables } = require('./film-migration');
// scraper's production DB singleton must never open the developer database here.
const sqlitePath = process.env.SQLITE_PATH;
process.env.SQLITE_PATH = ':memory:';
const { registerFilmApi } = require('./film-api');
const { createReactFetchWorker } = require('./react-fetch');
if (sqlitePath === undefined) delete process.env.SQLITE_PATH;
else process.env.SQLITE_PATH = sqlitePath;
const { appRequest } = require('./test-support/app-request');

async function fixture(t, worker) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'react-fetch-api-'));
  const originalEnv = {};
  for (const [name, value] of Object.entries({ FILM_SERVICE_KEY: 'api-key', FILM_MEDIA_SECRET: 'media-key',
    PUBLIC_BASE_URL: 'https://media.example.test', REACT_REF_DIR: dir })) {
    originalEnv[name] = process.env[name];
    process.env[name] = value;
  }
  const db = new Database(':memory:');
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  db.exec('CREATE TABLE models (id INTEGER PRIMARY KEY); CREATE TABLE posts (id INTEGER PRIMARY KEY, shortcode TEXT, video_url TEXT)');
  const pool = { query: async (sql, values = []) => {
    assert.deepEqual([...sql.matchAll(/\$(\d+)/g)].map(match => Number(match[1])), values.map((_, index) => index + 1));
    const statement = db.prepare(sql.replace(/\$\d+/g, '?'));
    if (statement.reader) { const rows = statement.all(...values); return { rows, rowCount: rows.length }; }
    return { rows: [], rowCount: statement.run(...values).changes };
  } };
  let pending = Promise.resolve();
  pool.transaction = work => {
    const result = pending.then(async () => {
      db.exec('BEGIN');
      try { const value = await work(pool); db.exec('COMMIT'); return value; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    });
    pending = result.catch(() => {});
    return result;
  };
  await ensureFilmTables(pool, { isPg: false });
  const app = express();
  const calls = [];
  const reactFetchWorker = worker || { request: async shortcode => { calls.push(shortcode); return { state: 'fetching', launched: true }; } };
  registerFilmApi(app, { pool, reactWorker: { enqueue: async () => {} }, reactFetchWorker });
  const request = (method, url, body, headers = {}) => appRequest(app, {
    method, path: url, body, headers: { Authorization: 'Bearer api-key', ...headers },
  });
  function reference(shortcode, state, file = true) {
    db.prepare('INSERT INTO film_react_refs (shortcode, state, duration_sec) VALUES (?, ?, ?)').run(shortcode, state, 7.25);
    if (file) fs.writeFileSync(path.join(dir, `${shortcode}.mp4`), '0123456789');
  }
  return { app, db, pool, dir, calls, request, reference };
}

function signedPath(shortcode, exp = Math.floor(Date.now() / 1000) + 3600, namespace = 'react-media.') {
  const sig = crypto.createHmac('sha256', process.env.FILM_MEDIA_SECRET).update(`${namespace}${shortcode}.${exp}`).digest('hex');
  return `/film/v1/react-media/${shortcode}?exp=${exp}&sig=${sig}`;
}

test('unknown React references return fetching and delegate to the fetch worker', async t => {
  const f = await fixture(t);
  const response = await f.request('POST', '/film/v1/react-reference', { shortcode: 'unknown_123' });
  assert.equal(response.status, 202);
  assert.deepEqual(response.body, { state: 'fetching' });
  assert.deepEqual(f.calls, ['unknown_123']);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM posts').get().count, 0);
});

test('fetch false returns unavailable without worker, budget, cap or ledger activity', async t => {
  const f = await fixture(t);
  let workerCalls = 0, budgetCalls = 0, capReads = 0, actorLaunches = 0, ledgerCalls = 0;
  const query = f.pool.query;
  f.pool.query = async (sql, values) => {
    if (/film_react_ref_attempts/.test(sql)) capReads++;
    return query(sql, values);
  };
  const worker = createReactFetchWorker({ pool: f.pool, env: { REACT_REF_DIR: f.dir, APIFY_API_KEY: 'fake-key' },
    apify: {
      startRun: async () => { actorLaunches++; return { id: 'unexpected-run', status: 'SUCCEEDED' }; },
      getItems: async () => [],
    },
    budgetStatus: async () => { budgetCalls++; return { blocked: false }; },
    recordRunLaunch: async () => { ledgerCalls++; }, recordRunCompletion: async () => { ledgerCalls++; },
  });
  const app = express();
  registerFilmApi(app, { pool: f.pool, reactWorker: { enqueue: async () => {} }, reactFetchWorker: {
    request: shortcode => { workerCalls++; return worker.request(shortcode); },
  } });
  f.reference('fetching_123', 'fetching', false);
  f.reference('failed_123', 'failed', false);
  f.reference('missing_file_123', 'ready', false);
  f.db.prepare('INSERT INTO film_react_ref_attempts (attempt_id, shortcode, created_at) VALUES (?, ?, ?)')
    .run('existing-attempt', 'fetching_123', new Date().toISOString());
  const refsBefore = f.db.prepare('SELECT * FROM film_react_refs ORDER BY shortcode').all();
  const attemptsBefore = f.db.prepare('SELECT * FROM film_react_ref_attempts ORDER BY attempt_id').all();
  for (const shortcode of ['unknown_123', 'fetching_123', 'failed_123', 'missing_file_123']) {
    const response = await appRequest(app, { method: 'POST', path: '/film/v1/react-reference',
      body: { shortcode, fetch: false }, headers: { Authorization: 'Bearer api-key' } });
    if (workerCalls) await worker.waitForIdle();
    assert.equal(response.status, 404, shortcode);
    assert.deepEqual(response.body, { error: 'reel_not_available' });
  }
  assert.equal(workerCalls, 0);
  assert.equal(budgetCalls, 0);
  assert.equal(capReads, 0);
  assert.equal(actorLaunches, 0);
  assert.equal(ledgerCalls, 0);
  assert.deepEqual(f.db.prepare('SELECT * FROM film_react_ref_attempts ORDER BY attempt_id').all(), attemptsBefore);
  assert.deepEqual(f.db.prepare('SELECT * FROM film_react_refs ORDER BY shortcode').all(), refsBefore);
});

test('fetch false still returns ready fetched references with a signed media URL', async t => {
  const f = await fixture(t);
  f.reference('ready_123', 'ready');
  const response = await f.request('POST', '/film/v1/react-reference', { shortcode: 'ready_123', fetch: false });
  assert.equal(response.status, 200);
  assert.equal(response.body.durationSec, 7.25);
  const url = new URL(response.body.videoUrl);
  assert.equal(url.pathname + url.search, signedPath('ready_123', Number(url.searchParams.get('exp'))));
  assert.deepEqual(f.calls, []);
});

test('react-reference rejects nonboolean fetch values before consulting the worker', async t => {
  const f = await fixture(t);
  f.reference('ready_123', 'ready');
  for (const fetch of ['no', null, 0, {}, []]) {
    const response = await f.request('POST', '/film/v1/react-reference', { shortcode: 'ready_123', fetch });
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: 'invalid_fetch' });
  }
  assert.deepEqual(f.calls, []);
});

test('explicit fetch true starts an unavailable reference like the omitted default', async t => {
  const f = await fixture(t);
  const response = await f.request('POST', '/film/v1/react-reference', { shortcode: 'unknown_123', fetch: true });
  assert.equal(response.status, 202);
  assert.deepEqual(response.body, { state: 'fetching' });
  assert.deepEqual(f.calls, ['unknown_123']);
});

test('concurrent missing-reference requests share one fetch and become playable after success', async t => {
  const f = await fixture(t);
  const launches = [], completions = [];
  let launchCount = 0, release;
  const heldRun = new Promise(resolve => { release = resolve; });
  const worker = createReactFetchWorker({ pool: f.pool, env: { REACT_REF_DIR: f.dir, APIFY_API_KEY: 'fake-key' },
    apify: {
      startRun: async (actor, input) => {
        launchCount++;
        await heldRun;
        return { id: input.directUrls[0].includes('stub_123') ? 'stub-run' : 'fake-run', status: 'SUCCEEDED' };
      },
      getItems: async id => id === 'stub-run' ? [{ error: 'not_found', errorDescription: 'Unavailable' }]
        : [{ videoUrl: 'https://video.cdninstagram.com/video.mp4' }],
    },
    download: async (post, { videoDir }) => {
      fs.writeFileSync(path.join(videoDir, `${post.shortcode}.mp4`), '0123456789');
      return { status: 'cached' };
    },
    probe: async () => ({ durationSec: 4.5 }), budgetStatus: async () => ({ blocked: false }),
    recordRunLaunch: async (pool, run) => launches.push(run),
    recordRunCompletion: async (pool, run) => completions.push(run),
  });
  const app = express();
  registerFilmApi(app, { pool: f.pool, reactWorker: { enqueue: async () => {} }, reactFetchWorker: worker });
  const reference = (shortcode = 'fresh_123') => appRequest(app, { method: 'POST', path: '/film/v1/react-reference',
    body: { shortcode }, headers: { Authorization: 'Bearer api-key' } });
  try {
    const responses = await Promise.all([reference(), reference(), reference()]);
    for (const response of responses) {
      assert.equal(response.status, 202);
      assert.deepEqual(response.body, { state: 'fetching' });
    }
    assert.equal(launchCount, 1);
    release();
    await worker.waitForIdle();
    const ready = await reference();
    assert.equal(ready.status, 200);
    assert.equal(ready.body.durationSec, 4.5);
    const url = new URL(ready.body.videoUrl);
    const media = await appRequest(app, { path: url.pathname + url.search, headers: { Range: 'bytes=2-5' } });
    assert.equal(media.status, 206);
    assert.equal(media.text, '2345');
    assert.equal(launches.length, 1);
    assert.equal(launches[0].purpose, 'react_ref');
    assert.equal(launches[0].query, 'reel:fresh_123');
    assert.equal(completions.length, 1);
    assert.equal((await reference('stub_123')).status, 202);
    await worker.waitForIdle();
    const failed = await reference('stub_123');
    assert.equal(failed.status, 404);
    assert.deepEqual(failed.body, { error: 'reel_not_available' });
    assert.equal(f.db.prepare('SELECT state FROM film_react_refs WHERE shortcode = ?').get('stub_123').state, 'failed');
    assert.equal(launchCount, 2, 'recent failed references do not launch again');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM posts').get().count, 0);
  } finally {
    release();
    await worker.waitForIdle();
  }
});

test('unavailable fetch requests return the private failure response', async t => {
  let launches = 0;
  const f = await fixture(t, { request: async () => { launches++; return { state: 'unavailable', launched: false }; } });
  const response = await f.request('POST', '/film/v1/react-reference', { shortcode: 'failed_123' });
  assert.equal(response.status, 404);
  assert.deepEqual(response.body, { error: 'reel_not_available' });
  assert.equal(launches, 1);
});

test('ready fetched references return a six-hour domain-separated URL without entering posts', async t => {
  const f = await fixture(t);
  f.reference('ready_123', 'ready');
  const start = Math.floor(Date.now() / 1000);
  const response = await f.request('POST', '/film/v1/react-reference', { shortcode: 'ready_123' });
  assert.equal(response.status, 200);
  assert.equal(response.body.durationSec, 7.25);
  const url = new URL(response.body.videoUrl);
  assert.equal(url.origin, 'https://media.example.test');
  const exp = Number(url.searchParams.get('exp'));
  assert.ok(exp >= start + 21600 && exp <= Math.floor(Date.now() / 1000) + 21600);
  assert.equal(url.pathname + url.search, signedPath('ready_123', exp));
  assert.deepEqual(f.calls, [], 'ready references do not launch another fetch');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM posts').get().count, 0);
});

test('a post with no video uses its ready fetched reference URL and stored duration', async t => {
  const f = await fixture(t);
  f.db.prepare('INSERT INTO posts (id, shortcode) VALUES (?, ?)').run(2147483000, 'no_video_123');
  f.reference('no_video_123', 'ready');
  const response = await f.request('POST', '/film/v1/react-reference', { shortcode: 'no_video_123' });
  assert.equal(response.status, 200);
  assert.equal(response.body.durationSec, 7.25);
  assert.equal(new URL(response.body.videoUrl).pathname, '/film/v1/react-media/no_video_123');
  assert.deepEqual(f.calls, []);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM posts').get().count, 1);
});

test('signed fetched media supports full, Range and unsatisfiable requests without bearer', async t => {
  const f = await fixture(t);
  f.reference('ready_123', 'ready');
  const url = signedPath('ready_123');
  const full = await appRequest(f.app, { path: url });
  assert.equal(full.status, 200);
  assert.equal(full.text, '0123456789');
  assert.equal(full.headers['content-type'], 'video/mp4');
  assert.equal(full.headers['cache-control'], 'private, no-store');
  const partial = await appRequest(f.app, { path: url, headers: { Range: 'bytes=2-5' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.text, '2345');
  assert.equal(partial.headers['content-range'], 'bytes 2-5/10');
  const beyond = await appRequest(f.app, { path: url, headers: { Range: 'bytes=20-30' } });
  assert.equal(beyond.status, 416);
  assert.deepEqual(beyond.body, { error: 'range_not_satisfiable' });
});

test('fetched media rejects invalid, expired, duplicated and ordinary media signatures', async t => {
  const f = await fixture(t);
  f.reference('12345', 'ready');
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const valid = signedPath('12345', exp);
  for (const url of [
    '/film/v1/react-media/12345', `${valid}0`, signedPath('12345', Math.floor(Date.now() / 1000)),
    valid.replace('/12345?', '/12346?'), `${valid}&exp=${exp}`, `${valid}&sig=${'a'.repeat(64)}`,
    valid.replace(`exp=${exp}`, 'exp=999999999999999999999'), signedPath('12345', exp, ''),
    signedPath('..%2Foutside', exp),
  ]) {
    const response = await f.request('GET', url);
    assert.equal(response.status, 403, url);
    assert.deepEqual(response.body, { error: 'invalid_signature' });
  }
  process.env.FILM_MEDIA_SECRET = '';
  assert.equal((await f.request('GET', valid)).status, 503);
});

test('fetched media serves only ready, nonempty regular files', async t => {
  const f = await fixture(t);
  f.reference('failed_123', 'failed');
  f.reference('fetching_123', 'fetching');
  f.reference('missing_123', 'ready', false);
  f.reference('empty_123', 'ready');
  fs.writeFileSync(path.join(f.dir, 'empty_123.mp4'), '');
  f.reference('symlink_123', 'ready', false);
  const outside = path.join(f.dir, 'outside.mp4');
  fs.writeFileSync(outside, 'not a reference');
  fs.symlinkSync(outside, path.join(f.dir, 'symlink_123.mp4'));
  for (const shortcode of ['failed_123', 'fetching_123', 'missing_123', 'empty_123', 'symlink_123', 'absent_123']) {
    const response = await appRequest(f.app, { path: signedPath(shortcode) });
    assert.equal(response.status, 404, shortcode);
    assert.deepEqual(response.body, { error: 'reel_not_available' });
  }
});

test('prefetch rejects invalid batches atomically and requires service authentication', async t => {
  const f = await fixture(t);
  for (const body of [undefined, {}, { shortcodes: [] }, { shortcodes: 'valid_123' },
    { shortcodes: Array(51).fill('valid_123') }, { shortcodes: ['valid_123', '../bad'] },
    { shortcodes: ['valid_123', null] }, { shortcodes: ['valid_123', 'x'.repeat(65)] }]) {
    const response = await f.request('POST', '/film/v1/react-prefetch', body);
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: 'invalid_shortcodes' });
  }
  assert.deepEqual(f.calls, []);
  assert.equal((await f.request('POST', '/film/v1/react-prefetch', '{', { Authorization: '' })).status, 401);
});

test('prefetch deduplicates and skips posts, pins and already active references', async t => {
  const calls = [];
  const f = await fixture(t, { request: async shortcode => {
    calls.push(shortcode);
    return { state: shortcode === 'failed_123' ? 'unavailable' : 'fetching', launched: shortcode === 'unknown_123' };
  } });
  f.db.prepare('INSERT INTO posts (id, shortcode) VALUES (?, ?)').run(1, 'known_123');
  fs.writeFileSync(path.join(f.dir, 'pinned_123.mp4'), 'a pin');
  f.reference('ready_123', 'ready');
  f.reference('fetching_123', 'fetching', false);
  f.reference('failed_123', 'failed', false);
  const response = await f.request('POST', '/film/v1/react-prefetch', {
    shortcodes: ['known_123', 'pinned_123', 'ready_123', 'fetching_123', 'failed_123', 'unknown_123', 'unknown_123'],
  });
  assert.equal(response.status, 202);
  assert.deepEqual(response.body, { queued: 1 });
  assert.deepEqual(calls, ['fetching_123', 'failed_123', 'unknown_123']);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM posts').get().count, 1);
});
