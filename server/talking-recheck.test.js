const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { makeSortDb } = require('./test-support/sort-db');
const { runTalkingRecheck, talkingRecheckEstimate } = require('./talking-recheck');
const { runAutoSort, sortUsage, withSortLock } = require('./sort-runner');
const { sortConfig } = require('./sort-status');

const ownSpeech = () => ({ type: 'talking', confidence: 0.95, description: 'Speaking to camera.',
  suggestedType: null, audioKind: 'own_speech', transcript: 'These are my own words.', lookTags: ['bedroom'],
  usage: { inTokens: 3400, outTokens: 100 } });

async function setup(t, count = 2) {
  const pool = await makeSortDb();
  const videoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'talking-recheck-'));
  t.after(async () => { pool.sqlite.close(); await fs.rm(videoDir, { recursive: true, force: true }); });
  pool.sqlite.exec(`INSERT INTO content_types(value,label,description) VALUES('lipsync','Lip sync','Mouthing pre-recorded audio.');
    UPDATE content_types SET description='Speaking their own live words.' WHERE value='talking'`);
  for (let id = 1; id <= count; id++) {
    pool.sqlite.prepare(`INSERT INTO posts(id,shortcode,account_handle,caption,posted_at,video_cache_status,
      sort_status,content_type,ai_type,ai_description,ai_transcript,ai_cost_usd)
      VALUES(?,?,?,?,'2026-11-15','cached','auto','talking','talking','Original','Old incorrect transcript',0.001)`)
      .run(id, `reel-${id}`, `creator-${id}`, `caption-${id}`);
    await fs.writeFile(path.join(videoDir, `${id}.mp4`), 'fake video');
  }
  return { pool, videoDir, cfg: { ...sortConfig({ GEMINI_API_KEY: 'fake' }), enabled: true }, describe: ownSpeech };
}

test('talking recheck applies full lip-sync decision, descriptions and look tags, and clears lyrics', async t => {
  const deps = await setup(t, 1);
  deps.describe = async input => {
    assert.equal(input.types.find(type => type.value === 'talking').description, 'Speaking their own live words.');
    assert.ok(input.lookTags.every(tag => tag.category !== 'custom'));
    return { ...ownSpeech(), audioKind: 'music_or_trending_audio', transcript: 'Song lyrics must be removed.' };
  };
  assert.deepEqual(await runTalkingRecheck(deps), { rechecked: 1, auto: 1, needsLook: 0, errored: 0, skippedCap: 0 });
  const row = deps.pool.sqlite.prepare('SELECT * FROM posts').get();
  assert.equal(row.content_type, 'lipsync');
  assert.equal(row.sort_status, 'auto');
  assert.equal(row.ai_type, 'talking');
  assert.equal(row.ai_confidence, 0.95);
  assert.equal(row.ai_description, 'Speaking to camera.');
  assert.equal(row.ai_transcript, null);
  assert.equal(row.ai_audio_kind, 'music_or_trending_audio');
  assert.equal(row.ai_look_tags, '["bedroom"]');
  assert.equal(row.ai_model, deps.cfg.model);
  assert.ok(row.ai_classified_at);
  assert.equal(deps.pool.sqlite.prepare('SELECT cost_usd FROM look_backfill_attempts').get().cost_usd, 0);
  const usage = await sortUsage(deps.pool, deps.cfg);
  assert.equal(usage.today, 1);
  assert.ok(Math.abs(usage.usd30d - row.ai_cost_usd) < 1e-10, 'successful spend must be counted only once');
});

test('talking without own speech or lip-sync evidence needs review and loses its transcript', async t => {
  const deps = await setup(t, 1);
  deps.describe = async () => ({ ...ownSpeech(), audioKind: 'none' });
  assert.equal((await runTalkingRecheck(deps)).needsLook, 1);
  assert.deepEqual(deps.pool.sqlite.prepare('SELECT content_type,sort_status,ai_audio_kind,ai_transcript FROM posts').get(),
    { content_type: null, sort_status: 'needs_look', ai_audio_kind: 'none', ai_transcript: null });
});

test('one triggered run rechecks own-speech talking exactly once even across the configured batch size', async t => {
  const deps = await setup(t, 3);
  deps.cfg.batch = 1;
  const handles = [];
  deps.describe = async input => { handles.push(input.handle); return ownSpeech(); };
  assert.equal((await runTalkingRecheck(deps)).rechecked, 3);
  assert.deepEqual(handles, ['creator-3', 'creator-2', 'creator-1']);
  assert.deepEqual(deps.pool.sqlite.prepare('SELECT content_type,sort_status,ai_transcript,ai_audio_kind FROM posts').all(),
    Array(3).fill({ content_type: 'talking', sort_status: 'auto', ai_transcript: 'These are my own words.', ai_audio_kind: 'own_speech' }));
});

test('estimate and job exclude manual, uncached, non-talking, archived and deleted reels', async t => {
  const deps = await setup(t, 8);
  deps.pool.sqlite.exec(`UPDATE posts SET sort_status='manual' WHERE id=2;
    UPDATE posts SET sort_status='needs_look' WHERE id=3;
    UPDATE posts SET video_cache_status=NULL WHERE id=4;
    UPDATE posts SET content_type='dance' WHERE id=5;
    UPDATE posts SET soft_deleted=1 WHERE id=6;
    UPDATE posts SET archived=1 WHERE id=7;
    UPDATE posts SET sort_status='unsorted' WHERE id=8`);
  const before = deps.pool.sqlite.prepare('SELECT * FROM posts WHERE id>1 ORDER BY id').all();
  const estimate = await talkingRecheckEstimate(deps.pool, deps.cfg);
  assert.equal(estimate.count, 1);
  assert.ok(Math.abs(estimate.estUsd - 0.00502) < 1e-10);
  assert.equal((await runTalkingRecheck(deps)).rechecked, 1);
  assert.deepEqual(deps.pool.sqlite.prepare('SELECT * FROM posts WHERE id>1 ORDER BY id').all(), before);
});

test('a model workspace is prioritized before other eligible creators, without excluding them', async t => {
  const deps = await setup(t, 3);
  deps.pool.sqlite.exec("INSERT INTO models(id) VALUES(7); INSERT INTO model_creators(model_id,username) VALUES(7,'CREATOR-1')");
  const estimate = await talkingRecheckEstimate(deps.pool, deps.cfg, { modelId: 7 });
  assert.equal(estimate.count, 3);
  assert.equal(estimate.priorityCount, 1);
  const handles = [];
  deps.describe = async input => { handles.push(input.handle); return ownSpeech(); };
  assert.equal((await runTalkingRecheck({ ...deps, modelId: 7 })).rechecked, 3);
  assert.deepEqual(handles, ['creator-1', 'creator-3', 'creator-2']);
});

test('talking recheck respects the shared cap and prioritizes the selected workspace at that cap', async t => {
  const deps = await setup(t, 3);
  deps.cfg.dailyMax = 2;
  deps.pool.sqlite.exec("INSERT INTO model_creators(model_id,username) VALUES(7,'creator-1'); INSERT INTO look_backfill_attempts(post_id,attempted_at) VALUES(99,'2999-01-01')");
  const handles = [];
  deps.describe = async input => { handles.push(input.handle); return ownSpeech(); };
  assert.deepEqual(await runTalkingRecheck({ ...deps, modelId: 7 }), { rechecked: 1, auto: 1, needsLook: 0, errored: 0, skippedCap: 2 });
  assert.deepEqual(handles, ['creator-1']);
  assert.equal((await runTalkingRecheck(deps)).rechecked, 0);
  assert.equal((await sortUsage(deps.pool, deps.cfg)).today, 2);
});

test('cap-limited reruns reach unchecked reels before repeating checked workspace talking', async t => {
  const deps = await setup(t, 3);
  deps.cfg.dailyMax = 1;
  deps.pool.sqlite.exec("INSERT INTO model_creators(model_id,username) VALUES(7,'creator-3'),(7,'creator-2')");
  const handles = [];
  deps.describe = async input => { handles.push(input.handle); return ownSpeech(); };
  for (let run = 0; run < 3; run++) {
    assert.equal((await runTalkingRecheck({ ...deps, modelId: 7 })).rechecked, 1);
    deps.pool.sqlite.exec('DELETE FROM look_backfill_attempts'); // A fresh daily budget.
  }
  assert.deepEqual(handles, ['creator-3', 'creator-2', 'creator-1']);
});

test('manual edits before processing or during Gemini are never overwritten and calls retain their cost', async t => {
  const deps = await setup(t, 2);
  const original = deps.pool.sqlite.prepare('SELECT * FROM posts ORDER BY id').all();
  let calls = 0;
  deps.describe = async () => {
    calls++;
    deps.pool.sqlite.exec("UPDATE posts SET sort_status='manual',content_type='dance',ai_transcript='Human transcript'");
    return { ...ownSpeech(), audioKind: 'other_voice' };
  };
  assert.equal((await runTalkingRecheck(deps)).rechecked, 0);
  assert.equal(calls, 1, 'a queued row changed to manual must be skipped before Gemini');
  assert.deepEqual(deps.pool.sqlite.prepare('SELECT * FROM posts ORDER BY id').all(),
    original.map(row => ({ ...row, sort_status: 'manual', content_type: 'dance', ai_transcript: 'Human transcript' })));
  const ledger = deps.pool.sqlite.prepare('SELECT cost_usd FROM look_backfill_attempts').all();
  assert.equal(ledger.length, 1);
  assert.ok(ledger[0].cost_usd > 0);
  assert.equal((await sortUsage(deps.pool, deps.cfg)).today, 1);
});

test('talking recheck waits for the shared lock, then consumes the budget before automatic sorting', async t => {
  const deps = await setup(t, 2);
  deps.cfg.dailyMax = 1;
  deps.pool.sqlite.exec("UPDATE posts SET sort_status='unsorted' WHERE id=1");
  let releaseLock;
  const active = withSortLock(() => new Promise(resolve => { releaseLock = resolve; }));
  let calls = 0;
  deps.describe = async () => { calls++; return ownSpeech(); };
  const rechecking = runTalkingRecheck(deps);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
  const sorting = runAutoSort({ ...deps, waitForIdle: true });
  releaseLock();
  await active;
  assert.equal((await rechecking).rechecked, 1);
  assert.equal((await sorting).classified, 0);
  assert.equal(calls, 1);
});

test('three consecutive describe failures stop a run and consume the shared cap without changing manual reels', async t => {
  const deps = await setup(t, 5);
  deps.pool.sqlite.exec("UPDATE posts SET sort_status='manual' WHERE id=1");
  const before = deps.pool.sqlite.prepare('SELECT * FROM posts WHERE id=1').get();
  deps.describe = async () => { throw new Error('Fake Gemini outage'); };
  assert.deepEqual(await runTalkingRecheck(deps), { rechecked: 0, auto: 0, needsLook: 0, errored: 3, skippedCap: 0, stoppedOnDescribeErrors: true });
  assert.equal((await sortUsage(deps.pool, deps.cfg)).today, 3);
  assert.deepEqual(deps.pool.sqlite.prepare('SELECT * FROM posts WHERE id=1').get(), before);
});

test('missing files do not charge Gemini and disabled recheck does no work', async t => {
  const deps = await setup(t, 1);
  await fs.unlink(path.join(deps.videoDir, '1.mp4'));
  deps.describe = async () => assert.fail('missing file must not be described');
  assert.equal((await runTalkingRecheck(deps)).errored, 1);
  assert.equal((await sortUsage(deps.pool, deps.cfg)).today, 0);
  const fail = () => assert.fail('disabled job must do no work');
  assert.deepEqual(await runTalkingRecheck({ cfg: { enabled: false }, pool: { query: fail }, describe: fail }),
    { rechecked: 0, auto: 0, needsLook: 0, errored: 0, skippedCap: 0 });
});

test('a missing cache file cannot permanently block healthy reels behind a one-call cap', async t => {
  const deps = await setup(t, 2);
  deps.cfg.dailyMax = 1;
  deps.pool.sqlite.exec("UPDATE posts SET ai_audio_kind='own_speech' WHERE id=1");
  await fs.unlink(path.join(deps.videoDir, '2.mp4'));
  const handles = [];
  deps.describe = async input => { handles.push(input.handle); return ownSpeech(); };
  assert.equal((await runTalkingRecheck(deps)).errored, 1);
  assert.equal((await sortUsage(deps.pool, deps.cfg)).today, 0);
  assert.equal((await runTalkingRecheck(deps)).rechecked, 1);
  assert.deepEqual(handles, ['creator-1']);
});
