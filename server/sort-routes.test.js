const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { groupSuggestions, redecideNeedsLook, registerSortRoutes } = require('./sort-routes');
const { makeSortDb } = require('./test-support/sort-db');
const { appRequest } = require('./test-support/app-request');
const { sortConfig } = require('./sort-status');
const { sortUsage } = require('./sort-runner');

const cfg = { ...sortConfig({ GEMINI_API_KEY: 'fake-key' }), dailyMax: 100 };
function result(type, confidence = 0.9) {
  return { type, confidence, description: 'A person speaking.', audioKind: 'own_speech', suggestedType: null, usage: { inTokens: 10, outTokens: 5 } };
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
  pool.sqlite.exec("INSERT INTO posts (id, sort_status, ai_description, ai_cost_usd, ai_audio_kind) VALUES (1, 'needs_look', 'A person speaking.', 0.001, 'own_speech'), (2, 'needs_look', 'Unclear.', NULL, 'own_speech'), (3, 'manual', 'A person speaking.', NULL, 'own_speech')");
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
test('redecide passes non-custom vocabulary and stores returned look tags', async t => {
  const pool = await makeSortDb();
  t.after(() => pool.sqlite.close());
  pool.sqlite.exec(`CREATE TABLE IF NOT EXISTS look_tags(value TEXT,label TEXT,category TEXT,sort_order INTEGER);
    DELETE FROM look_tags;
    INSERT INTO look_tags(value,label,category) VALUES('bedroom','Bedroom','setting'),('private-custom','Private custom','custom');
    INSERT INTO posts(id,sort_status,ai_description) VALUES(1,'needs_look','A person speaking.')`);
  await redecideNeedsLook({ pool, cfg, redecide: async input => {
    assert.deepEqual(input.lookTags.map(tag => tag.value), ['bedroom']);
    return { ...result('talking'), lookTags: ['bedroom'] };
  } });
  assert.equal(pool.sqlite.prepare('SELECT ai_look_tags FROM posts').get().ai_look_tags, '["bedroom"]');
});

test('look-backfill estimate reports cached sorted untagged reels', async t => {
  const pool = await makeSortDb();
  t.after(() => pool.sqlite.close());
  pool.sqlite.exec("INSERT INTO posts(id,sort_status,video_cache_status) VALUES(1,'manual','cached'),(2,'auto',NULL),(3,'unsorted','cached')");
  const response = await inProcessRequest(pool, 'GET', '/sort/look-backfill/estimate');
  assert.equal(response.status, 200);
  assert.equal(response.body.count, 1);
  assert.ok(Math.abs(response.body.estUsd - 0.00502) < 1e-10);
});

test('look-backfill starts in background, avoids duplicate loops and stops at cap', async t => {
  const pool = await makeSortDb();
  t.after(() => pool.sqlite.close());
  let release;
  const active = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const request = makeRequest(pool, { runLookBackfill: async () => {
    calls++;
    await active;
    return { tagged: 1, errored: 0, skippedCap: 1 };
  } });
  assert.deepEqual((await request('POST', '/sort/look-backfill')).body, { started: true });
  assert.deepEqual((await request('POST', '/sort/look-backfill')).body, { started: true });
  assert.equal(calls, 1);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
});

test('redecide respects the shared daily cap before calling Gemini', async t => {
  const pool = await makeSortDb();
  t.after(() => pool.sqlite.close());
  pool.sqlite.exec("INSERT INTO posts(id,sort_status,ai_description) VALUES(1,'needs_look','Speaking')");
  let calls = 0;
  await redecideNeedsLook({ pool, cfg: { ...cfg, dailyMax: 0 }, redecide: async () => { calls++; return result('talking'); } });
  assert.equal(calls, 0);
});

test('text redecide leaves existing transcripts untouched', async t => {
  const pool = await makeSortDb();
  t.after(() => pool.sqlite.close());
  pool.sqlite.exec("INSERT INTO posts(id,sort_status,ai_description,ai_transcript,ai_audio_kind) VALUES(1,'needs_look','Speaking','Original speech','own_speech'),(2,'needs_look','Speaking','','own_speech')");
  await redecideNeedsLook({ pool, cfg, redecide: async () => ({ ...result('talking'), transcript: 'Invented from description' }) });
  assert.deepEqual(pool.sqlite.prepare('SELECT ai_transcript FROM posts ORDER BY id').all(), [{ ai_transcript: 'Original speech' }, { ai_transcript: '' }]);
});

test('transcript estimate route counts only cached sorted talking reels', async t => {
  const pool = await makeSortDb();
  t.after(() => pool.sqlite.close());
  pool.sqlite.exec("INSERT INTO posts(id,sort_status,video_cache_status,content_type,ai_transcript) VALUES(1,'manual','cached','talking',NULL),(2,'auto','cached','dance',NULL),(3,'needs_look','cached','talking',NULL),(4,'auto','cached','talking','')");
  const response = await inProcessRequest(pool, 'GET', '/sort/transcript-backfill/estimate');
  assert.equal(response.status, 200);
  assert.equal(response.body.count, 1);
  assert.ok(Math.abs(response.body.estUsd - 0.00502) < 1e-10);
});

test('transcript backfill runs in background, avoids duplicate loops and stops at cap', async t => {
  const pool = await makeSortDb();
  t.after(() => pool.sqlite.close());
  let release;
  const active = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const request = makeRequest(pool, { runTranscriptBackfill: async () => {
    calls++;
    await active;
    return { transcribed: 1, errored: 0, skippedCap: 1 };
  } });
  assert.deepEqual((await request('POST', '/sort/transcript-backfill')).body, { started: true });
  assert.deepEqual((await request('POST', '/sort/transcript-backfill')).body, { started: true });
  assert.equal(calls, 1);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
});

test('redecide errors consume the cap and log estimated cost', async t => {
  const pool = await makeSortDb();
  t.after(() => pool.sqlite.close());
  pool.sqlite.exec("INSERT INTO posts(id,sort_status,ai_description) VALUES(1,'needs_look','Speaking'),(2,'needs_look','Speaking')");
  let calls = 0;
  const options = { pool, cfg: { ...cfg, dailyMax: 1 }, redecide: async () => { calls++; throw new Error('Fake paid failure'); } };
  await redecideNeedsLook(options);
  await redecideNeedsLook(options);
  assert.equal(calls, 1);
  const usage = await sortUsage(pool, cfg);
  assert.equal(usage.today, 1);
  assert.equal(usage.reels30d, 1);
  assert.ok(usage.usd30d > 0);
});

test('redecide shares the sort lock and counts successful cost once', async t => {
  const pool = await makeSortDb();
  t.after(() => pool.sqlite.close());
  pool.sqlite.exec("INSERT INTO posts(id,sort_status,ai_description) VALUES(1,'needs_look','Speaking')");
  let start, release;
  const started = new Promise(resolve => { start = resolve; });
  const { withSortLock } = require('./sort-runner');
  const activeSort = withSortLock(async () => { start(); await new Promise(resolve => { release = resolve; }); });
  await started;
  let calls = 0;
  const deciding = redecideNeedsLook({ pool, cfg, redecide: async () => { calls++; return result('talking'); } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
  release();
  await activeSort;
  await deciding;
  const usage = await sortUsage(pool, cfg);
  assert.equal(usage.today, 1);
  const post = pool.sqlite.prepare('SELECT ai_cost_usd FROM posts').get();
  assert.ok(Math.abs(usage.usd30d - post.ai_cost_usd) < 1e-10);
});

test('text redecide preserves stored audio evidence and clears transcripts without known own speech', async t => {
  const pool = await makeSortDb();
  t.after(() => pool.sqlite.close());
  pool.sqlite.exec(`INSERT INTO content_types(value,label,description) VALUES('lipsync','Lip sync','Mouths recorded audio.');
    UPDATE content_types SET description='Own live speech.' WHERE value='talking';
    INSERT INTO posts(id,sort_status,ai_description,ai_audio_kind,ai_transcript)
    VALUES(1,'needs_look','Speaking','music_or_trending_audio','Lyrics'),
      (2,'needs_look','Speaking',NULL,'Unverified speech'),
      (3,'needs_look','Speaking','own_speech','Original speech')`);
  const inputs = [];
  await redecideNeedsLook({ pool, cfg, redecide: async input => {
    inputs.push(input);
    return { ...result('talking'), audioKind: 'own_speech', transcript: 'Invented transcript' };
  } });
  assert.deepEqual(inputs.map(input => input.audioKind), ['music_or_trending_audio', null, 'own_speech']);
  assert.equal(inputs[0].types.find(type => type.value === 'talking').description, 'Own live speech.');
  assert.deepEqual(pool.sqlite.prepare('SELECT content_type,sort_status,ai_audio_kind,ai_transcript FROM posts ORDER BY id').all(), [
    { content_type: 'lipsync', sort_status: 'auto', ai_audio_kind: 'music_or_trending_audio', ai_transcript: null },
    { content_type: null, sort_status: 'needs_look', ai_audio_kind: null, ai_transcript: null },
    { content_type: 'talking', sort_status: 'auto', ai_audio_kind: 'own_speech', ai_transcript: 'Original speech' },
  ]);
});

test('talking recheck estimate excludes manual reels and includes workspace priority count', async t => {
  const pool = await makeSortDb();
  t.after(() => pool.sqlite.close());
  pool.sqlite.exec(`INSERT INTO models(id) VALUES(7);
    INSERT INTO model_creators(model_id,username) VALUES(7,'creator');
    INSERT INTO posts(id,sort_status,video_cache_status,content_type,account_handle)
    VALUES(1,'manual','cached','talking','creator'),(2,'auto','cached','talking','creator'),
      (3,'auto','cached','talking','another'),(4,'auto','cached','dance','creator')`);
  const response = await inProcessRequest(pool, 'GET', '/sort/talking-recheck/estimate?modelId=7');
  assert.equal(response.status, 200);
  assert.equal(response.body.count, 2);
  assert.equal(response.body.priorityCount, 1);
  assert.ok(Math.abs(response.body.estUsd - 2 * 0.00502) < 1e-10);
});

test('talking recheck requires confirmation and validates optional workspace model', async t => {
  const pool = await makeSortDb();
  t.after(() => pool.sqlite.close());
  let calls = 0;
  const request = makeRequest(pool, { runTalkingRecheck: async () => { calls++; } });
  assert.equal((await request('POST', '/sort/talking-recheck', {})).status, 400);
  for (const modelId of ['0', '-1', '1x', '1.5', '2147483648', '9007199254740992']) {
    assert.equal((await request('GET', `/sort/talking-recheck/estimate?modelId=${modelId}`)).status, 400);
    assert.equal((await request('POST', `/sort/talking-recheck?modelId=${modelId}`, { confirm: true })).status, 400);
  }
  assert.equal((await request('GET', '/sort/talking-recheck/estimate?modelId=999')).status, 404);
  assert.equal((await request('POST', '/sort/talking-recheck?modelId=999', { confirm: true })).status, 404);
  assert.equal(calls, 0);
});

test('talking recheck starts one background job and does not loop on still-talking results', async t => {
  const pool = await makeSortDb();
  t.after(() => pool.sqlite.close());
  pool.sqlite.exec('INSERT INTO models(id) VALUES(7)');
  let release;
  const active = new Promise(resolve => { release = resolve; });
  const options = [];
  const request = makeRequest(pool, { runTalkingRecheck: async input => {
    options.push(input);
    await active;
    return { rechecked: 1, auto: 1, needsLook: 0, errored: 0, skippedCap: 0 };
  } });
  assert.deepEqual((await request('POST', '/sort/talking-recheck?modelId=7', { confirm: true })).body, { started: true });
  assert.deepEqual((await request('POST', '/sort/talking-recheck', { confirm: true })).body, { started: true });
  assert.equal(options.length, 1);
  assert.equal(options[0].modelId, 7);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(options.length, 1, 'one run owns its finite candidate snapshot');
  assert.deepEqual((await request('POST', '/sort/talking-recheck', { confirm: true })).body, { started: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(options.length, 2, 'a later explicit confirmation may start another job');
});
