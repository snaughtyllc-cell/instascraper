const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { makeSortDb } = require('./test-support/sort-db');
const { layoutRecheckEstimate, runLayoutRecheck } = require('./layout-recheck');
const { runAutoSort, sortUsage, withSortLock } = require('./sort-runner');
const { sortConfig } = require('./sort-status');

async function setup(t, count = 2) {
  const pool = await makeSortDb();
  const videoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'layout-recheck-'));
  t.after(async () => { pool.sqlite.close(); await fs.rm(videoDir, { recursive: true, force: true }); });
  for (let id = 1; id <= count; id++) {
    pool.sqlite.prepare(`INSERT INTO posts(id,shortcode,account_handle,posted_at,video_cache_status,sort_status,
      content_type,ai_type,ai_description,ai_attempts,ai_error,ai_look_tags,ai_audio_kind,ai_transcript)
      VALUES(?,?,?,'2026-11-15','cached','manual','dance','talking','Original',2,'Original error','["bedroom"]','own_speech','Original speech')`)
      .run(id, `reel-${id}`, 'creator');
    await fs.writeFile(path.join(videoDir, `${id}.mp4`), 'fake video');
  }
  return { pool, videoDir, cfg: { ...sortConfig({ GEMINI_API_KEY: 'fake' }), batch: 2 },
    describe: async () => ({ type: 'talking', confidence: 0.2, layout: 'self_filmed', lookTags: ['brunette'],
      transcript: 'Changed speech', usage: { inTokens: 3400, outTokens: 100 } }) };
}

test('layout recheck writes only ai_layout, accounts spend once and a second run is empty', async t => {
  const deps = await setup(t, 1);
  const before = deps.pool.sqlite.prepare('SELECT * FROM posts').get();
  assert.deepEqual(await runLayoutRecheck(deps), { rechecked: 1, errored: 0, skippedCap: 0 });
  assert.deepEqual(deps.pool.sqlite.prepare('SELECT * FROM posts').get(), { ...before, ai_layout: 'self_filmed' });
  const usage = await sortUsage(deps.pool, deps.cfg);
  assert.equal(usage.reels30d, 1);
  assert.equal(usage.today, 1);
  assert.ok(Math.abs(usage.usd30d - 0.00127) < 1e-10);
  assert.deepEqual(await layoutRecheckEstimate(deps.pool, deps.cfg), { count: 0, estUsd: 0 });
  assert.deepEqual(await runLayoutRecheck(deps), { rechecked: 0, errored: 0, skippedCap: 0 });
});

test('layout estimate excludes unsorted, needs-look, uncached, checked, archived and deleted reels', async t => {
  const deps = await setup(t, 8);
  deps.pool.sqlite.exec(`UPDATE posts SET sort_status='auto' WHERE id=1;
    UPDATE posts SET sort_status='needs_look' WHERE id=3;
    UPDATE posts SET sort_status='unsorted' WHERE id=4;
    UPDATE posts SET video_cache_status=NULL WHERE id=5;
    UPDATE posts SET ai_layout='needs_footage' WHERE id=6;
    UPDATE posts SET soft_deleted=1 WHERE id=7;
    UPDATE posts SET archived=1 WHERE id=8`);
  const estimate = await layoutRecheckEstimate(deps.pool, deps.cfg);
  assert.equal(estimate.count, 2);
  assert.ok(Math.abs(estimate.estUsd - 2 * 0.00502) < 1e-10);
});

test('layout recheck processes talking first, newest first and all cfg.batch batches', async t => {
  const deps = await setup(t, 5);
  deps.pool.sqlite.exec(`UPDATE posts SET posted_at='2026-11-14' WHERE id=1;
    UPDATE posts SET content_type='talking',posted_at='2026-11-10' WHERE id=2;
    UPDATE posts SET content_type='talking',posted_at='2026-11-11' WHERE id=3`);
  const seen = [], batchSizes = [];
  const query = deps.pool.query;
  deps.pool.query = async (sql, params) => {
    if (sql.includes('id IN (')) batchSizes.push(params.length);
    return query(sql, params);
  };
  deps.describe = async ({ filePath }) => { seen.push(Number(path.basename(filePath, '.mp4'))); return { layout: 'split_screen' }; };
  assert.deepEqual(await runLayoutRecheck(deps), { rechecked: 5, errored: 0, skippedCap: 0 });
  assert.deepEqual(seen, [3, 2, 5, 4, 1]);
  assert.deepEqual(batchSizes, [2, 2, 1]);
});

test('layout recheck respects shared cap across batches and subsequent runs', async t => {
  const deps = await setup(t, 5);
  deps.cfg.dailyMax = 3;
  assert.deepEqual(await runLayoutRecheck(deps), { rechecked: 3, errored: 0, skippedCap: 2 });
  assert.deepEqual(await runLayoutRecheck(deps), { rechecked: 0, errored: 0, skippedCap: 2 });
  assert.equal((await sortUsage(deps.pool, deps.cfg)).today, 3);
});

test('layout errors and invalid layouts consume cap without post changes or same-job retries', async t => {
  const deps = await setup(t, 4);
  deps.cfg.dailyMax = 3;
  const before = deps.pool.sqlite.prepare('SELECT * FROM posts ORDER BY id').all();
  let calls = 0;
  deps.describe = async () => {
    calls++;
    if (calls === 1) throw new Error('Fake paid failure');
    return { layout: 'invalid', usage: { inTokens: 20, outTokens: 2 } };
  };
  assert.deepEqual(await runLayoutRecheck(deps), { rechecked: 0, errored: 3, skippedCap: 1 });
  assert.equal(calls, 3);
  assert.deepEqual(deps.pool.sqlite.prepare('SELECT * FROM posts ORDER BY id').all(), before);
  assert.equal((await sortUsage(deps.pool, deps.cfg)).today, 3);
  assert.deepEqual(await runLayoutRecheck(deps), { rechecked: 0, errored: 0, skippedCap: 4 });
  assert.equal(calls, 3);
});

test('layout invalid responses are attempted once per explicit job even when there is cap left', async t => {
  const deps = await setup(t, 3);
  let calls = 0;
  deps.describe = async () => { calls++; return { layout: null }; };
  assert.deepEqual(await runLayoutRecheck(deps), { rechecked: 0, errored: 3, skippedCap: 0 });
  assert.equal(calls, 3);
  assert.equal((await layoutRecheckEstimate(deps.pool, deps.cfg)).count, 3);
  deps.describe = async () => ({ layout: 'gameplay_overlay' });
  assert.deepEqual(await runLayoutRecheck(deps), { rechecked: 3, errored: 0, skippedCap: 0 });
  assert.equal((await layoutRecheckEstimate(deps.pool, deps.cfg)).count, 0);
});

test('missing layout cache files do not consume cap or starve later batches', async t => {
  const deps = await setup(t, 3);
  deps.cfg.dailyMax = 1;
  await fs.unlink(path.join(deps.videoDir, '3.mp4'));
  await fs.unlink(path.join(deps.videoDir, '2.mp4'));
  const before = deps.pool.sqlite.prepare('SELECT * FROM posts ORDER BY id').all();
  assert.deepEqual(await runLayoutRecheck(deps), { rechecked: 1, errored: 2, skippedCap: 0 });
  assert.deepEqual(deps.pool.sqlite.prepare('SELECT * FROM posts ORDER BY id').all(), [
    { ...before[0], ai_layout: 'self_filmed' }, before[1], before[2],
  ]);
  assert.equal((await sortUsage(deps.pool, deps.cfg)).today, 1);
});

test('layout recheck revalidates eligibility before spending and preserves concurrent layout edits', async t => {
  const deps = await setup(t, 3);
  const query = deps.pool.query;
  let changed = false;
  deps.pool.query = async (sql, params) => {
    const response = await query(sql, params);
    if (sql.includes('id IN (') && !changed) {
      changed = true;
      deps.pool.sqlite.exec('UPDATE posts SET archived=1 WHERE id=3');
    }
    return response;
  };
  const seen = [];
  deps.describe = async ({ filePath }) => {
    const id = Number(path.basename(filePath, '.mp4'));
    seen.push(id);
    if (id === 2) deps.pool.sqlite.exec("UPDATE posts SET ai_layout='needs_footage' WHERE id=2");
    return { layout: 'self_filmed', usage: { inTokens: 20, outTokens: 2 } };
  };
  assert.deepEqual(await runLayoutRecheck(deps), { rechecked: 1, errored: 0, skippedCap: 0 });
  assert.deepEqual(seen, [2, 1]);
  assert.deepEqual(deps.pool.sqlite.prepare('SELECT ai_layout FROM posts ORDER BY id').all(), [
    { ai_layout: 'self_filmed' }, { ai_layout: 'needs_footage' }, { ai_layout: null },
  ]);
  const usage = await sortUsage(deps.pool, deps.cfg);
  assert.equal(usage.today, 2);
  assert.ok(Math.abs(usage.usd30d - 2 * 0.000011) < 1e-10);
});

test('layout recheck waits for the shared lock and recalculates cap after it is released', async t => {
  const deps = await setup(t, 1);
  deps.cfg.dailyMax = 1;
  let start, release;
  const started = new Promise(resolve => { start = resolve; });
  const sorting = withSortLock(async () => {
    start();
    await new Promise(resolve => { release = resolve; });
    await deps.pool.query('INSERT INTO look_backfill_attempts(post_id,attempted_at,cost_usd) VALUES($1,$2,$3)',
      [1, new Date().toISOString(), 0.01]);
  });
  await started;
  let calls = 0;
  const rechecking = runLayoutRecheck({ ...deps, describe: async () => { calls++; return { layout: 'self_filmed' }; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
  release();
  await sorting;
  assert.deepEqual(await rechecking, { rechecked: 0, errored: 0, skippedCap: 1 });
  assert.equal(calls, 0);
});

test('layout recheck holds the shared lock so regular sorting cannot exceed the cap', async t => {
  const deps = await setup(t, 2);
  deps.cfg.dailyMax = 1;
  deps.pool.sqlite.exec("UPDATE posts SET sort_status='unsorted',ai_attempts=0 WHERE id=1");
  let start, release;
  const started = new Promise(resolve => { start = resolve; });
  deps.describe = async () => { start(); await new Promise(resolve => { release = resolve; }); return { layout: 'self_filmed' }; };
  const rechecking = runLayoutRecheck(deps);
  await started;
  const sorting = runAutoSort({ ...deps, waitForIdle: true });
  release();
  assert.equal((await rechecking).rechecked, 1);
  assert.equal((await sorting).classified, 0);
  assert.equal((await sortUsage(deps.pool, deps.cfg)).today, 1);
});
