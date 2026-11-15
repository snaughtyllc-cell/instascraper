const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { makeSortDb } = require('./test-support/sort-db');
const { runLookBackfill, lookBackfillEstimate } = require('./look-backfill');
const { runAutoSort, sortUsage } = require('./sort-runner');
const { sortConfig } = require('./sort-status');

async function setup(t, count = 2) {
  const pool = await makeSortDb();
  const videoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'look-backfill-'));
  t.after(async () => { pool.sqlite.close(); await fs.rm(videoDir, { recursive: true, force: true }); });
  for (let id = 1; id <= count; id++) {
    pool.sqlite.prepare(`INSERT INTO posts(id,shortcode,account_handle,posted_at,video_cache_status,sort_status,
      content_type,ai_type,ai_description,ai_attempts,ai_error) VALUES(?,?,?,'2026-11-15','cached','manual','dance','talking','Original',2,'Original error')`)
      .run(id, `reel-${id}`, 'creator');
    await fs.writeFile(path.join(videoDir, `${id}.mp4`), 'fake video');
  }
  return { pool, videoDir, cfg: { ...sortConfig({ GEMINI_API_KEY: 'fake' }), enabled: true },
    describe: async () => ({ type: 'talking', confidence: 0.2, lookTags: ['brunette'], usage: { inTokens: 3400, outTokens: 100 } }) };
}

test('backfill writes look tags and the layout included in the video description', async t => {
  const deps = await setup(t, 1);
  const describe = deps.describe;
  deps.describe = async input => ({ ...await describe(input), layout: 'split_screen' });
  const before = deps.pool.sqlite.prepare('SELECT * FROM posts').get();
  assert.deepEqual(await runLookBackfill(deps), { tagged: 1, errored: 0, skippedCap: 0 });
  assert.deepEqual(deps.pool.sqlite.prepare('SELECT * FROM posts').get(), { ...before, ai_look_tags: '["brunette"]', ai_layout: 'split_screen' });
  const usage = await sortUsage(deps.pool, deps.cfg);
  assert.equal(usage.reels30d, 1);
  assert.equal(usage.today, 1);
  assert.ok(Math.abs(usage.usd30d - 0.00127) < 1e-10);
});

test('look backfill replaces stale layout only when the describe returns a valid layout', async t => {
  const deps = await setup(t, 2);
  deps.pool.sqlite.exec("UPDATE posts SET ai_layout='self_filmed'");
  let calls = 0;
  deps.describe = async () => ({ lookTags: ['brunette'], layout: ++calls === 1 ? 'needs_footage' : 'invalid' });
  assert.equal((await runLookBackfill(deps)).tagged, 2);
  assert.deepEqual(deps.pool.sqlite.prepare('SELECT ai_layout FROM posts ORDER BY id DESC').all(), [
    { ai_layout: 'needs_footage' }, { ai_layout: 'self_filmed' },
  ]);
});

test('respects daily cap', async t => {
  const deps = await setup(t);
  deps.cfg.dailyMax = 1;
  assert.deepEqual(await runLookBackfill(deps), { tagged: 1, errored: 0, skippedCap: 1 });
  assert.deepEqual(await runLookBackfill(deps), { tagged: 0, errored: 0, skippedCap: 1 });
  assert.equal((await sortUsage(deps.pool, deps.cfg)).today, 1);
});

test('error marks [] and continues', async t => {
  const deps = await setup(t);
  let calls = 0;
  deps.describe = async () => { if (++calls === 1) throw new Error('Fake Gemini failure'); return { lookTags: ['bedroom'], usage: { inTokens: 20, outTokens: 2 } }; };
  const before = deps.pool.sqlite.prepare('SELECT * FROM posts ORDER BY id DESC').all();
  assert.deepEqual(await runLookBackfill(deps), { tagged: 1, errored: 1, skippedCap: 0 });
  assert.deepEqual(deps.pool.sqlite.prepare('SELECT * FROM posts ORDER BY id DESC').all(), [
    { ...before[0], ai_look_tags: '[]' }, { ...before[1], ai_look_tags: '["bedroom"]' },
  ]);
  assert.equal((await sortUsage(deps.pool, deps.cfg)).today, 2, 'failed descriptions consume the shared cap');
  assert.equal(deps.pool.sqlite.prepare('SELECT COUNT(*) AS n FROM look_backfill_attempts').get().n, 2);
});

test('estimate counts only untagged cached sorted reels', async t => {
  const deps = await setup(t, 8);
  deps.pool.sqlite.exec(`UPDATE posts SET sort_status='auto' WHERE id=1;
    UPDATE posts SET sort_status='needs_look' WHERE id=2;
    UPDATE posts SET sort_status='unsorted' WHERE id=4;
    UPDATE posts SET video_cache_status=NULL WHERE id=5;
    UPDATE posts SET ai_look_tags='[]' WHERE id=6;
    UPDATE posts SET soft_deleted=1 WHERE id=7;
    UPDATE posts SET archived=1 WHERE id=8`);
  const estimate = await lookBackfillEstimate(deps.pool, deps.cfg);
  assert.equal(estimate.count, 3);
  assert.ok(Math.abs(estimate.estUsd - 3 * 0.00502) < 1e-10);
});

test('backfill and regular sort share lock and daily cap', async t => {
  const deps = await setup(t, 2);
  deps.cfg.dailyMax = 1;
  deps.pool.sqlite.exec("UPDATE posts SET sort_status='unsorted',ai_attempts=0 WHERE id=1");
  let start, release;
  const started = new Promise(resolve => { start = resolve; });
  deps.describe = async () => { start(); await new Promise(resolve => { release = resolve; }); return { lookTags: ['brunette'] }; };
  const backfill = runLookBackfill(deps);
  await started;
  const sorting = runAutoSort({ ...deps, waitForIdle: true });
  release();
  assert.equal((await backfill).tagged, 1);
  assert.equal((await sorting).classified, 0);
});

test('missing cached file marks [] without charging a Gemini attempt', async t => {
  const deps = await setup(t, 1);
  await fs.unlink(path.join(deps.videoDir, '1.mp4'));
  deps.describe = async () => assert.fail('missing file must not be described');
  assert.deepEqual(await runLookBackfill(deps), { tagged: 0, errored: 1, skippedCap: 0 });
  assert.equal(deps.pool.sqlite.prepare('SELECT ai_look_tags FROM posts').get().ai_look_tags, '[]');
  assert.equal((await sortUsage(deps.pool, deps.cfg)).today, 0);
});
