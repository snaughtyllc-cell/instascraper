const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { groupSuggestions, redecideNeedsLook, registerSortRoutes } = require('./sort-routes');
const { makeSortDb } = require('./test-support/sort-db');
const { appRequest } = require('./test-support/app-request');
const { sortConfig } = require('./sort-status');

const cfg = { ...sortConfig({ GEMINI_API_KEY: 'fake-key' }), dailyMax: 100 };
function result(type, confidence = 0.9) {
  return { type, confidence, description: 'A person speaking.', suggestedType: null, usage: { inTokens: 10, outTokens: 5 } };
}
async function withApp(pool, work, options = {}) {
  await work(makeRequest(pool, options));
}

function makeRequest(pool, options = {}) {
  const app = express();
  app.use(express.json());
  registerSortRoutes(app, { pool, cfg, redecide: async () => result(null), runAutoSort: async () => ({ classified: 0, errored: 0, skippedCap: 0 }), ...options });
  app.use((error, req, res, next) => res.status(500).json({ error: error.message }));
  return (method, path, body) => appRequest(app, { method, path, body });
}

async function inProcessRequest(pool, method, path, body, options = {}) {
  return makeRequest(pool, options)(method, path, body);
}

test('groupSuggestions merges Lifestyle/lifestyle into one group', () => {
  assert.deepEqual(groupSuggestions([{ ai_suggested_type: 'Lifestyle' }, { ai_suggested_type: 'lifestyle ' }, { ai_suggested_type: null }]),
    [{ value: 'lifestyle', label: 'Lifestyle', count: 2 }]);
});

test('create suggested type reuses existing value', async () => {
  const pool = await makeSortDb();
  pool.sqlite.exec("INSERT INTO posts (id, shortcode, sort_status, ai_suggested_type) VALUES (1, 'a', 'needs_look', 'Talking'), (2, 'b', 'needs_look', 'talking ')");
  await withApp(pool, async (request) => {
    const response = await request('POST', '/sort/suggested-types/talking/create');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { type: { value: 'talking', label: 'Talking' }, assigned: 2 });
    assert.equal(pool.sqlite.prepare('SELECT COUNT(*) AS count FROM content_types').get().count, 2);
    assert.deepEqual(pool.sqlite.prepare('SELECT content_type, sort_status FROM posts').all(), [
      { content_type: 'talking', sort_status: 'manual' }, { content_type: 'talking', sort_status: 'manual' },
    ]);
  });
});

test('redecideNeedsLook promotes confident reels and leaves uncertain reels alone', async () => {
  const pool = await makeSortDb();
  pool.sqlite.exec("INSERT INTO posts (id, sort_status, ai_description, ai_cost_usd) VALUES (1, 'needs_look', 'A person speaking.', 0.001), (2, 'needs_look', 'Unclear.', NULL), (3, 'manual', 'A person speaking.', NULL)");
  const redecide = async ({ description }) => result('talking', description === 'Unclear.' ? 0.5 : 0.9);
  await redecideNeedsLook({ pool, redecide, cfg });
  const rows = pool.sqlite.prepare('SELECT id, content_type, sort_status, ai_cost_usd FROM posts ORDER BY id').all();
  assert.equal(rows[0].content_type, 'talking');
  assert.equal(rows[0].sort_status, 'auto');
  assert.ok(rows[0].ai_cost_usd > 0.001, 'text decision costs accumulate');
  assert.equal(rows[1].content_type, null);
  assert.equal(rows[1].sort_status, 'needs_look');
  assert.equal(rows[2].sort_status, 'manual');
});

test('overlapping redecisions see a type created while the first pass is running', async () => {
  const pool = await makeSortDb();
  pool.sqlite.exec("INSERT INTO posts (id, sort_status, ai_description) VALUES (1, 'needs_look', 'A person speaking.')");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const redecide = async ({ types }) => {
    calls += 1;
    if (calls === 1) await gate;
    return result(types.some((type) => type.value === 'lifestyle') ? 'lifestyle' : null);
  };
  const first = redecideNeedsLook({ pool, redecide, cfg });
  await new Promise((resolve) => setImmediate(resolve));
  pool.sqlite.exec("INSERT INTO content_types (value,label) VALUES ('lifestyle','Lifestyle')");
  const second = redecideNeedsLook({ pool, redecide, cfg });
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 2);
  assert.equal(pool.sqlite.prepare('SELECT content_type FROM posts').get().content_type, 'lifestyle');
});

test('human marking during redecide is never overwritten', async () => {
  const pool = await makeSortDb();
  pool.sqlite.exec("INSERT INTO posts (id, sort_status, ai_description) VALUES (1, 'needs_look', 'A person speaking.')");
  const redecide = async () => {
    pool.sqlite.exec("UPDATE posts SET sort_status = 'manual', content_type = 'dance'");
    return result('talking');
  };
  await redecideNeedsLook({ pool, redecide, cfg });
  assert.deepEqual(pool.sqlite.prepare('SELECT sort_status,content_type FROM posts').get(), { sort_status: 'manual', content_type: 'dance' });
});

test('needs-look endpoint returns grouped suggestions and paginated live posts', async () => {
  const pool = await makeSortDb();
  pool.sqlite.exec("INSERT INTO posts (id, sort_status, ai_suggested_type, archived) VALUES (1, 'needs_look', 'Lifestyle', 0), (2, 'needs_look', 'lifestyle ', 0), (3, 'needs_look', 'Lifestyle', 1)");
  await withApp(pool, async (request) => {
    const response = await request('GET', '/sort/needs-look?page=2&limit=1');
    assert.equal(response.body.total, 2);
    assert.equal(response.body.posts.length, 1);
    assert.deepEqual(response.body.suggestions, [{ value: 'lifestyle', label: 'Lifestyle', count: 2 }]);
  });
});

test('start fresh hides all reels and logs each, leaving tracked creators untouched', async () => {
  const pool = await makeSortDb();
  pool.sqlite.exec("INSERT INTO posts (id, shortcode, soft_deleted) VALUES (1, 'a', 0), (2, 'b', 0), (3, 'c', 1); INSERT INTO tracked_accounts VALUES ('creator')");
  await withApp(pool, async (request) => {
    const preview = await request('GET', '/sort/start-fresh/preview');
    assert.deepEqual(preview.body, { count: 2 });
    assert.equal((await request('POST', '/sort/start-fresh', {})).status, 400);
    assert.equal(pool.sqlite.prepare('SELECT COUNT(*) AS count FROM deletion_log').get().count, 0);
    assert.deepEqual((await request('POST', '/sort/start-fresh', { confirm: true })).body, { hidden: 2 });
    assert.equal(pool.sqlite.prepare('SELECT COUNT(*) AS count FROM posts WHERE soft_deleted = 1').get().count, 3);
    assert.equal(pool.sqlite.prepare("SELECT COUNT(*) AS count FROM deletion_log WHERE reason = 'manual:start_fresh'").get().count, 2);
    assert.equal(pool.sqlite.prepare('SELECT COUNT(*) AS count FROM tracked_accounts').get().count, 1);
    assert.deepEqual((await request('POST', '/sort/start-fresh', { confirm: true })).body, { hidden: 0 });
  });
});

test('start fresh rolls back all changes if a deletion log insert fails', async () => {
  const pool = await makeSortDb();
  pool.sqlite.exec("INSERT INTO posts (id, shortcode) VALUES (1, 'a'), (2, 'b'); CREATE TRIGGER reject_log BEFORE INSERT ON deletion_log WHEN NEW.post_id = 2 BEGIN SELECT RAISE(ABORT, 'test log failure'); END");
  await withApp(pool, async (request) => {
    assert.equal((await request('POST', '/sort/start-fresh', { confirm: true })).status, 500);
    assert.equal(pool.sqlite.prepare('SELECT SUM(soft_deleted) AS count FROM posts').get().count, 0);
    assert.equal(pool.sqlite.prepare('SELECT COUNT(*) AS count FROM deletion_log').get().count, 0);
  });
});

test('start fresh uses two set-based transaction queries and includes every undeleted reel', async () => {
  const pool = await makeSortDb();
  pool.sqlite.exec(`INSERT INTO posts (id, shortcode, account_handle, soft_deleted, archived, sort_status)
    VALUES (1, 'a', 'first', NULL, 0, 'unsorted'), (2, 'b', 'second', 0, 1, 'auto'),
      (3, 'c', 'third', 0, 0, 'manual'), (4, 'd', 'deleted', 1, 0, 'needs_look')`);
  const queries = [];
  const transaction = pool.transaction;
  pool.transaction = (work) => transaction((db) => work({ ...db, query: (sql, params) => {
    queries.push({ sql, params });
    return db.query(sql, params);
  } }));
  const response = await inProcessRequest(pool, 'POST', '/sort/start-fresh', { confirm: true });
  assert.deepEqual(response.body, { hidden: 3 });
  assert.equal(queries.length, 2, 'query count must stay constant as the reel count grows');
  assert.match(queries[0].sql, /INSERT INTO deletion_log[\s\S]+SELECT id, shortcode, account_handle, 'manual:start_fresh' FROM posts/);
  assert.match(queries[1].sql, /UPDATE posts SET soft_deleted = 1, soft_deleted_at = \$1/);
  assert.ok(queries.every(({ sql }) => !/RETURNING/i.test(sql)));
  assert.deepEqual(pool.sqlite.prepare('SELECT post_id, shortcode, account_handle, reason FROM deletion_log ORDER BY post_id').all(), [
    { post_id: 1, shortcode: 'a', account_handle: 'first', reason: 'manual:start_fresh' },
    { post_id: 2, shortcode: 'b', account_handle: 'second', reason: 'manual:start_fresh' },
    { post_id: 3, shortcode: 'c', account_handle: 'third', reason: 'manual:start_fresh' },
  ]);
  const timestamps = pool.sqlite.prepare('SELECT soft_deleted_at FROM posts WHERE id < 4').all();
  assert.ok(timestamps[0].soft_deleted_at);
  assert.ok(timestamps.every((row) => row.soft_deleted_at === timestamps[0].soft_deleted_at));
  assert.equal(pool.sqlite.prepare('SELECT soft_deleted_at FROM posts WHERE id = 4').get().soft_deleted_at, null);
  assert.deepEqual((await inProcessRequest(pool, 'POST', '/sort/start-fresh', { confirm: true })).body, { hidden: 0 });
  assert.equal(pool.sqlite.prepare('SELECT COUNT(*) AS count FROM deletion_log').get().count, 3);
});

test('start fresh rolls back deletion logs when its set-based update fails', async () => {
  const pool = await makeSortDb();
  pool.sqlite.exec(`INSERT INTO posts (id, shortcode) VALUES (1, 'a'), (2, 'b');
    CREATE TRIGGER reject_hide BEFORE UPDATE OF soft_deleted ON posts WHEN NEW.id = 2
    BEGIN SELECT RAISE(ABORT, 'test hide failure'); END`);
  assert.equal((await inProcessRequest(pool, 'POST', '/sort/start-fresh', { confirm: true })).status, 500);
  assert.equal(pool.sqlite.prepare('SELECT SUM(soft_deleted) AS count FROM posts').get().count, 0);
  assert.equal(pool.sqlite.prepare('SELECT COUNT(*) AS count FROM deletion_log').get().count, 0);
});

test('backfill stops after a batch reports consecutive describe failures', async () => {
  const pool = await makeSortDb();
  let calls = 0;
  const response = await inProcessRequest(pool, 'POST', '/sort/backfill', undefined, {
    runAutoSort: async () => {
      calls += 1;
      if (calls > 1) return { classified: 0, errored: 0, skippedCap: 0 };
      return { classified: 0, errored: 3, skippedCap: 0, stoppedOnDescribeErrors: true };
    },
  });
  assert.deepEqual(response.body, { started: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
});

test('backfill returns immediately and stops on an idle runner', async () => {
  const pool = await makeSortDb();
  let calls = 0;
  await withApp(pool, async (request) => {
    assert.deepEqual((await request('POST', '/sort/backfill')).body, { started: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
  }, { runAutoSort: async () => { calls += 1; return { classified: 0, errored: 0, skippedCap: 0 }; } });
});

test('a type trigger at queue completion starts another pass', async () => {
  const pool = await makeSortDb();
  pool.sqlite.exec("INSERT INTO posts (id, sort_status, ai_description) VALUES (1, 'needs_look', 'A person speaking.')");
  let calls = 0;
  let second;
  const redecide = async ({ types }) => {
    calls += 1;
    return result(types.some((type) => type.value === 'lifestyle') ? 'lifestyle' : null);
  };
  const query = pool.query;
  let queued = false;
  pool.query = async (sql, params) => {
    const response = await query(sql, params);
    if (/UPDATE posts SET content_type/.test(sql) && !queued) {
      queued = true;
      return { get rowCount() {
        queueMicrotask(() => {
          pool.sqlite.exec("INSERT INTO content_types (value,label) VALUES ('lifestyle','Lifestyle')");
          second = redecideNeedsLook({ pool, redecide, cfg });
        });
        return response.rowCount;
      } };
    }
    return response;
  };
  await redecideNeedsLook({ pool, redecide, cfg });
  await second;
  assert.equal(calls, 2);
  assert.equal(pool.sqlite.prepare('SELECT content_type FROM posts').get().content_type, 'lifestyle');
});

test('backfill waits for an overlapping automatic sort before finishing catch-up', async () => {
  const pool = await makeSortDb();
  let release;
  const activeSweep = new Promise((resolve) => { release = resolve; });
  let completed = 0;
  const options = [];
  await withApp(pool, async (request) => {
    assert.deepEqual((await request('POST', '/sort/backfill')).body, { started: true });
    assert.deepEqual(options, [true], 'backfill must wait rather than mistake the runner lock for an empty queue');
    assert.equal(completed, 0);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(completed, 2, 'one catch-up batch followed by the actual empty queue');
  }, { runAutoSort: async ({ waitForIdle }) => {
    options.push(waitForIdle);
    if (!waitForIdle) return { classified: 0, errored: 0, skippedCap: 0 };
    await activeSweep;
    completed += 1;
    return { classified: completed === 1 ? 1 : 0, errored: 0, skippedCap: 0 };
  } });
});
