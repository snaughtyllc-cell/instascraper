const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
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

async function fixture(t, worker, analysisWorker) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'react-fetch-api-'));
  const originalEnv = {};
  for (const [name, value] of Object.entries({ FILM_SERVICE_KEY: 'api-key', FILM_MEDIA_SECRET: 'media-key',
    PUBLIC_BASE_URL: 'https://media.example.test', REACT_REF_DIR: dir, GEMINI_API_KEY: '' })) {
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
  db.exec(`CREATE TABLE models (id INTEGER PRIMARY KEY);
    CREATE TABLE posts (id INTEGER PRIMARY KEY, shortcode TEXT, video_url TEXT);
    CREATE TABLE apify_runs (run_id TEXT PRIMARY KEY, purpose TEXT, query TEXT, started_at TEXT)`);
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
  registerFilmApi(app, { pool, reactWorker: { enqueue: async () => {} }, reactFetchWorker,
    reactAnalysisWorker: analysisWorker || { request: async () => ({ state: 'failed', analysis: null }),
      getResult: async () => ({ state: 'failed', analysis: null }) } });
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

function originalSignedPath(shortcode, exp = Math.floor(Date.now() / 1000) + 3600) {
  const sig = crypto.createHmac('sha256', process.env.FILM_MEDIA_SECRET)
    .update(`react-media.${shortcode}.original.${exp}`).digest('hex');
  return `/film/v1/react-media/${shortcode}?variant=original&exp=${exp}&sig=${sig}`;
}

test('React analysis keeps the fetching shape then serves analysis and the React-ready MP4', async t => {
  let result = { state: 'fetching', analysis: null };
  let resultLookups = 0;
  const calls = [];
  const f = await fixture(t, undefined, {
    request: async (shortcode, reference) => { calls.push({ shortcode, reference }); return result; },
    getResult: async () => { resultLookups++; return result; },
  });
  f.reference('analyzed_123', 'ready');
  const pending = await f.request('POST', '/film/v1/react-reference', { shortcode: 'analyzed_123', fetch: false });
  assert.equal(pending.status, 202);
  assert.deepEqual(pending.body, { state: 'fetching' });
  assert.equal(calls[0].shortcode, 'analyzed_123');
  assert.equal(calls[0].reference.path, path.join(f.dir, 'analyzed_123.mp4'));
  const analysis = { version: 1, seam: 0.42, layout: [{ start: 0, end: 7.25, kind: 'split' }],
    cues: [{ start: 1, end: 2, text: 'Creator line' }], creatorMuted: true };
  const readyFile = path.join(f.dir, 'analyzed_123.react.mp4');
  fs.writeFileSync(readyFile, 'muted creator');
  result = { state: 'ready', analysis, path: readyFile };
  const ready = await f.request('POST', '/film/v1/react-reference', { shortcode: 'analyzed_123' });
  assert.equal(ready.status, 200);
  assert.deepEqual(ready.body.analysis, analysis);
  assert.equal(ready.body.durationSec, 7.25);
  const url = new URL(ready.body.videoUrl);
  assert.equal(url.pathname + url.search, signedPath('analyzed_123', Number(url.searchParams.get('exp'))));
  const originalUrl = new URL(ready.body.originalVideoUrl);
  const originalPath = originalUrl.pathname + originalUrl.search;
  assert.equal(originalUrl.origin, 'https://media.example.test');
  assert.equal(originalPath, originalSignedPath('analyzed_123', Number(originalUrl.searchParams.get('exp'))));
  const media = await appRequest(f.app, { path: url.pathname + url.search, headers: { Range: 'bytes=0-4' } });
  assert.equal(media.status, 206);
  assert.equal(media.text, 'muted');
  assert.equal(resultLookups, 1);
  const original = await appRequest(f.app, { path: originalPath, headers: { Range: 'bytes=2-5' } });
  assert.equal(original.status, 206);
  assert.equal(original.text, '2345');
  assert.equal(original.headers['content-range'], 'bytes 2-5/10');
  assert.equal(resultLookups, 1, 'original media never consults the analysis worker');
  assert.deepEqual(f.calls, []);
  fs.unlinkSync(path.join(f.dir, 'analyzed_123.mp4'));
  const missingOriginal = await appRequest(f.app, { path: originalPath });
  assert.equal(missingOriginal.status, 404, 'an original URL must never fall back to the derivative');
  assert.deepEqual(missingOriginal.body, { error: 'reel_not_available' });
  assert.equal(resultLookups, 1);
  assert.equal((await appRequest(f.app, { path: url.pathname + url.search })).text, 'muted creator',
    'a ready derivative remains playable without the original pin');
  fs.writeFileSync(path.join(f.dir, 'analyzed_123.mp4'), 'original');
  fs.unlinkSync(readyFile);
  assert.equal((await appRequest(f.app, { path: url.pathname + url.search })).text, 'original',
    'a missing derivative falls back to the original pin');
  assert.equal((await f.request('POST', '/film/v1/react-reference', { shortcode: 'analyzed_123' })).body.analysis, null,
    'missing derivative never returns metadata claiming creator muting');
});

test('dance references immediately return signed original URLs without consulting analysis', async t => {
  let analyses = 0, lookups = 0;
  const f = await fixture(t, undefined, {
    request: async () => { analyses++; return { state: 'fetching', analysis: null }; },
    getResult: async () => { lookups++; throw new Error('dance media must skip analysis'); },
  });
  f.reference('dance_ready', 'ready');
  const response = await f.request('POST', '/film/v1/react-reference', {
    shortcode: 'dance_ready', mode: 'dance', fetch: false,
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.durationSec, 7.25);
  assert.equal(response.body.analysis, null);
  assert.equal(response.body.videoUrl, response.body.originalVideoUrl);
  const url = new URL(response.body.videoUrl);
  assert.equal(url.pathname + url.search, originalSignedPath('dance_ready', Number(url.searchParams.get('exp'))));
  const media = await appRequest(f.app, { path: url.pathname + url.search });
  assert.equal(media.status, 200);
  assert.equal(media.text, '0123456789');
  assert.equal(analyses, 0);
  assert.equal(lookups, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM film_react_analysis').get().n, 0);
  assert.ok(fs.existsSync(path.join(f.dir, 'dance_ready.mp4.dance')));
  assert.deepEqual(f.calls, []);
  const react = await f.request('POST', '/film/v1/react-reference', { shortcode: 'dance_ready', mode: 'react' });
  assert.equal(react.status, 202);
  assert.equal(analyses, 1, 'explicit React still requests analysis of a dance original');
});

test('dance fetch requests suppress analysis and keep fetching and fetch-false responses', async t => {
  const calls = [];
  const f = await fixture(t, { request: async (shortcode, options) => {
    assert.ok(fs.existsSync(path.join(f.dir, `${shortcode}.mp4.dance`)), 'mark dance before fetching');
    calls.push({ shortcode, options });
    return { state: 'fetching', launched: true };
  } }, { request: async () => assert.fail('dance must not request analysis') });
  assert.deepEqual((await f.request('POST', '/film/v1/react-reference', {
    shortcode: 'dance_fetch', mode: 'dance',
  })).body, { state: 'fetching' });
  assert.deepEqual(calls, [{ shortcode: 'dance_fetch', options: { analyze: false } }]);
  f.reference('dance_pending', 'fetching', false);
  for (const shortcode of ['dance_pending', 'dance_missing']) {
    const response = await f.request('POST', '/film/v1/react-reference', { shortcode, mode: 'dance', fetch: false });
    assert.equal(response.status, shortcode === 'dance_pending' ? 202 : 404);
    assert.deepEqual(response.body, shortcode === 'dance_pending'
      ? { state: 'fetching' } : { error: 'reel_not_available' });
  }
  assert.equal(calls.length, 1);
});

test('react-reference rejects every mode other than react, dance or the omitted default', async t => {
  const f = await fixture(t, { request: async () => assert.fail('invalid mode must not fetch') }, {
    request: async () => assert.fail('invalid mode must not analyze'),
  });
  for (const mode of [null, '', 'Dance', 'solo', 0, false, {}, [], ['dance']]) {
    const response = await f.request('POST', '/film/v1/react-reference', { shortcode: 'valid_mode', mode });
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: 'invalid_mode' });
  }
  assert.deepEqual(fs.readdirSync(f.dir), [], 'invalid requests never write dance markers');
});

test('failed or timed-out analysis serves original with null analysis for posts and fetched refs', async t => {
  const f = await fixture(t);
  f.reference('failed_analysis', 'ready');
  f.db.prepare('INSERT INTO posts (id,shortcode) VALUES (?,?)').run(42, 'pinned_analysis');
  fs.writeFileSync(path.join(f.dir, 'pinned_analysis.mp4'), 'pinned original');
  for (const shortcode of ['failed_analysis', 'pinned_analysis']) {
    const response = await f.request('POST', '/film/v1/react-reference', { shortcode });
    assert.equal(response.status, 200);
    assert.equal(response.body.analysis, null);
    const url = new URL(response.body.videoUrl);
    assert.equal(url.pathname, `/film/v1/react-media/${shortcode}`);
    const originalUrl = new URL(response.body.originalVideoUrl);
    assert.equal(originalUrl.pathname + originalUrl.search,
      originalSignedPath(shortcode, Number(originalUrl.searchParams.get('exp'))));
    const media = await appRequest(f.app, { path: url.pathname + url.search });
    assert.equal(media.status, 200);
    assert.equal(media.text, shortcode === 'pinned_analysis' ? 'pinned original' : '0123456789');
    const original = await appRequest(f.app, { path: originalUrl.pathname + originalUrl.search });
    assert.equal(original.status, 200);
    assert.equal(original.text, media.text, 'without analysis both URLs serve the original pin');
  }
});

test('analysis errors cannot block an available reference or its signed media', async t => {
  const f = await fixture(t, undefined, {
    request: async () => { throw new Error('private provider error'); },
    getResult: async () => { throw new Error('private analysis error'); },
  });
  f.reference('broken_analysis', 'ready');
  const response = await f.request('POST', '/film/v1/react-reference', { shortcode: 'broken_analysis' });
  assert.equal(response.status, 200);
  assert.equal(response.body.analysis, null);
  assert.ok(!JSON.stringify(response.body).includes('private'));
  const url = new URL(response.body.videoUrl);
  const media = await appRequest(f.app, { path: url.pathname + url.search });
  assert.equal(media.status, 200);
  assert.equal(media.text, '0123456789');
});

test('unknown React references return fetching and delegate to the fetch worker', async t => {
  const f = await fixture(t);
  const response = await f.request('POST', '/film/v1/react-reference', { shortcode: 'unknown_123' });
  assert.equal(response.status, 202);
  assert.deepEqual(response.body, { state: 'fetching' });
  assert.deepEqual(f.calls, ['unknown_123']);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM posts').get().count, 0);
});

test('fetch false reports existing fetches without worker, budget, cap or ledger activity', async t => {
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
    const fetching = shortcode === 'fetching_123';
    assert.equal(response.status, fetching ? 202 : 404, shortcode);
    assert.deepEqual(response.body, fetching ? { state: 'fetching' } : { error: 'reel_not_available' });
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
    assert.equal(launchCount, 3, 'recent failed references do not launch again after the generic fallback');
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
  for (const url of [signedPath('ready_123'), originalSignedPath('ready_123')]) {
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
  }
});

test('original media signatures bind the variant and reject malformed variant queries', async t => {
  let analysisLookups = 0;
  const f = await fixture(t, undefined, {
    request: async () => ({ state: 'failed', analysis: null }),
    getResult: async () => { analysisLookups++; throw new Error('original media must not read analysis'); },
  });
  f.reference('bound_123', 'ready');
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const ready = signedPath('bound_123', exp);
  const original = originalSignedPath('bound_123', exp);
  for (const url of [
    `${ready}&variant=original`, original.replace('variant=original&', ''),
    `${original}&variant=original`, `${original}&variant=`,
    original.replace('variant=original', 'variant='),
    original.replace('variant=original', 'variant=ready'),
    original.replace('variant=original', 'variant=Original'),
    original.replace('variant=original', 'variant=original%20'),
    original.replace('variant=original', 'variant[]=original'),
    original.replace('variant=original', 'variant[value]=original'),
    original.replace('variant=original', 'variant=original&variant[]=original'),
    original.replace(`exp=${exp}`, `exp=${Math.floor(Date.now() / 1000)}`),
    original.replace('/bound_123?', '/other_123?'),
  ]) {
    const response = await appRequest(f.app, { path: url });
    assert.equal(response.status, 403, url);
    assert.deepEqual(response.body, { error: 'invalid_signature' });
  }
  const response = await appRequest(f.app, { path: original });
  assert.equal(response.status, 200);
  assert.equal(response.text, '0123456789');
  assert.equal(analysisLookups, 0, 'signature rejection and original serving precede analysis lookup');
});

test('original media serves an existing post pin even when ready analysis is present', async t => {
  let analysisLookups = 0;
  const f = await fixture(t, undefined, {
    request: async () => ({ state: 'ready', analysis: { creatorMuted: true }, path: path.join(f.dir, 'post_original.react.mp4') }),
    getResult: async () => { analysisLookups++; return { state: 'ready', analysis: { creatorMuted: true },
      path: path.join(f.dir, 'post_original.react.mp4') }; },
  });
  f.db.prepare('INSERT INTO posts (id,shortcode) VALUES (?,?)').run(43, 'post_original');
  fs.writeFileSync(path.join(f.dir, 'post_original.mp4'), 'post original with creator');
  fs.writeFileSync(path.join(f.dir, 'post_original.react.mp4'), 'post ready without creator');
  const response = await f.request('POST', '/film/v1/react-reference', { shortcode: 'post_original' });
  assert.equal(response.status, 200);
  for (const [field, expected] of [['originalVideoUrl', 'post original with creator'], ['videoUrl', 'post ready without creator']]) {
    const url = new URL(response.body[field]);
    const media = await appRequest(f.app, { path: url.pathname + url.search });
    assert.equal(media.status, 200);
    assert.equal(media.text, expected);
  }
  assert.equal(analysisLookups, 1, 'only the React-ready URL reads analysis');
});

const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
test('original signed MP4 keeps creator audio byte-for-byte while the ready variant stays muted',
  { skip: !ffmpegAvailable, timeout: 30000 }, async t => {
    const f = await fixture(t, undefined, {
      request: async () => ({ state: 'ready', analysis: { creatorMuted: true }, path: readyFile }),
      getResult: async () => ({ state: 'ready', analysis: { creatorMuted: true }, path: readyFile }),
    });
    f.reference('audio_123', 'ready', false);
    const originalFile = path.join(f.dir, 'audio_123.mp4');
    const readyFile = path.join(f.dir, 'audio_123.react.mp4');
    const run = args => {
      const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args],
        { maxBuffer: 4 * 1024 * 1024 });
      assert.equal(result.status, 0, result.stderr?.toString() || result.error?.message);
      return result.stdout;
    };
    run(['-f', 'lavfi', '-i', 'color=c=blue:s=64x96:r=10:d=1.2', '-f', 'lavfi', '-i',
      'sine=frequency=440:sample_rate=48000:duration=1.2', '-c:v', 'libx264', '-threads', '1',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', originalFile]);
    run(['-i', originalFile, '-c:v', 'copy', '-af', 'volume=0', '-c:a', 'aac', '-movflags', '+faststart', readyFile]);
    const response = await f.request('POST', '/film/v1/react-reference', { shortcode: 'audio_123' });
    assert.equal(response.status, 200);
    const audioLevels = {};
    for (const [field, file] of [['originalVideoUrl', originalFile], ['videoUrl', readyFile]]) {
      const url = new URL(response.body[field]);
      const media = await appRequest(f.app, { path: url.pathname + url.search });
      assert.equal(media.status, 200);
      assert.equal(media.headers['content-type'], 'video/mp4');
      assert.deepEqual(media.buffer, fs.readFileSync(file), `${field} serves exactly the published MP4`);
      const receivedFile = path.join(f.dir, `${field}.received.mp4`);
      fs.writeFileSync(receivedFile, media.buffer);
      const pcm = run(['-i', receivedFile, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1']);
      assert.ok(pcm.length >= 48000 * 4, 'the served MP4 contains a decodable audio track');
      let squared = 0;
      for (let offset = 0; offset < pcm.length; offset += 4) squared += pcm.readFloatLE(offset) ** 2;
      audioLevels[field] = Math.sqrt(squared / (pcm.length / 4));
    }
    assert.ok(audioLevels.originalVideoUrl > 0.05, `creator audio is audible: RMS=${audioLevels.originalVideoUrl}`);
    assert.ok(audioLevels.videoUrl < 0.00001, `ready creator audio stays muted: RMS=${audioLevels.videoUrl}`);
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
    for (const url of [signedPath(shortcode), originalSignedPath(shortcode)]) {
      const response = await appRequest(f.app, { path: url });
      assert.equal(response.status, 404, shortcode);
      assert.deepEqual(response.body, { error: 'reel_not_available' });
    }
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

test('prefetch queues a section of references and drains serially by default', async t => {
  const f = await fixture(t);
  const shortcodes = Array.from({ length: 18 }, (_, index) => `serial_${String(index).padStart(2, '0')}`);
  const launches = [], completed = [], releases = new Map(), waiters = new Map();
  let downloading = 0, releaseAll = false;
  const worker = createReactFetchWorker({ pool: f.pool, env: { REACT_REF_DIR: f.dir, APIFY_API_KEY: 'fake-key' },
    apify: {
      startRun: async (actor, input) => {
        const shortcode = new URL(input.directUrls[0]).pathname.split('/')[2];
        launches.push(shortcode);
        return { id: shortcode, status: 'SUCCEEDED' };
      },
      getItems: async () => [{ videoUrl: 'https://video.cdninstagram.com/video.mp4' }],
    },
    download: async (post, { videoDir }) => {
      downloading++;
      const held = releaseAll ? Promise.resolve() : new Promise(resolve => releases.set(post.shortcode, resolve));
      waiters.get(downloading)?.();
      await held;
      fs.writeFileSync(path.join(videoDir, `${post.shortcode}.mp4`), '0123456789');
      completed.push(post.shortcode);
      return { status: 'cached' };
    },
    probe: async () => ({ durationSec: 4.5 }), budgetStatus: async () => ({ blocked: false }),
    recordRunLaunch: async () => {}, recordRunCompletion: async () => {},
  });
  const app = express();
  registerFilmApi(app, { pool: f.pool, reactWorker: { enqueue: async () => {} }, reactFetchWorker: worker });
  const prefetch = () => appRequest(app, { method: 'POST', path: '/film/v1/react-prefetch',
    body: { shortcodes }, headers: { Authorization: 'Bearer api-key' } });
  const waitForDownload = count => downloading >= count ? Promise.resolve()
    : new Promise(resolve => waiters.set(count, resolve));
  try {
    const response = await prefetch();
    assert.equal(response.status, 202);
    assert.deepEqual(response.body, { queued: 18 });
    await waitForDownload(1);
    assert.deepEqual(launches, [shortcodes[0]], 'the other 17 references wait in the queue');
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM film_react_refs WHERE state='fetching'").get().count, 18);
    assert.deepEqual((await prefetch()).body, { queued: 0 }, 'queued references are deduplicated');
    for (let index = 0; index < shortcodes.length; index++) {
      await waitForDownload(index + 1);
      assert.deepEqual(launches, shortcodes.slice(0, index + 1), 'the next run waits for the preceding download');
      assert.deepEqual(completed, shortcodes.slice(0, index));
      releases.get(shortcodes[index])();
    }
    await worker.waitForIdle();
    assert.deepEqual(completed, shortcodes);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM film_react_refs WHERE state='ready'").get().count, 18);
  } finally {
    releaseAll = true;
    for (const release of releases.values()) release();
    await worker.waitForIdle();
  }
});
