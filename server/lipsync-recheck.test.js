const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { makeSortDb } = require('./test-support/sort-db');
const { runLipSyncRecheck, lipSyncRecheckEstimate } = require('./lipsync-recheck');
const { sortUsage, withSortLock } = require('./sort-runner');
const { sortConfig } = require('./sort-status');

const spokenWords = 'Here are the words of this recorded speech that people keep mouthing again.';
const liveSpeech = () => ({ verdict: 'live_speech', confidence: 0.95, evidence: ['Matching room noise.'],
  words: 'Fresh detector words.', usage: { inTokens: 3400, outTokens: 100 } });

function lipSyncPrices(t, input = '', output = '') {
  for (const [key, value] of [['LIPSYNC_PRICE_IN_PER_M', input], ['LIPSYNC_PRICE_OUT_PER_M', output]]) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
}

async function setup(t, count = 2) {
  const pool = await makeSortDb();
  const videoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lipsync-recheck-'));
  t.after(async () => { pool.sqlite.close(); await fs.rm(videoDir, { recursive: true, force: true }); });
  pool.sqlite.exec("INSERT INTO content_types(value,label) VALUES('lipsync','Lip sync')");
  for (let id = 1; id <= count; id++) {
    pool.sqlite.prepare(`INSERT INTO posts(id,shortcode,account_handle,caption,posted_at,video_cache_status,
      sort_status,content_type,ai_transcript,ai_audio_kind,ai_cost_usd)
      VALUES(?,?,?,?,?,'cached','auto','talking','Original short transcript','own_speech',0.001)`)
      .run(id, `reel-${id}`, `creator-${id}`, `caption-${id}`, `2026-11-${String(id).padStart(2, '0')}`);
    await fs.writeFile(path.join(videoDir, `${id}.mp4`), 'fake video');
  }
  return { pool, videoDir, cfg: { ...sortConfig({ GEMINI_API_KEY: 'fake' }), enabled: true }, detect: liveSpeech };
}

test('lip-sync recheck stores verdict and mouthed words, accounts for spend once, and does not repeat checked reels', async t => {
  const deps = await setup(t, 1);
  deps.detect = async input => {
    assert.equal(input.caption, 'caption-1');
    assert.equal(input.handle, 'creator-1');
    assert.equal(input.filePath, path.join(deps.videoDir, '1.mp4'));
    return { ...liveSpeech(), verdict: 'lip_sync', evidence: ['A recognizable TV soundbite.'], words: spokenWords };
  };
  assert.deepEqual(await runLipSyncRecheck(deps), { rechecked: 1, auto: 1, needsLook: 0, errored: 0, skippedCap: 0 });
  const row = deps.pool.sqlite.prepare('SELECT * FROM posts').get();
  assert.equal(row.content_type, 'lipsync');
  assert.equal(row.sort_status, 'auto');
  assert.equal(row.ai_transcript, spokenWords);
  assert.equal(row.ai_lipsync_verdict, 'lip_sync');
  assert.equal(row.ai_lipsync_confidence, 0.95);
  assert.deepEqual(JSON.parse(row.ai_lipsync_evidence), ['A recognizable TV soundbite.']);
  assert.ok(row.ai_lipsync_checked_at);
  assert.equal(row.lipsync_repeat_of, null);
  assert.equal(deps.pool.sqlite.prepare('SELECT cost_usd FROM look_backfill_attempts').get().cost_usd, 0);
  const usage = await sortUsage(deps.pool, deps.cfg);
  assert.equal(usage.today, 1);
  assert.ok(Math.abs(usage.usd30d - row.ai_cost_usd) < 1e-10);
  assert.equal((await lipSyncRecheckEstimate(deps.pool, deps.cfg)).count, 0);
  assert.deepEqual(await runLipSyncRecheck({ ...deps, detect: () => assert.fail('already checked') }),
    { rechecked: 0, auto: 0, needsLook: 0, errored: 0, skippedCap: 0 });
});

test('live speech preserves the transcript; unsure and weak verdicts retain type and suggest lip sync', async t => {
  const deps = await setup(t, 3);
  deps.detect = async ({ handle }) => handle === 'creator-1' ? liveSpeech()
    : { ...liveSpeech(), verdict: handle === 'creator-2' ? 'unsure' : 'lip_sync', confidence: 0.4 };
  assert.deepEqual(await runLipSyncRecheck(deps), { rechecked: 3, auto: 1, needsLook: 2, errored: 0, skippedCap: 0 });
  const rows = deps.pool.sqlite.prepare('SELECT content_type,sort_status,ai_suggested_type,ai_transcript FROM posts ORDER BY id').all();
  assert.deepEqual(rows, [
    { content_type: 'talking', sort_status: 'auto', ai_suggested_type: null, ai_transcript: 'Original short transcript' },
    ...Array(2).fill({ content_type: 'talking', sort_status: 'needs_look', ai_suggested_type: 'lipsync', ai_transcript: 'Original short transcript' }),
  ]);
  assert.equal((await lipSyncRecheckEstimate(deps.pool, deps.cfg)).count, 0);
});

test('estimate and job exclude manual, checked, non-talking, uncached, archived, deleted and needs-look rows', async t => {
  lipSyncPrices(t);
  const deps = await setup(t, 8);
  deps.pool.sqlite.exec(`UPDATE posts SET sort_status='manual' WHERE id=2;
    UPDATE posts SET ai_lipsync_checked_at='2026-11-15' WHERE id=3;
    UPDATE posts SET content_type='dance' WHERE id=4;
    UPDATE posts SET video_cache_status=NULL WHERE id=5;
    UPDATE posts SET archived=1 WHERE id=6;
    UPDATE posts SET soft_deleted=1 WHERE id=7;
    UPDATE posts SET sort_status='needs_look' WHERE id=8`);
  const before = deps.pool.sqlite.prepare('SELECT * FROM posts WHERE id>1 ORDER BY id').all();
  const estimate = await lipSyncRecheckEstimate(deps.pool, deps.cfg);
  assert.equal(estimate.count, 1);
  assert.equal(estimate.priorityCount, 0);
  assert.ok(Math.abs(estimate.estUsd - 0.0122) < 1e-10);
  assert.equal((await runLipSyncRecheck(deps)).rechecked, 1);
  assert.deepEqual(deps.pool.sqlite.prepare('SELECT * FROM posts WHERE id>1 ORDER BY id').all(), before);
});

test('detector token usage uses dedicated prices independently of sorter prices', async t => {
  lipSyncPrices(t, '2', '10');
  const deps = await setup(t, 1);
  deps.cfg.priceInPerM = 0.01;
  deps.cfg.priceOutPerM = 0.02;
  deps.detect = async () => ({ ...liveSpeech(), usage: { inTokens: 1200, outTokens: 80 } });
  assert.equal((await runLipSyncRecheck(deps)).rechecked, 1);
  const post = deps.pool.sqlite.prepare('SELECT ai_cost_usd FROM posts').get();
  assert.ok(Math.abs(post.ai_cost_usd - (0.001 + 0.0032)) < 1e-10);
  assert.equal(deps.pool.sqlite.prepare('SELECT cost_usd FROM look_backfill_attempts').get().cost_usd, 0);
  assert.ok(Math.abs((await sortUsage(deps.pool, deps.cfg)).usd30d - post.ai_cost_usd) < 1e-10);
});

test('workspace creators run first, then newest, and the shared daily cap applies to the ledger', async t => {
  const deps = await setup(t, 4);
  deps.pool.sqlite.exec("INSERT INTO model_creators(model_id,username) VALUES(7,'CREATOR-1'); INSERT INTO look_backfill_attempts(post_id,attempted_at) VALUES(99,'2999-01-01')");
  deps.cfg.dailyMax = 3;
  const estimate = await lipSyncRecheckEstimate(deps.pool, deps.cfg, { modelId: 7 });
  assert.equal(estimate.count, 4);
  assert.equal(estimate.priorityCount, 1);
  const handles = [];
  deps.detect = async ({ handle }) => { handles.push(handle); return liveSpeech(); };
  assert.deepEqual(await runLipSyncRecheck({ ...deps, modelId: 7 }),
    { rechecked: 2, auto: 2, needsLook: 0, errored: 0, skippedCap: 2 });
  assert.deepEqual(handles, ['creator-1', 'creator-4']);
  assert.equal((await sortUsage(deps.pool, deps.cfg)).today, 3);
  assert.equal((await runLipSyncRecheck(deps)).rechecked, 0);
  assert.equal(handles.length, 2);
});

test('manual changes during detection and before a queued row are never overwritten, and spend remains recorded', async t => {
  const deps = await setup(t, 2);
  const original = deps.pool.sqlite.prepare('SELECT * FROM posts ORDER BY id').all();
  let calls = 0;
  deps.detect = async () => {
    calls++;
    deps.pool.sqlite.exec("UPDATE posts SET sort_status='manual',content_type='dance',ai_transcript='Human transcript'");
    return { ...liveSpeech(), verdict: 'lip_sync', words: spokenWords };
  };
  assert.equal((await runLipSyncRecheck(deps)).rechecked, 0);
  assert.equal(calls, 1);
  assert.deepEqual(deps.pool.sqlite.prepare('SELECT * FROM posts ORDER BY id').all(),
    original.map(row => ({ ...row, sort_status: 'manual', content_type: 'dance', ai_transcript: 'Human transcript' })));
  const attempts = deps.pool.sqlite.prepare('SELECT cost_usd FROM look_backfill_attempts').all();
  assert.equal(attempts.length, 1);
  assert.ok(attempts[0].cost_usd > 0);
  assert.equal((await sortUsage(deps.pool, deps.cfg)).today, 1);
});

test('repeat hits plus confident live speech need a look and preserve the existing transcript', async t => {
  const deps = await setup(t, 2);
  deps.pool.sqlite.prepare('UPDATE posts SET ai_transcript=?').run(spokenWords);
  assert.deepEqual(await runLipSyncRecheck(deps), { rechecked: 2, auto: 0, needsLook: 2, errored: 0, skippedCap: 0 });
  const rows = deps.pool.sqlite.prepare('SELECT id,content_type,sort_status,ai_suggested_type,lipsync_repeat_of,ai_transcript FROM posts ORDER BY id').all();
  assert.deepEqual(rows, [1, 2].map(id => ({ id, content_type: 'talking', sort_status: 'needs_look',
    ai_suggested_type: 'lipsync', lipsync_repeat_of: 3 - id, ai_transcript: spokenWords })));
});

test('batch repeat sweep revisits older checked talking while preserving matching manual rows', async t => {
  const deps = await setup(t, 3);
  deps.pool.sqlite.prepare('UPDATE posts SET ai_transcript=?').run(spokenWords);
  deps.pool.sqlite.exec("UPDATE posts SET ai_lipsync_checked_at='2026-11-15',ai_lipsync_verdict='live_speech',ai_lipsync_confidence=0.95 WHERE id=1; UPDATE posts SET sort_status='manual' WHERE id=2");
  const manual = deps.pool.sqlite.prepare('SELECT * FROM posts WHERE id=2').get();
  deps.detect = async () => ({ ...liveSpeech(), verdict: 'unsure', confidence: 0.4, words: spokenWords });
  assert.equal((await runLipSyncRecheck(deps)).rechecked, 1);
  assert.deepEqual(deps.pool.sqlite.prepare('SELECT content_type,sort_status,ai_suggested_type,lipsync_repeat_of FROM posts WHERE id=1').get(),
    { content_type: 'talking', sort_status: 'needs_look', ai_suggested_type: 'lipsync', lipsync_repeat_of: 2 });
  assert.equal(deps.pool.sqlite.prepare('SELECT content_type FROM posts WHERE id=3').get().content_type, 'lipsync');
  assert.deepEqual(deps.pool.sqlite.prepare('SELECT * FROM posts WHERE id=2').get(), manual);
});

test('new detector words can flag an older talking reel in the same batch', async t => {
  const deps = await setup(t, 2);
  deps.pool.sqlite.prepare("UPDATE posts SET ai_transcript=?,ai_lipsync_checked_at='2026-11-15' WHERE id=1").run(spokenWords);
  deps.detect = async () => ({ ...liveSpeech(), verdict: 'lip_sync', words: spokenWords });
  assert.equal((await runLipSyncRecheck(deps)).rechecked, 1);
  assert.deepEqual(deps.pool.sqlite.prepare('SELECT content_type,lipsync_repeat_of FROM posts WHERE id=1').get(),
    { content_type: 'lipsync', lipsync_repeat_of: 2 });
});

test('three consecutive detector failures stop the batch, record attempts, and leave manual rows untouched', async t => {
  lipSyncPrices(t, '2', '10');
  const deps = await setup(t, 5);
  deps.pool.sqlite.exec("UPDATE posts SET sort_status='manual' WHERE id=1");
  const manual = deps.pool.sqlite.prepare('SELECT * FROM posts WHERE id=1').get();
  deps.detect = async () => { throw new Error('Fake Gemini outage'); };
  assert.deepEqual(await runLipSyncRecheck(deps),
    { rechecked: 0, auto: 0, needsLook: 0, errored: 3, skippedCap: 0, stoppedOnDescribeErrors: true });
  assert.equal((await sortUsage(deps.pool, deps.cfg)).today, 3);
  const attempts = deps.pool.sqlite.prepare('SELECT cost_usd FROM look_backfill_attempts').all();
  assert.equal(attempts.length, 3);
  for (const attempt of attempts) assert.ok(Math.abs(attempt.cost_usd - 0.044) < 1e-10);
  assert.equal(deps.pool.sqlite.prepare('SELECT COUNT(*) AS n FROM posts WHERE ai_error IS NOT NULL').get().n, 3);
  assert.deepEqual(deps.pool.sqlite.prepare('SELECT * FROM posts WHERE id=1').get(), manual);
});

test('a successful detection resets the consecutive failure stop', async t => {
  const deps = await setup(t, 5);
  let calls = 0;
  deps.detect = async () => {
    calls++;
    if (calls !== 3) throw new Error('Intermittent detector failure');
    return liveSpeech();
  };
  assert.deepEqual(await runLipSyncRecheck(deps), { rechecked: 1, auto: 1, needsLook: 0, errored: 4, skippedCap: 0 });
  assert.equal(calls, 5);
});

test('missing files do not charge Gemini or starve healthy reels behind a one-call cap', async t => {
  const deps = await setup(t, 2);
  deps.cfg.dailyMax = 1;
  await fs.unlink(path.join(deps.videoDir, '2.mp4'));
  const handles = [];
  deps.detect = async ({ handle }) => { handles.push(handle); return liveSpeech(); };
  const result = await runLipSyncRecheck(deps);
  assert.equal(result.errored, 1);
  assert.equal(result.rechecked, 1);
  assert.deepEqual(handles, ['creator-1']);
  assert.equal((await sortUsage(deps.pool, deps.cfg)).today, 1);
});

test('lip-sync recheck waits for and holds the shared sort lock', async t => {
  const deps = await setup(t, 1);
  let releaseLock;
  const locked = withSortLock(() => new Promise(resolve => { releaseLock = resolve; }));
  let releaseDetection;
  let enteredDetection = false;
  deps.detect = async () => {
    enteredDetection = true;
    await new Promise(resolve => { releaseDetection = resolve; });
    return liveSpeech();
  };
  const checking = runLipSyncRecheck(deps);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(enteredDetection, false);
  releaseLock();
  await locked;
  while (!enteredDetection) await new Promise(resolve => setImmediate(resolve));
  let nextJobStarted = false;
  const nextJob = withSortLock(async () => { nextJobStarted = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(nextJobStarted, false);
  releaseDetection();
  assert.equal((await checking).rechecked, 1);
  await nextJob;
  assert.equal(nextJobStarted, true);
});

test('disabled lip-sync recheck does no work', async () => {
  const fail = () => assert.fail('disabled job must do no work');
  assert.deepEqual(await runLipSyncRecheck({ cfg: { enabled: false }, pool: { query: fail }, detect: fail }),
    { rechecked: 0, auto: 0, needsLook: 0, errored: 0, skippedCap: 0 });
});
