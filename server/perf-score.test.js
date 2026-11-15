const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { computePerfScores, refreshPerfScores } = require('./perf-score');

function viewRows(views) {
  return views.map((view_count, index) => ({ id: index + 1, view_count }));
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function setMinReels(t, value) {
  const original = process.env.PERF_MIN_REELS;
  if (value === undefined) delete process.env.PERF_MIN_REELS;
  else process.env.PERF_MIN_REELS = value;
  t.after(() => {
    if (original === undefined) delete process.env.PERF_MIN_REELS;
    else process.env.PERF_MIN_REELS = original;
  });
}

function makeDb(t, { pgReal = false } = {}) {
  const sqlite = new Database(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec(`CREATE TABLE posts (id INTEGER PRIMARY KEY, account_handle TEXT,
    view_count INTEGER, perf_score REAL, archived INTEGER DEFAULT 0,
    soft_deleted INTEGER DEFAULT 0)`);
  return { sqlite, query: async (sql, params = []) => {
    const numbers = [...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
    assert.deepEqual(numbers, params.map((_, index) => index + 1), 'SQLite parameter order');
    const stmt = sqlite.prepare(sql.replace(/\$\d+/g, '?'));
    if (stmt.reader) {
      const rows = stmt.all(...params);
      return { rows, rowCount: rows.length };
    }
    const storedParams = pgReal && /^UPDATE posts SET perf_score/.test(sql)
      ? params.map((value, index) => (index === 0 || index === 2) && value !== null ? Math.fround(value) : value)
      : params;
    return { rows: [], rowCount: stmt.run(...storedParams).changes };
  } };
}

test('fewer than five eligible reels leaves every score null', () => {
  const rows = viewRows([100, 200, 300, 400, 0, null]);
  assert.deepEqual([...computePerfScores(rows).values()], [null, null, null, null, null, null]);
});

test('uses an even-count median and rounds scores to three decimals', () => {
  const scores = computePerfScores(viewRows([100, 200, 300, 400, 500, 600]));
  assert.deepEqual([...scores.values()], [-1.807, -0.807, -0.222, 0.193, 0.515, 0.778]);
});

test('clamps at two, scores median-equal reels zero, and leaves missing views null', () => {
  const rows = viewRows([1, 100, 100, 100, 10000, 0, null]);
  assert.deepEqual([...computePerfScores(rows).values()], [-2, 0, 0, 0, 2, null, null]);
});

test('supports a minimum override without mutating input and ignores nonfinite views', () => {
  const rows = viewRows(['100', 200, Infinity, NaN, -1]);
  const original = structuredClone(rows);
  assert.deepEqual([...computePerfScores(rows, { minReels: 2 }).values()], [-0.585, 0.415, null, null, null]);
  assert.deepEqual(rows, original);
  assert.deepEqual([...computePerfScores(viewRows([0, null]), { minReels: 0 }).values()], [null, null]);
});

test('refresh writes active rows only, scopes and deduplicates handles, and is idempotent', async (t) => {
  setMinReels(t, undefined);
  const pool = makeDb(t);
  pool.sqlite.exec(`INSERT INTO posts (id, account_handle, view_count, perf_score, archived, soft_deleted) VALUES
    (1, 'a', 25, NULL, 0, 0), (2, 'a', 100, NULL, 0, 0), (3, 'a', 100, NULL, 0, 0),
    (4, 'a', 200, NULL, 0, 0), (5, 'a', 300, NULL, NULL, NULL), (6, 'a', 0, 1, 0, 0),
    (7, 'a', 100000, 9, 1, 0), (8, 'a', 200000, 8, 0, 1),
    (9, 'b', 100, 7, 0, 0)`);
  assert.deepEqual(await refreshPerfScores(pool, ['a', 'a', '', null]), { handles: 1, updated: 6 });
  assert.deepEqual(pool.sqlite.prepare('SELECT perf_score FROM posts ORDER BY id').all().map((row) => row.perf_score),
    [-2, 0, 0, 1, 1.585, null, 9, 8, 7]);
  assert.deepEqual(await refreshPerfScores(pool, ['a']), { handles: 1, updated: 0 });
  pool.sqlite.prepare('UPDATE posts SET view_count = 0 WHERE id = 5').run();
  assert.deepEqual(await refreshPerfScores(pool, ['a']), { handles: 1, updated: 5 });
  assert.deepEqual(pool.sqlite.prepare('SELECT perf_score FROM posts WHERE id <= 6').all().map((row) => row.perf_score),
    [null, null, null, null, null, null]);
});

test('null handles refreshes every creator and an empty list refreshes none', async (t) => {
  setMinReels(t, undefined);
  const pool = makeDb(t);
  pool.sqlite.exec(`INSERT INTO posts (id, account_handle, view_count, perf_score) VALUES
    (1, 'a', 100, 1), (2, 'b', 200, 2), (3, 'a', 300, NULL)`);
  assert.deepEqual(await refreshPerfScores(pool, []), { handles: 0, updated: 0 });
  assert.deepEqual(await refreshPerfScores(pool), { handles: 2, updated: 2 });
  assert.deepEqual(await refreshPerfScores(pool), { handles: 2, updated: 0 });
});

test('PERF_MIN_REELS changes the refresh minimum and invalid values use five', async (t) => {
  setMinReels(t, '2');
  const pool = makeDb(t);
  pool.sqlite.exec(`INSERT INTO posts (id, account_handle, view_count) VALUES (1, 'a', 100), (2, 'a', 200)`);
  assert.deepEqual(await refreshPerfScores(pool), { handles: 1, updated: 2 });
  assert.deepEqual(pool.sqlite.prepare('SELECT perf_score FROM posts ORDER BY id').all().map((row) => row.perf_score),
    [-0.585, 0.415]);
  for (const value of ['0', '-1', 'invalid', '1.5', 'Infinity', '']) {
    process.env.PERF_MIN_REELS = value;
    await refreshPerfScores(pool);
    assert.deepEqual(pool.sqlite.prepare('SELECT perf_score FROM posts').all().map((row) => row.perf_score), [null, null]);
  }
});

test('PostgreSQL REAL precision does not produce repeat writes', async (t) => {
  setMinReels(t, undefined);
  const pool = makeDb(t, { pgReal: true });
  pool.sqlite.exec(`INSERT INTO posts (id, account_handle, view_count) VALUES
    (1, 'a', 100), (2, 'a', 100), (3, 'a', 100), (4, 'a', 200), (5, 'a', 300)`);
  assert.deepEqual(await refreshPerfScores(pool), { handles: 1, updated: 5 });
  assert.equal(pool.sqlite.prepare('SELECT perf_score FROM posts WHERE id = 5').get().perf_score, Math.fround(1.585));
  assert.deepEqual(await refreshPerfScores(pool), { handles: 1, updated: 0 });
  pool.sqlite.prepare('UPDATE posts SET view_count = 75 WHERE id = 3').run();
  assert.deepEqual(await refreshPerfScores(pool), { handles: 1, updated: 1 });
});

test('concurrent refreshes write each changed score once, including transitions to null', async (t) => {
  setMinReels(t, undefined);
  for (const pgReal of [false, true]) {
    const pool = makeDb(t, { pgReal });
    pool.sqlite.exec(`INSERT INTO posts (id, account_handle, view_count) VALUES
      (1, 'a', 100), (2, 'a', 100), (3, 'a', 100), (4, 'a', 200), (5, 'a', 300)`);
    const results = await Promise.all([refreshPerfScores(pool), refreshPerfScores(pool)]);
    assert.equal(results.reduce((total, result) => total + result.updated, 0), 5);
    pool.sqlite.prepare('UPDATE posts SET view_count = 0 WHERE id = 5').run();
    const cleared = await Promise.all([refreshPerfScores(pool), refreshPerfScores(pool)]);
    assert.equal(cleared.reduce((total, result) => total + result.updated, 0), 5);
    assert.deepEqual(pool.sqlite.prepare('SELECT perf_score FROM posts').all().map((row) => row.perf_score),
      [null, null, null, null, null]);
    assert.deepEqual(await refreshPerfScores(pool), { handles: 1, updated: 0 });
  }
});

test('an overlapping refresh reads new views after an older snapshot finishes writing', async (t) => {
  setMinReels(t, undefined);
  const pool = makeDb(t);
  pool.sqlite.exec(`INSERT INTO posts (id, account_handle, view_count) VALUES
    (1, 'a', 100), (2, 'a', 100), (3, 'a', 100), (4, 'a', 100), (5, 'a', 100)`);
  const query = pool.query;
  const paused = deferred();
  const released = deferred();
  let reads = 0;
  let pauseFirstUpdate = true;
  pool.query = async (sql, params = []) => {
    if (sql.startsWith('SELECT id, view_count')) reads += 1;
    if (sql.startsWith('UPDATE posts SET perf_score') && pauseFirstUpdate) {
      pauseFirstUpdate = false;
      paused.resolve();
      await released.promise;
    }
    return query(sql, params);
  };
  const backfill = refreshPerfScores(pool, ['a']);
  await paused.promise;
  pool.sqlite.prepare('UPDATE posts SET view_count = 400 WHERE id = 1').run();
  const scrapeRefresh = refreshPerfScores(pool, ['a']);
  await new Promise(setImmediate);
  const readsBeforeRelease = reads;
  released.resolve();
  await Promise.all([backfill, scrapeRefresh]);
  assert.equal(pool.sqlite.prepare('SELECT perf_score FROM posts WHERE id = 1').get().perf_score, 2);
  assert.equal(readsBeforeRelease, 1, 'the later refresh must wait before reading views');
});

test('a failed handle refresh releases its queue and does not block other handles', async (t) => {
  setMinReels(t, '1');
  const pool = makeDb(t);
  pool.sqlite.exec(`INSERT INTO posts (id, account_handle, view_count) VALUES (1, 'a', 100), (2, 'b', 200)`);
  const query = pool.query;
  const paused = deferred();
  const released = deferred();
  let failFirstRead = true;
  pool.query = async (sql, params = []) => {
    if (sql.startsWith('SELECT id, view_count') && params[0] === 'a' && failFirstRead) {
      failFirstRead = false;
      paused.resolve();
      await released.promise;
      throw new Error('creator read failed');
    }
    return query(sql, params);
  };
  const failed = assert.rejects(refreshPerfScores(pool, ['a']), /creator read failed/);
  await paused.promise;
  const queued = refreshPerfScores(pool, ['a']);
  assert.deepEqual(await refreshPerfScores(pool, ['b']), { handles: 1, updated: 1 });
  released.resolve();
  await failed;
  assert.deepEqual(await queued, { handles: 1, updated: 1 });
  assert.deepEqual(await refreshPerfScores(pool, ['a']), { handles: 1, updated: 0 });
});
