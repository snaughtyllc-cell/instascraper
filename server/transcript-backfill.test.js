const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { makeSortDb } = require('./test-support/sort-db');
const { runTranscriptBackfill, transcriptBackfillEstimate } = require('./transcript-backfill');
const { runAutoSort, sortUsage } = require('./sort-runner');
const { runLookBackfill } = require('./look-backfill');
const { sortConfig } = require('./sort-status');

async function setup(t, count = 2) {
  const pool = await makeSortDb();
  const videoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'transcript-backfill-'));
  t.after(async () => { pool.sqlite.close(); await fs.rm(videoDir, { recursive: true, force: true }); });
  for (let id = 1; id <= count; id++) {
    pool.sqlite.prepare(`INSERT INTO posts(id,shortcode,account_handle,posted_at,video_cache_status,sort_status,
      content_type,ai_type,ai_description,ai_attempts,ai_error,ai_look_tags)
      VALUES(?,?,?,'2026-11-15','cached','manual','talking','dance','Original',2,'Original error','["bedroom"]')`)
      .run(id, `reel-${id}`, 'creator');
    await fs.writeFile(path.join(videoDir, `${id}.mp4`), 'fake video');
  }
  return { pool, videoDir, cfg: { ...sortConfig({ GEMINI_API_KEY: 'fake' }), enabled: true },
    describe: async () => ({ type: 'dance', confidence: 0.2, audioKind: 'own_speech', transcript: 'Hola.\nSin traducir.', lookTags: ['brunette'], usage: { inTokens: 3400, outTokens: 1600 } }) };
}

test('transcript backfill writes speech and layout from the video and records shared usage', async t => {
  const deps = await setup(t, 1);
  const describe = deps.describe;
  deps.describe = async input => ({ ...await describe(input), layout: 'gameplay_overlay' });
  const before = deps.pool.sqlite.prepare('SELECT * FROM posts').get();
  assert.deepEqual(await runTranscriptBackfill(deps), { transcribed: 1, errored: 0, skippedCap: 0 });
  assert.deepEqual(deps.pool.sqlite.prepare('SELECT * FROM posts').get(), { ...before, ai_transcript: 'Hola.\nSin traducir.', ai_layout: 'gameplay_overlay' });
  const usage = await sortUsage(deps.pool, deps.cfg);
  assert.equal(usage.reels30d, 1);
  assert.equal(usage.today, 1);
  assert.ok(Math.abs(usage.usd30d - 0.00502) < 1e-10);
});

test('transcript backfill replaces stale layout only for a valid describe value', async t => {
  const deps = await setup(t, 2);
  deps.pool.sqlite.exec("UPDATE posts SET ai_layout='self_filmed'");
  let calls = 0;
  deps.describe = async () => ({ audioKind: 'own_speech', transcript: 'Hello.', layout: ++calls === 1 ? 'split_screen' : undefined });
  assert.equal((await runTranscriptBackfill(deps)).transcribed, 2);
  assert.deepEqual(deps.pool.sqlite.prepare('SELECT ai_layout FROM posts ORDER BY id DESC').all(), [
    { ai_layout: 'split_screen' }, { ai_layout: 'self_filmed' },
  ]);
});

test('estimate targets only live cached auto/manual talking reels with NULL transcript', async t => {
  const deps = await setup(t, 10);
  deps.pool.sqlite.exec(`UPDATE posts SET sort_status='auto' WHERE id=1;
    UPDATE posts SET sort_status='needs_look' WHERE id=3;
    UPDATE posts SET sort_status='unsorted' WHERE id=4;
    UPDATE posts SET video_cache_status=NULL WHERE id=5;
    UPDATE posts SET ai_transcript='' WHERE id=6;
    UPDATE posts SET ai_transcript='Already transcribed' WHERE id=7;
    UPDATE posts SET content_type='dance',ai_type='talking' WHERE id=8;
    UPDATE posts SET soft_deleted=1 WHERE id=9;
    UPDATE posts SET archived=1 WHERE id=10`);
  const estimate = await transcriptBackfillEstimate(deps.pool, deps.cfg);
  assert.equal(estimate.count, 2);
  assert.ok(Math.abs(estimate.estUsd - 2 * 0.00502) < 1e-10);
  const before = deps.pool.sqlite.prepare('SELECT * FROM posts WHERE id>2 ORDER BY id').all();
  assert.equal((await runTranscriptBackfill(deps)).transcribed, 2);
  assert.deepEqual(deps.pool.sqlite.prepare('SELECT * FROM posts WHERE id>2 ORDER BY id').all(), before);
});

test('transcript backfill respects batch size and shared daily cap across runs', async t => {
  const deps = await setup(t, 4);
  deps.cfg.dailyMax = 2;
  deps.cfg.batch = 1;
  assert.deepEqual(await runTranscriptBackfill(deps), { transcribed: 1, errored: 0, skippedCap: 0 });
  assert.deepEqual(await runTranscriptBackfill(deps), { transcribed: 1, errored: 0, skippedCap: 0 });
  assert.deepEqual(await runTranscriptBackfill(deps), { transcribed: 0, errored: 0, skippedCap: 1 });
  assert.equal((await sortUsage(deps.pool, deps.cfg)).today, 2);
});

test('null, empty speech and errors get a terminal sentinel without changing sort metadata', async t => {
  const deps = await setup(t, 3);
  let calls = 0;
  deps.describe = async () => {
    calls++;
    if (calls === 1) return { transcript: null };
    if (calls === 2) throw new Error('Fake Gemini failure');
    return { transcript: '  ' };
  };
  const before = deps.pool.sqlite.prepare('SELECT * FROM posts ORDER BY id').all();
  assert.deepEqual(await runTranscriptBackfill(deps), { transcribed: 2, errored: 1, skippedCap: 0 });
  assert.deepEqual(deps.pool.sqlite.prepare('SELECT * FROM posts ORDER BY id').all(), before.map(row => ({ ...row, ai_transcript: '' })));
  assert.equal((await transcriptBackfillEstimate(deps.pool, deps.cfg)).count, 0);
  assert.deepEqual(await runTranscriptBackfill(deps), { transcribed: 0, errored: 0, skippedCap: 0 });
  assert.equal(calls, 3);
  assert.equal((await sortUsage(deps.pool, deps.cfg)).today, 3);
});

test('missing cached file gets sentinel without a paid call or endless retries', async t => {
  const deps = await setup(t, 1);
  await fs.unlink(path.join(deps.videoDir, '1.mp4'));
  deps.describe = async () => assert.fail('missing file must not be described');
  assert.deepEqual(await runTranscriptBackfill(deps), { transcribed: 0, errored: 1, skippedCap: 0 });
  assert.equal(deps.pool.sqlite.prepare('SELECT ai_transcript FROM posts').get().ai_transcript, '');
  assert.equal((await sortUsage(deps.pool, deps.cfg)).today, 0);
  assert.equal((await transcriptBackfillEstimate(deps.pool, deps.cfg)).count, 0);
});

test('transcript backfill discards dubbed speech and lyrics even if returned by describe', async t => {
  const deps = await setup(t, 4);
  const kinds = ['music_or_trending_audio', 'other_voice', 'none', undefined];
  deps.describe = async () => ({ audioKind: kinds.shift(), transcript: 'Not their own speech' });
  assert.equal((await runTranscriptBackfill(deps)).transcribed, 4);
  assert.deepEqual(deps.pool.sqlite.prepare('SELECT ai_transcript FROM posts').all(), Array(4).fill({ ai_transcript: '' }));
});

test('rechecks eligibility before writes when a human changes type or transcript during the call', async t => {
  const deps = await setup(t, 2);
  let calls = 0;
  deps.describe = async () => {
    if (++calls === 1) {
      deps.pool.sqlite.exec("UPDATE posts SET content_type='dance' WHERE id=2");
      return { transcript: 'Should not be stored' };
    }
    deps.pool.sqlite.exec("UPDATE posts SET ai_transcript='Human transcript' WHERE id=1");
    throw new Error('Fake Gemini failure');
  };
  assert.deepEqual(await runTranscriptBackfill(deps), { transcribed: 0, errored: 1, skippedCap: 0 });
  assert.deepEqual(deps.pool.sqlite.prepare('SELECT id,content_type,sort_status,ai_transcript FROM posts ORDER BY id').all(), [
    { id: 1, content_type: 'talking', sort_status: 'manual', ai_transcript: 'Human transcript' },
    { id: 2, content_type: 'dance', sort_status: 'manual', ai_transcript: null },
  ]);
});

test('transcripts, look backfill and sorting serialize on the shared lock and cap', async t => {
  const deps = await setup(t, 3);
  deps.cfg.dailyMax = 1;
  deps.pool.sqlite.exec("UPDATE posts SET sort_status='unsorted',ai_attempts=0 WHERE id=1; UPDATE posts SET ai_look_tags=NULL,content_type='dance' WHERE id=2");
  let start, release;
  const started = new Promise(resolve => { start = resolve; });
  deps.describe = async () => { start(); await new Promise(resolve => { release = resolve; }); return { transcript: 'Hello.' }; };
  const transcribing = runTranscriptBackfill(deps);
  await started;
  const sorting = runAutoSort({ ...deps, waitForIdle: true });
  const tagging = runLookBackfill(deps);
  const secondTranscribing = runTranscriptBackfill(deps);
  release();
  assert.equal((await transcribing).transcribed, 1);
  assert.equal((await sorting).classified, 0);
  assert.equal((await tagging).tagged, 0);
  assert.equal((await secondTranscribing).transcribed, 0);
  assert.equal((await sortUsage(deps.pool, deps.cfg)).today, 1);
});

test('disabled transcript backfill makes no database or Gemini calls', async () => {
  const fail = () => assert.fail('disabled job must do no work');
  assert.deepEqual(await runTranscriptBackfill({ cfg: { enabled: false }, pool: { query: fail }, describe: fail }),
    { transcribed: 0, errored: 0, skippedCap: 0 });
});
