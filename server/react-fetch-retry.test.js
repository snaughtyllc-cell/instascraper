const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { ensureFilmTables } = require('./film-migration');
const sqlitePath = process.env.SQLITE_PATH;
process.env.SQLITE_PATH = ':memory:';
const { createReactFetchWorker } = require('./react-fetch');
if (sqlitePath === undefined) delete process.env.SQLITE_PATH;
else process.env.SQLITE_PATH = sqlitePath;

const TEN_MINUTES = 10 * 60 * 1000;
const SIX_HOURS = 6 * 60 * 60 * 1000;

async function fixture(t, options = {}) {
  const db = new Database(':memory:');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'react-fetch-retry-'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  db.exec(`CREATE TABLE models (id INTEGER PRIMARY KEY); CREATE TABLE posts (shortcode TEXT PRIMARY KEY);
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
  let time = Date.UTC(2026, 0, 2), starts = 0;
  const launches = [];
  const worker = createReactFetchWorker({ pool, now: () => time,
    env: { REACT_REF_DIR: dir, ...options.env },
    budgetStatus: async () => ({ over: false }),
    recordRunLaunch: async (_pool, info) => {
      launches.push(info);
      db.prepare('INSERT INTO apify_runs VALUES (?, ?, ?, ?)')
        .run(info.runId, info.purpose, info.query, new Date(info.nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z'));
    }, recordRunCompletion: async () => {},
    apify: options.apify || {
      startRun: async () => ({ id: `run-${++starts}`, status: 'SUCCEEDED' }),
      getItems: async () => [{ videoUrl: 'https://video.cdninstagram.com/reel.mp4' }],
    },
    download: async (post, opts) => {
      fs.writeFileSync(path.join(opts.videoDir, `${post.shortcode}.mp4`), 'video');
      return { status: 'cached' };
    }, probe: async () => ({ durationSec: 3 }),
  });
  function failed(shortcode, code, age, { charged = false, actualRun = false } = {}) {
    const stamp = new Date(time - age).toISOString();
    db.prepare("INSERT INTO film_react_refs (shortcode,state,error,attempts,created_at,updated_at) VALUES (?,'failed',?,1,?,?)")
      .run(shortcode, code, stamp, stamp);
    if (charged) db.prepare('INSERT INTO film_react_ref_attempts VALUES (?, ?, ?, ?)')
      .run(`old-${shortcode}`, shortcode, stamp, stamp);
    if (actualRun) db.prepare('INSERT INTO apify_runs VALUES (?, ?, ?, ?)')
      .run(`old-run-${shortcode}`, 'react_ref', `reel:${shortcode}`, stamp.replace(/\.\d{3}Z$/, 'Z'));
  }
  return { db, worker, launches, failed, advance: ms => { time += ms; } };
}

test('transient failure codes become retryable at ten minutes', async t => {
  const f = await fixture(t);
  for (const code of ['apify_failed', 'apify_busy', 'apify_network', 'fetch_timeout', 'worker_restarted']) {
    const shortcode = `retry_${code}`;
    f.failed(shortcode, code, TEN_MINUTES - 1);
    assert.deepEqual(await f.worker.request(shortcode), { state: 'unavailable', launched: false }, code);
    f.advance(1);
    assert.deepEqual(await f.worker.request(shortcode), { state: 'fetching', launched: true }, code);
    await f.worker.waitForIdle();
  }
  assert.equal(f.launches.length, 5);
});

test('permanent failure codes retain the six-hour retry window', async t => {
  const f = await fixture(t);
  for (const code of ['no_video', 'apify_error_stub', 'download_too_large', 'invalid_video_type']) {
    const shortcode = `retry_${code}`;
    f.failed(shortcode, code, TEN_MINUTES);
    assert.deepEqual(await f.worker.request(shortcode), { state: 'unavailable', launched: false }, code);
    f.advance(SIX_HOURS - TEN_MINUTES - 1);
    assert.deepEqual(await f.worker.request(shortcode), { state: 'unavailable', launched: false }, code);
    f.advance(1);
    assert.deepEqual(await f.worker.request(shortcode), { state: 'fetching', launched: true }, code);
    await f.worker.waitForIdle();
  }
  assert.equal(f.launches.length, 4);
});

test('old apify_failed cohort releases rejected launches before the daily cap', async t => {
  const f = await fixture(t, { env: { REACT_FETCH_DAILY_MAX: '1' } });
  for (let index = 0; index < 18; index++) f.failed(`old_ref_${index}`, 'apify_failed', TEN_MINUTES, { charged: true });
  assert.deepEqual(await f.worker.request('old_ref_0'), { state: 'fetching', launched: true });
  await f.worker.waitForIdle();
  assert.equal(f.launches.length, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM film_react_ref_attempts').get().n, 1);
  assert.deepEqual(await f.worker.request('old_ref_1'), { state: 'unavailable', launched: false });
  assert.equal(f.launches.length, 1);
});

test('legacy apify_failed attempts with real launches still consume the daily cap', async t => {
  const f = await fixture(t, { env: { REACT_FETCH_DAILY_MAX: '1' } });
  f.failed('launched_ref', 'apify_failed', TEN_MINUTES, { charged: true, actualRun: true });
  assert.deepEqual(await f.worker.request('launched_ref'), { state: 'unavailable', launched: false });
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM film_react_ref_attempts').get().n, 1);
  assert.equal(f.launches.length, 0);
});

test('rejected new Apify starts do not consume the launch cap on retry', async t => {
  let starts = 0;
  const f = await fixture(t, { env: { REACT_FETCH_DAILY_MAX: '1' }, apify: {
    startRun: async () => {
      if (++starts === 1) throw Object.assign(new Error('apify_failed'), { code: 'apify_failed' });
      return { id: 'accepted-run', status: 'SUCCEEDED' };
    }, getItems: async () => [{ videoUrl: 'https://video.cdninstagram.com/reel.mp4' }],
  } });
  await f.worker.request('rejected_ref');
  await f.worker.waitForIdle();
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM film_react_ref_attempts').get().n, 0);
  f.advance(TEN_MINUTES);
  assert.deepEqual(await f.worker.request('rejected_ref'), { state: 'fetching', launched: true });
  await f.worker.waitForIdle();
  assert.equal(f.launches.length, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM film_react_ref_attempts').get().n, 1);
});
