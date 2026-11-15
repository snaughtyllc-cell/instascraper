const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const Database = require('better-sqlite3');
const { ensureFilmTables } = require('./film-migration');
// scraper's production DB singleton must never open the developer database here.
const sqlitePath = process.env.SQLITE_PATH;
process.env.SQLITE_PATH = ':memory:';
const { createReactFetchWorker, downloadReference, allowedVideoUrl } = require('./react-fetch');
if (sqlitePath === undefined) delete process.env.SQLITE_PATH;
else process.env.SQLITE_PATH = sqlitePath;

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, options = {}) {
  const db = new Database(':memory:');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'react-fetch-test-'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  db.exec('CREATE TABLE models (id INTEGER PRIMARY KEY); CREATE TABLE posts (shortcode TEXT PRIMARY KEY)');
  const pool = { query: async (sql, values = []) => {
    assert.deepEqual([...sql.matchAll(/\$(\d+)/g)].map(match => Number(match[1])), values.map((_, index) => index + 1));
    const stmt = db.prepare(sql.replace(/\$\d+/g, '?'));
    if (stmt.reader) { const rows = stmt.all(...values); return { rows, rowCount: rows.length }; }
    const info = stmt.run(...values);
    return { rows: [], rowCount: info.changes };
  } };
  let transactions = Promise.resolve();
  pool.transaction = work => {
    const pending = transactions.then(async () => {
      db.exec('BEGIN');
      try { const result = await work(pool); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    });
    transactions = pending.catch(() => {});
    return pending;
  };
  await ensureFilmTables(pool, { isPg: false });
  let time = Date.UTC(2026, 0, 2);
  const launches = [], completions = [], probes = [];
  const dependencies = { pool, env: { REACT_REF_DIR: dir }, now: () => time,
    budgetStatus: async () => ({ over: false }),
    recordRunLaunch: async (_pool, info) => launches.push(info),
    recordRunCompletion: async (_pool, info) => completions.push(info),
    apify: { startRun: async (actor, input) => ({ id: `run-${launches.length}`, status: 'SUCCEEDED', usageTotalUsd: 0.002 }),
      getItems: async () => [{ videoUrl: 'https://video.cdninstagram.com/reel.mp4' }] },
    download: async (post, opts) => {
      const file = path.join(opts.videoDir, `${post.shortcode}.mp4`);
      fs.writeFileSync(file, 'video');
      return { status: 'cached', path: file };
    }, probe: async (file, opts) => { probes.push({ file, opts }); return { durationSec: 4.5 }; } };
  const worker = createReactFetchWorker({ ...dependencies, ...options,
    env: { ...dependencies.env, ...options.env } });
  return { db, pool, dir, worker, launches, completions, probes, dependencies,
    advance: ms => { time += ms; }, time: () => time };
}

test('unknown references atomically dedupe concurrent calls and publish ready pins without posts', async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => f.worker.request('fresh_reel')));
  assert.equal(results.filter(result => result.launched).length, 1);
  assert.ok(results.every(result => result.state === 'fetching'));
  await f.worker.waitForIdle();
  assert.equal(f.launches.length, 1);
  assert.equal(f.launches[0].actorId, 'apify~instagram-scraper');
  assert.equal(f.launches[0].purpose, 'react_ref');
  assert.equal(f.launches[0].query, 'reel:fresh_reel');
  assert.equal(f.completions[0].status, 'succeeded');
  assert.deepEqual(await f.worker.request('fresh_reel'), { state: 'ready', durationSec: 4.5, launched: false });
  assert.equal(fs.readFileSync(path.join(f.dir, 'fresh_reel.mp4'), 'utf8'), 'video');
  assert.deepEqual(fs.readdirSync(f.dir), ['fresh_reel.mp4']);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM posts').get().n, 0);
  assert.equal(f.probes[0].opts.nice, 10);
  assert.ok(f.probes[0].opts.timeoutMs <= 180000);
});

test('separate workers share an atomic cap and shortcode claim', async t => {
  const f = await fixture(t, { env: { REACT_FETCH_DAILY_MAX: '1' } });
  const second = createReactFetchWorker({ ...f.dependencies, env: { ...f.dependencies.env, REACT_FETCH_DAILY_MAX: '1' } });
  const results = await Promise.all([f.worker.request('first_ref'), second.request('first_ref'), second.request('second_ref')]);
  assert.equal(results.filter(result => result.launched).length, 1);
  await Promise.all([f.worker.waitForIdle(), second.waitForIdle()]);
  assert.equal(f.launches.length, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM film_react_ref_attempts').get().n, 1);
});

test('retry after six hours retains every launch in the rolling daily cap', async t => {
  const f = await fixture(t, { env: { REACT_FETCH_DAILY_MAX: '2' },
    apify: { startRun: async () => ({ id: 'failed-run', status: 'SUCCEEDED' }), getItems: async () => [{ error: 'not_found' }] } });
  await f.worker.request('failed_ref');
  await f.worker.waitForIdle();
  assert.equal(f.db.prepare('SELECT error FROM film_react_refs').get().error, 'apify_error_stub');
  assert.deepEqual(await f.worker.request('failed_ref'), { state: 'unavailable', launched: false });
  f.advance(6 * 3600000);
  assert.equal((await f.worker.request('failed_ref')).launched, true);
  await f.worker.waitForIdle();
  f.advance(6 * 3600000);
  assert.deepEqual(await f.worker.request('failed_ref'), { state: 'unavailable', launched: false });
  assert.equal(f.launches.length, 2);
  f.advance(12 * 3600000 + 1);
  assert.equal((await f.worker.request('failed_ref')).launched, true);
  await f.worker.waitForIdle();
  assert.equal(f.launches.length, 3);
});

test('budget over and zero daily cap reject without creating references or launching', async t => {
  for (const options of [{ budgetStatus: async () => ({ over: true }) }, { env: { REACT_FETCH_DAILY_MAX: '0' } }]) {
    const f = await fixture(t, options);
    assert.deepEqual(await f.worker.request('blocked_ref'), { state: 'unavailable', launched: false });
    assert.equal(f.launches.length, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM film_react_refs').get().n, 0);
  }
});

test('error stubs, absent videos, oversized downloads and invalid probe results fail with static codes', async t => {
  const scenarios = [
    { items: [{ requestErrorMessages: ['https://secret.example/token'] }], code: 'apify_error_stub' },
    { items: [{}], code: 'no_video' },
    { items: [], code: 'no_video' },
    { download: async () => ({ status: 'skipped', error: 'signed url too large' }), code: 'download_too_large' },
    { probe: async () => ({ durationSec: NaN }), code: 'invalid_video' },
    { probe: async () => { throw new Error('secret signed url'); }, code: 'fetch_failed' },
  ];
  for (const scenario of scenarios) {
    const overrides = { ...scenario };
    if (scenario.items) overrides.apify = { startRun: async () => ({ id: 'test-run', status: 'SUCCEEDED' }),
      getItems: async () => scenario.items };
    const f = await fixture(t, overrides);
    await f.worker.request('broken_ref');
    await f.worker.waitForIdle();
    assert.equal(f.db.prepare('SELECT error FROM film_react_refs').get().error, scenario.code);
    assert.deepEqual(await f.worker.request('broken_ref'), { state: 'unavailable', launched: false });
    assert.deepEqual(fs.readdirSync(f.dir), []);
  }
});

test('stale recovery permits immediate retry and fresh boot orphans recover once they age', async t => {
  const f = await fixture(t);
  const old = new Date(f.time() - 11 * 60000).toISOString(), fresh = new Date(f.time()).toISOString();
  f.db.prepare("INSERT INTO film_react_refs (shortcode,state,attempts,updated_at) VALUES (?,'fetching',1,?)").run('stale_ref', old);
  f.db.prepare("INSERT INTO film_react_refs (shortcode,state,attempts,updated_at) VALUES (?,'fetching',1,?)").run('fresh_ref', fresh);
  f.db.prepare('INSERT INTO film_react_ref_attempts VALUES (?,?,?,NULL)').run('stale-reservation', 'stale_ref', old);
  await f.worker.start();
  assert.equal(f.db.prepare("SELECT error FROM film_react_refs WHERE shortcode='stale_ref'").get().error, 'worker_restarted');
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM film_react_ref_attempts").get().n, 0);
  assert.equal((await f.worker.request('stale_ref')).launched, true);
  assert.equal((await f.worker.request('fresh_ref')).launched, false);
  await f.worker.waitForIdle();
  f.advance(11 * 60000);
  assert.equal((await f.worker.request('fresh_ref')).launched, true);
  await f.worker.waitForIdle();
  assert.equal(f.launches.length, 2);
});

test('a concurrent heartbeat prevents startup and request recovery from stealing a live claim', async t => {
  for (const recoverAtStartup of [true, false]) {
    const f = await fixture(t);
    if (!recoverAtStartup) await f.worker.start();
    const old = new Date(f.time() - 11 * 60000).toISOString();
    f.db.prepare("INSERT INTO film_react_refs (shortcode,state,attempts,updated_at) VALUES ('live_ref','fetching',1,?)").run(old);
    f.db.prepare('INSERT INTO film_react_ref_attempts VALUES (?,?,?,NULL)').run('live-reservation', 'live_ref', old);
    const query = f.pool.query;
    let heartbeat = false;
    f.pool.query = async (sql, values) => {
      if (/UPDATE film_react_refs SET state='failed', error='worker_restarted'/.test(sql)) {
        heartbeat = true;
        f.db.prepare("UPDATE film_react_refs SET updated_at=? WHERE shortcode='live_ref'").run(new Date(f.time()).toISOString());
      }
      return query(sql, values);
    };
    assert.deepEqual(await f.worker.request('live_ref'), { state: 'fetching', launched: false });
    assert.equal(heartbeat, true);
    assert.equal(f.db.prepare('SELECT state FROM film_react_refs').get().state, 'fetching');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM film_react_ref_attempts').get().n, 1);
    assert.equal(f.launches.length, 0);
  }
});

test('fresh boot orphans release reservations even when a different shortcode is requested', async t => {
  const f = await fixture(t, { env: { REACT_FETCH_DAILY_MAX: '1' } });
  const stamp = new Date(f.time()).toISOString();
  f.db.prepare("INSERT INTO film_react_refs (shortcode,state,attempts,updated_at) VALUES ('orphan_ref','fetching',1,?)").run(stamp);
  f.db.prepare('INSERT INTO film_react_ref_attempts VALUES (?,?,?,NULL)').run('orphan-reservation', 'orphan_ref', stamp);
  await f.worker.start();
  f.advance(11 * 60000);
  assert.equal((await f.worker.request('another_ref')).launched, true);
  await f.worker.waitForIdle();
  assert.equal(f.db.prepare("SELECT error FROM film_react_refs WHERE shortcode='orphan_ref'").get().error, 'worker_restarted');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM film_react_ref_attempts').get().n, 1);
  assert.equal(f.launches.length, 1);
});

test('timeout during final database publication rolls back ready and publishes no pin', async t => {
  const f = await fixture(t, { env: { REACT_FETCH_TIMEOUT_SEC: '0.01' } });
  const query = f.pool.query;
  f.pool.query = async (sql, values) => {
    if (/UPDATE film_react_refs SET state='ready'/.test(sql)) await new Promise(resolve => setTimeout(resolve, 30));
    return query(sql, values);
  };
  await f.worker.request('slow_db_ref');
  await f.worker.waitForIdle();
  assert.equal(f.db.prepare('SELECT state FROM film_react_refs').get().state, 'failed');
  assert.equal(f.db.prepare('SELECT error FROM film_react_refs').get().error, 'fetch_timeout');
  assert.deepEqual(fs.readdirSync(f.dir), []);
});

test('run-claim budget failures persist failed and release unstarted cap reservations', async t => {
  let calls = 0;
  const f = await fixture(t, { budgetStatus: async () => {
    if (++calls === 1) return { over: false };
    throw new Error('database credential must not be exposed');
  } });
  assert.equal((await f.worker.request('budget_ref')).launched, true);
  await f.worker.waitForIdle();
  assert.equal(f.db.prepare('SELECT error FROM film_react_refs').get().error, 'fetch_failed');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM film_react_ref_attempts').get().n, 0);
  assert.equal(f.launches.length, 0);
});

test('deadline fails a hanging download and prevents any late file publication', async t => {
  const gate = deferred();
  const f = await fixture(t, { env: { REACT_FETCH_TIMEOUT_SEC: '0.02' }, download: async (post, opts) => {
    await gate.promise;
    if (fs.existsSync(opts.videoDir)) fs.writeFileSync(path.join(opts.videoDir, `${post.shortcode}.mp4`), 'late');
    return { status: 'cached' };
  } });
  await f.worker.request('timed_ref');
  await f.worker.waitForIdle();
  assert.equal(f.db.prepare('SELECT error FROM film_react_refs').get().error, 'fetch_timeout');
  gate.resolve();
  await tick();
  assert.deepEqual(fs.readdirSync(f.dir), []);
  assert.equal(f.db.prepare('SELECT state FROM film_react_refs').get().state, 'failed');
});

test('timed out remote runs abort, and unknown terminal state stays in budget ledger', async t => {
  for (const terminal of [true, false]) {
    const aborts = [];
    const f = await fixture(t, { env: { REACT_FETCH_TIMEOUT_SEC: '0.01' },
      apify: { startRun: async () => ({ id: 'remote-run', status: 'RUNNING' }),
        getRun: async () => new Promise(() => {}),
        abortRun: async id => { aborts.push(id); return { id, status: terminal ? 'ABORTED' : 'ABORTING' }; } } });
    await f.worker.request('remote_ref');
    await f.worker.waitForIdle();
    assert.deepEqual(aborts, ['remote-run']);
    assert.equal(f.completions.length, terminal ? 1 : 0);
  }
});

test('a launch ledger insert finishing after timeout is completed only after its row exists', async t => {
  const gate = deferred(), events = [];
  const f = await fixture(t, { env: { REACT_FETCH_TIMEOUT_SEC: '0.01' },
    recordRunLaunch: async () => { await gate.promise; events.push('launch'); },
    recordRunCompletion: async () => { events.push('complete'); } });
  await f.worker.request('slow_ledger_ref');
  await f.worker.waitForIdle();
  assert.deepEqual(events, []);
  gate.resolve();
  await tick();
  assert.deepEqual(events, ['launch', 'complete']);
  assert.equal(f.db.prepare('SELECT error FROM film_react_refs').get().error, 'fetch_timeout');
  assert.deepEqual(fs.readdirSync(f.dir), []);
});

test('missing ready files refetch and invalid shortcodes never create rows', async t => {
  const f = await fixture(t);
  f.db.prepare("INSERT INTO film_react_refs (shortcode,state,duration_sec) VALUES ('missing_ref','ready',3)").run();
  for (const shortcode of ['../bad', 'tiny', null, 'a'.repeat(65)]) assert.equal((await f.worker.request(shortcode)).state, 'unavailable');
  assert.equal((await f.worker.request('missing_ref')).launched, true);
  await f.worker.waitForIdle();
  assert.equal(f.launches.length, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM film_react_refs').get().n, 1);
});

test('concurrency stays at most two and invalid fractional configuration makes progress', async t => {
  for (const configured of ['0.5', '9', '1']) {
    const gate = deferred();
    let active = 0, peak = 0;
    const f = await fixture(t, { env: { REACT_FETCH_CONCURRENCY: configured }, download: async (post, opts) => {
      active++; peak = Math.max(peak, active);
      await gate.promise;
      fs.writeFileSync(path.join(opts.videoDir, `${post.shortcode}.mp4`), 'video');
      active--;
      return { status: 'cached' };
    } });
    await Promise.all(['queue_one', 'queue_two', 'queue_three'].map(code => f.worker.request(code)));
    await tick();
    assert.equal(active, configured === '1' ? 1 : 2);
    gate.resolve();
    await f.worker.waitForIdle();
    assert.ok(peak <= 2);
  }
});

function response(status, body = 'video', headers = { 'content-type': 'video/mp4' }) {
  return { status, ok: status >= 200 && status < 300, headers: { get: name => headers[name] || null },
    body: Readable.from([body]) };
}

test('existing capped downloader enforces video type/host/size and retries only transient statuses', async t => {
  const f = await fixture(t);
  const post = { shortcode: 'download_ref', video_url: 'https://video.cdninstagram.com/video.mp4?secret=value' };
  let calls = 0;
  const options = { videoDir: f.dir, sleep: async () => {}, fetchImpl: async (_url, opts) => {
    assert.equal(opts.redirect, 'manual');
    calls++;
    return response(calls < 3 ? calls === 1 ? 429 : 503 : 200);
  } };
  assert.equal((await downloadReference(post, options)).status, 'cached');
  assert.equal(calls, 3);
  fs.rmSync(path.join(f.dir, 'download_ref.mp4'));
  for (const rejected of [response(403), response(302), response(200, 'video', {}),
    response(200, 'html', { 'content-type': 'text/html' }),
    response(200, 'video', { 'content-type': 'video/mp4', 'content-length': String(61 * 1024 * 1024) })]) {
    calls = 0;
    await assert.rejects(downloadReference(post, { ...options, fetchImpl: async () => { calls++; return rejected; } }));
    assert.equal(calls, 1);
    assert.deepEqual(fs.readdirSync(f.dir), []);
  }
  for (const url of ['http://video.cdninstagram.com/a', 'https://cdninstagram.com.evil.test/a', 'https://localhost/a',
    'https://user:secret@video.cdninstagram.com/a', 'https://video.cdninstagram.com:8443/a', 'file:///etc/passwd']) {
    assert.equal(allowedVideoUrl(url), false);
    await assert.rejects(downloadReference({ ...post, video_url: url }, options), { code: 'invalid_video_url' });
  }
});

test('production Apify transport uses bearer auth, bounded retries, actor timeout and exact input', async t => {
  const requests = [];
  let starts = 0;
  const f = await fixture(t, { apify: undefined, env: { APIFY_API_KEY: 'secret-token', REACT_FETCH_TIMEOUT_SEC: '12' },
    sleep: async () => {}, fetchImpl: async (url, opts) => {
      requests.push({ url, opts });
      if (url.includes('/acts/')) {
        starts++;
        if (starts === 1) return response(503);
        return { ok: true, json: async () => ({ data: { id: 'api-run', status: 'SUCCEEDED', usageTotalUsd: 0.003 } }) };
      }
      return { ok: true, json: async () => [{ videoUrl: 'https://video.fbcdn.net/video.mp4' }] };
    } });
  await f.worker.request('apify_ref');
  await f.worker.waitForIdle();
  assert.equal(starts, 2);
  assert.ok(requests.every(request => !request.url.includes('secret-token') && request.opts.headers.Authorization === 'Bearer secret-token'));
  assert.match(requests[0].url, /apify~instagram-scraper\/runs\?timeout=12$/);
  assert.deepEqual(JSON.parse(requests[0].opts.body), {
    directUrls: ['https://www.instagram.com/reel/apify_ref/'], resultsType: 'posts', resultsLimit: 1,
  });
  assert.equal(f.db.prepare('SELECT state FROM film_react_refs').get().state, 'ready');
});

test('production Apify transport never retries forbidden responses', async t => {
  let calls = 0;
  const f = await fixture(t, { apify: undefined, env: { APIFY_API_KEY: 'secret-token' },
    fetchImpl: async () => { calls++; return response(403); } });
  await f.worker.request('forbidden_ref');
  await f.worker.waitForIdle();
  assert.equal(calls, 1);
  assert.equal(f.launches.length, 0);
  assert.equal(f.db.prepare('SELECT error FROM film_react_refs').get().error, 'apify_failed');
});
