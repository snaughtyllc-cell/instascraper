const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { makeSortDb } = require('./test-support/sort-db');
const { runAutoSort, backfillEstimate, sortUsage } = require('./sort-runner');
const { sortConfig } = require('./sort-status');
const ai = { type: 'dance', confidence: 0.9, description: 'Dancing', suggestedType: null, usage: { inTokens: 3400, outTokens: 80 } };
function lipSyncPrices(t, input, output) {
  for (const [key, value] of [['LIPSYNC_PRICE_IN_PER_M', input], ['LIPSYNC_PRICE_OUT_PER_M', output]]) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
}
async function setup(t, count = 2) {
  const pool = await makeSortDb();
  const videoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sort-runner-'));
  t.after(async () => { pool.sqlite.close(); await fs.rm(videoDir, { recursive: true, force: true }); });
  for (let id = 1; id <= count; id++) {
    pool.sqlite.prepare("INSERT INTO posts(id,shortcode,posted_at,video_cache_status) VALUES(?,?,?,'cached')").run(id, `p${id}`, `2026-11-${10 + id}`);
    await fs.writeFile(path.join(videoDir, `${id}.mp4`), 'fake video');
  }
  return { pool, videoDir, cfg: { ...sortConfig({ GEMINI_API_KEY: 'fake' }), enabled: true }, describe: async () => ai,
    detect: async () => ({ verdict: 'live_speech', confidence: 0.95, evidence: ['Matching room acoustics'], words: null }) };
}
test('classifies cached unsorted reels, skips uncached and manual', async t => {
  const deps = await setup(t, 4);
  deps.pool.sqlite.exec("UPDATE posts SET sort_status='manual' WHERE id=1; UPDATE posts SET video_cache_status=NULL WHERE id=2; UPDATE posts SET content_type='talking' WHERE id=3");
  const result = await runAutoSort(deps);
  assert.equal(result.classified, 2);
  assert.equal(deps.pool.sqlite.prepare('SELECT content_type FROM posts WHERE id=3').get().content_type, 'dance');
});
test('auto writes content_type and ai fields; needs_look leaves content_type null', async t => {
  const deps = await setup(t);
  let n = 0;
  deps.describe = async () => ++n === 1 ? ai : { ...ai, type: null, suggestedType: 'Lifestyle' };
  await runAutoSort(deps);
  const rows = deps.pool.sqlite.prepare('SELECT * FROM posts ORDER BY id DESC').all();
  assert.equal(rows[0].sort_status, 'auto');
  assert.equal(rows[0].ai_type, 'dance');
  assert.equal(rows[0].ai_model, 'gemini-3.5-flash-lite');
  assert.equal(rows[0].ai_description, 'Dancing');
  assert.equal(rows[0].ai_confidence, 0.9);
  assert.ok(rows[0].ai_classified_at);
  assert.ok(Math.abs(rows[0].ai_cost_usd - 0.00122) < 1e-10);
  assert.equal(rows[1].sort_status, 'needs_look');
  assert.equal(rows[1].content_type, null);
  assert.equal(rows[1].ai_suggested_type, 'Lifestyle');
});
test('missing file records error and continues', async t => {
  const deps = await setup(t);
  await fs.unlink(path.join(deps.videoDir, '2.mp4'));
  const result = await runAutoSort(deps);
  assert.equal(result.classified, 1); assert.equal(result.errored, 1);
  const row = deps.pool.sqlite.prepare('SELECT * FROM posts WHERE id=2').get();
  assert.equal(row.ai_attempts, 1); assert.match(row.ai_error, /ENOENT/);
});
test('describe throws → attempt counted; after maxAttempts → needs_look with ai_error', async t => {
  const deps = await setup(t, 1);
  deps.cfg.maxAttempts = 2;
  deps.describe = async () => { throw new Error('malformed JSON'); };
  await runAutoSort(deps); await runAutoSort(deps);
  const row = deps.pool.sqlite.prepare('SELECT * FROM posts').get();
  assert.equal(row.ai_attempts, 2); assert.equal(row.sort_status, 'needs_look'); assert.match(row.ai_error, /malformed/);
});
test('three consecutive describe failures stop the batch before claiming remaining candidates', async t => {
  const deps = await setup(t, 5);
  let calls = 0;
  deps.describe = async () => { calls++; throw new Error('Gemini unavailable'); };
  const result = await runAutoSort(deps);
  assert.equal(calls, 3);
  assert.equal(result.errored, 3);
  assert.equal(result.stoppedOnDescribeErrors, true);
  const rows = deps.pool.sqlite.prepare('SELECT id, ai_attempts FROM posts ORDER BY id DESC').all();
  assert.deepEqual(rows.map(row => row.ai_attempts), [1, 1, 1, 0, 0]);
});
test('successful describe resets the consecutive failure count', async t => {
  const deps = await setup(t, 7);
  let calls = 0;
  deps.describe = async () => {
    calls++;
    if (calls === 3) return ai;
    throw new Error('Gemini unavailable');
  };
  const result = await runAutoSort(deps);
  assert.equal(calls, 6);
  assert.equal(result.classified, 1);
  assert.equal(result.errored, 5);
  assert.equal(result.stoppedOnDescribeErrors, true);
  assert.equal(deps.pool.sqlite.prepare('SELECT ai_attempts FROM posts WHERE id=1').get().ai_attempts, 0);
});
test('missing files neither increment nor reset consecutive describe failures', async t => {
  const deps = await setup(t, 7);
  for (const id of [7, 6, 3]) await fs.unlink(path.join(deps.videoDir, `${id}.mp4`));
  let calls = 0;
  deps.describe = async () => { calls++; throw new Error('Gemini unavailable'); };
  const result = await runAutoSort(deps);
  assert.equal(calls, 3);
  assert.equal(result.errored, 6);
  assert.equal(result.stoppedOnDescribeErrors, true);
  const rows = deps.pool.sqlite.prepare('SELECT ai_attempts FROM posts ORDER BY id DESC').all();
  assert.deepEqual(rows.map(row => row.ai_attempts), [1, 1, 1, 1, 1, 1, 0]);
});
test('daily cap stops the batch', async t => {
  const deps = await setup(t);
  deps.cfg.dailyMax = 1;
  const result = await runAutoSort(deps);
  assert.equal(result.classified, 1); assert.equal(result.skippedCap, 1);
  assert.equal((await runAutoSort(deps)).classified, 0);
});
test('concurrent runAutoSort calls run once', async t => {
  const deps = await setup(t, 1);
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  deps.describe = async () => { started(); return new Promise(resolve => { release = () => resolve(ai); }); };
  const first = runAutoSort(deps);
  await ready;
  assert.deepEqual(await runAutoSort(deps), { classified: 0, auto: 0, needsLook: 0, errored: 0, skippedCap: 0 });
  release(); assert.equal((await first).classified, 1);
});
test('disabled config does nothing', async t => {
  const deps = await setup(t); deps.cfg.enabled = false;
  assert.equal((await runAutoSort(deps)).classified, 0);
  assert.equal(deps.pool.sqlite.prepare('SELECT SUM(ai_attempts) n FROM posts').get().n, 0);
});
test('backfill can wait for a sweep and then classify remaining candidates', async t => {
  const deps = await setup(t, 2);
  deps.cfg.batch = 1;
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  let calls = 0;
  deps.describe = async () => {
    calls++;
    if (calls === 1) { started(); await new Promise(resolve => { release = resolve; }); }
    return ai;
  };
  const sweep = runAutoSort(deps);
  await ready;
  const backfill = runAutoSort({ ...deps, waitForIdle: true });
  release();
  assert.equal((await sweep).classified, 1);
  assert.equal((await backfill).classified, 1);
  assert.equal(calls, 2);
});
test('human edit during classification wins', async t => {
  const deps = await setup(t, 1);
  deps.describe = async () => { deps.pool.sqlite.exec("UPDATE posts SET sort_status='manual',content_type='talking'"); return ai; };
  assert.equal((await runAutoSort(deps)).classified, 0);
  assert.equal(deps.pool.sqlite.prepare('SELECT content_type FROM posts').get().content_type, 'talking');
});
test('repeated failures cannot bypass daily cap; estimate and usage report totals', async t => {
  const deps = await setup(t, 1); deps.cfg.dailyMax = 2;
  assert.deepEqual(await backfillEstimate(deps.pool, deps.cfg), { count: 1, estUsd: 0.00502 });
  deps.describe = async () => { throw new Error('failure'); };
  await runAutoSort(deps); await runAutoSort(deps);
  assert.equal((await runAutoSort(deps)).errored, 0);
  assert.equal((await sortUsage(deps.pool, deps.cfg)).today, 2);
});
test('interrupted final attempt reaches needs_look even when daily cap is exhausted', async t => {
  const deps = await setup(t, 1);
  deps.cfg.dailyMax = 1;
  deps.pool.sqlite.prepare("UPDATE posts SET ai_attempts=3,ai_last_attempt_at=?,content_type='talking'").run(new Date().toISOString());
  await runAutoSort(deps);
  const row = deps.pool.sqlite.prepare('SELECT * FROM posts').get();
  assert.equal(row.sort_status, 'needs_look');
  assert.equal(row.content_type, null);
  assert.match(row.ai_error, /interrupted/i);
});
test('archive during classification is preserved', async t => {
  const deps = await setup(t, 1);
  deps.describe = async () => { deps.pool.sqlite.exec('UPDATE posts SET archived=1'); return ai; };
  assert.equal((await runAutoSort(deps)).classified, 0);
  assert.equal(deps.pool.sqlite.prepare('SELECT sort_status FROM posts').get().sort_status, 'unsorted');
});
test('candidate sorts count toward usage totals and the post-sort daily cap', async t => {
  const deps = await setup(t, 1);
  deps.cfg.dailyMax = 2;
  const now = new Date().toISOString();
  deps.pool.sqlite.prepare('INSERT INTO suggested_reels(ai_classified_at,ai_cost_usd) VALUES(?,?)').run(now, 0.002);
  deps.pool.sqlite.prepare('INSERT INTO suggested_reels(ai_classified_at,ai_cost_usd) VALUES(?,?)').run(now, 0.003);
  assert.deepEqual(await sortUsage(deps.pool, deps.cfg), { reels30d: 2, usd30d: 0.005, today: 2, dailyMax: 2 });
  assert.equal((await runAutoSort(deps)).classified, 0);
});
test('auto-sort stores ai_look_tags as JSON array', async t => {
  const deps = await setup(t, 1);
  deps.pool.sqlite.exec(`CREATE TABLE IF NOT EXISTS look_tags(value TEXT, label TEXT, category TEXT, sort_order INTEGER);
    DELETE FROM look_tags;
    INSERT INTO look_tags(value,label,category) VALUES('brunette','Brunette','hair'),('private-custom','Private custom','custom')`);
  deps.describe = async input => {
    assert.deepEqual(input.lookTags.map(tag => tag.value), ['brunette']);
    return { ...ai, lookTags: ['brunette'] };
  };
  await runAutoSort(deps);
  assert.equal(deps.pool.sqlite.prepare('SELECT ai_look_tags FROM posts').get().ai_look_tags, '["brunette"]');
});

test('auto-sort stores sanitized layout from video descriptions', async t => {
  const deps = await setup(t, 5);
  const layouts = ['self_filmed', 'split_screen', 'gameplay_overlay', 'needs_footage', 'invalid'];
  deps.describe = async () => ({ ...ai, layout: layouts.shift() });
  assert.equal((await runAutoSort(deps)).classified, 5);
  assert.deepEqual(deps.pool.sqlite.prepare('SELECT ai_layout FROM posts ORDER BY id DESC').all(), [
    { ai_layout: 'self_filmed' }, { ai_layout: 'split_screen' }, { ai_layout: 'gameplay_overlay' },
    { ai_layout: 'needs_footage' }, { ai_layout: null },
  ]);
});

test('auto-sort stores bounded speech and replaces a previous transcript with null for no speech', async t => {
  const deps = await setup(t, 3);
  deps.pool.sqlite.exec("UPDATE posts SET ai_transcript='Previous speech'");
  const transcripts = [null, ' Hola.\r\nBien. ', 'word '.repeat(900)];
  deps.describe = async () => ({ ...ai, audioKind: 'own_speech', transcript: transcripts.shift() });
  assert.equal((await runAutoSort(deps)).classified, 3);
  const rows = deps.pool.sqlite.prepare('SELECT ai_transcript FROM posts ORDER BY id DESC').all();
  assert.equal(rows[0].ai_transcript, null);
  assert.equal(rows[1].ai_transcript, 'Hola.\nBien.');
  assert.equal(rows[2].ai_transcript, 'word '.repeat(800).trimEnd());
});

test('auto-sort gates talking on audio, stores evidence and clears non-speech transcripts', async t => {
  const deps = await setup(t, 4);
  deps.pool.sqlite.exec("INSERT INTO content_types(value,label,description) VALUES('lipsync','Lip sync','Mouths recorded audio'); UPDATE content_types SET description='Live own speech' WHERE value='talking'; UPDATE posts SET ai_transcript='Old transcript'");
  const audioKinds = ['music_or_trending_audio', 'other_voice', 'none', 'own_speech'];
  deps.describe = async input => {
    assert.equal(input.types.find(type => type.value === 'talking').description, 'Live own speech');
    return { ...ai, type: 'talking', audioKind: audioKinds.shift(), transcript: 'My own words.' };
  };
  const result = await runAutoSort(deps);
  assert.equal(result.auto, 3);
  assert.equal(result.needsLook, 1);
  assert.deepEqual(deps.pool.sqlite.prepare('SELECT content_type,sort_status,ai_audio_kind,ai_transcript,ai_confidence FROM posts ORDER BY id DESC').all(), [
    { content_type: 'lipsync', sort_status: 'auto', ai_audio_kind: 'music_or_trending_audio', ai_transcript: null, ai_confidence: 0.9 },
    { content_type: 'lipsync', sort_status: 'auto', ai_audio_kind: 'other_voice', ai_transcript: null, ai_confidence: 0.9 },
    { content_type: null, sort_status: 'needs_look', ai_audio_kind: 'none', ai_transcript: null, ai_confidence: 0.9 },
    { content_type: 'talking', sort_status: 'auto', ai_audio_kind: 'own_speech', ai_transcript: 'My own words.', ai_confidence: 0.9 },
  ]);
});

test('new talking reel is checked for lip sync in the same pass and stores spoken words', async t => {
  lipSyncPrices(t, '2', '10');
  const deps = await setup(t, 1);
  deps.cfg.priceInPerM = 0.1;
  deps.cfg.priceOutPerM = 0.2;
  deps.pool.sqlite.exec("INSERT INTO content_types(value,label) VALUES('lipsync','Lip sync')");
  deps.describe = async () => ({ ...ai, type: 'talking', audioKind: 'own_speech', transcript: 'Original words' });
  let calls = 0;
  deps.detect = async input => {
    calls++;
    assert.equal(input.filePath, path.join(deps.videoDir, '1.mp4'));
    assert.equal(deps.pool.sqlite.prepare('SELECT sort_status FROM posts').get().sort_status, 'needs_look',
      'Film must not see unchecked talking while the detector is running');
    return { verdict: 'lip_sync', confidence: 0.9, evidence: ['Studio voice in car'], words: 'Mouthed recorded speech',
      usage: { inTokens: 1000, outTokens: 200 } };
  };
  assert.equal((await runAutoSort(deps)).classified, 1);
  assert.equal(calls, 1);
  const post = deps.pool.sqlite.prepare('SELECT * FROM posts').get();
  assert.equal(post.content_type, 'lipsync');
  assert.equal(post.ai_transcript, 'Mouthed recorded speech');
  assert.ok(post.ai_lipsync_checked_at);
  assert.ok(Math.abs(post.ai_cost_usd - (0.000356 + 0.004)) < 1e-10,
    'sorter uses its configured rates while detector uses dedicated environment rates');
  assert.equal(deps.pool.sqlite.prepare('SELECT cost_usd FROM look_backfill_attempts').get().cost_usd, 0);
  assert.equal((await sortUsage(deps.pool, deps.cfg)).today, 2);
});

test('the detector budget cannot allow later sort calls to exceed the daily cap', async t => {
  const deps = await setup(t, 3);
  deps.cfg.dailyMax = 2;
  deps.describe = async () => ({ ...ai, type: 'talking', audioKind: 'own_speech' });
  assert.equal((await runAutoSort(deps)).classified, 1);
  assert.equal((await sortUsage(deps.pool, deps.cfg)).today, 2);
});

test('a new transcript flags an older confidently-live reel for review without touching manual rows', async t => {
  const deps = await setup(t, 3);
  const transcript = 'These are exactly the same recorded spoken words across several different creators today';
  deps.pool.sqlite.prepare(`UPDATE posts SET sort_status='auto',content_type='talking',ai_transcript=?,
    ai_lipsync_verdict='live_speech',ai_lipsync_confidence=0.95,ai_lipsync_checked_at='2026-11-15' WHERE id=1`).run(transcript);
  deps.pool.sqlite.prepare("UPDATE posts SET sort_status='manual',content_type='talking',ai_transcript=? WHERE id=2").run(transcript);
  const manual = deps.pool.sqlite.prepare('SELECT * FROM posts WHERE id=2').get();
  deps.describe = async () => ({ ...ai, type: 'talking', audioKind: 'own_speech', transcript });
  deps.detect = async () => ({ verdict: 'lip_sync', confidence: 0.95, evidence: [], words: transcript });
  await runAutoSort(deps);
  const older = deps.pool.sqlite.prepare('SELECT * FROM posts WHERE id=1').get();
  assert.equal(older.sort_status, 'needs_look');
  assert.equal(older.content_type, 'talking');
  assert.equal(older.ai_suggested_type, 'lipsync');
  assert.deepEqual(deps.pool.sqlite.prepare('SELECT * FROM posts WHERE id=2').get(), manual);
});

test('manual correction during the new-reel detector wins', async t => {
  const deps = await setup(t, 1);
  deps.describe = async () => ({ ...ai, type: 'talking', audioKind: 'own_speech' });
  let manual;
  deps.detect = async () => {
    deps.pool.sqlite.exec("UPDATE posts SET sort_status='manual',content_type='talking'");
    manual = deps.pool.sqlite.prepare('SELECT * FROM posts').get();
    return { verdict: 'lip_sync', confidence: 0.99, evidence: [], words: 'Recorded speech' };
  };
  await runAutoSort(deps);
  assert.deepEqual(deps.pool.sqlite.prepare('SELECT * FROM posts').get(), manual);
  const ledger = deps.pool.sqlite.prepare('SELECT cost_usd FROM look_backfill_attempts').get();
  assert.ok(ledger.cost_usd > 0);
});

test('unchecked talking is sent to needs-look when the same-pass detector has no budget', async t => {
  const deps = await setup(t, 1);
  deps.cfg.dailyMax = 1;
  deps.describe = async () => ({ ...ai, type: 'talking', audioKind: 'own_speech' });
  deps.detect = async () => assert.fail('daily cap must prevent detector');
  const result = await runAutoSort(deps);
  assert.equal(result.auto, 0);
  assert.equal(result.needsLook, 1);
  assert.deepEqual(deps.pool.sqlite.prepare('SELECT content_type,sort_status,ai_suggested_type,ai_lipsync_checked_at FROM posts').get(),
    { content_type: 'talking', sort_status: 'needs_look', ai_suggested_type: 'lipsync', ai_lipsync_checked_at: null });
  assert.equal((await sortUsage(deps.pool, deps.cfg)).today, 1);
});

test('a failed same-pass detector cannot publish unchecked talking to Film', async t => {
  lipSyncPrices(t, '2', '10');
  const deps = await setup(t, 1);
  deps.describe = async () => ({ ...ai, type: 'talking', audioKind: 'own_speech' });
  deps.detect = async () => { throw new Error('Fake detector outage'); };
  const result = await runAutoSort(deps);
  assert.equal(result.needsLook, 1);
  assert.equal(result.errored, 1);
  const row = deps.pool.sqlite.prepare('SELECT * FROM posts').get();
  assert.equal(row.sort_status, 'needs_look');
  assert.equal(row.ai_suggested_type, 'lipsync');
  assert.match(row.ai_error, /Fake detector outage/);
  assert.ok(Math.abs(deps.pool.sqlite.prepare('SELECT cost_usd FROM look_backfill_attempts').get().cost_usd - 0.044) < 1e-10);
  assert.ok(Math.abs(row.ai_cost_usd - 0.00122) < 1e-10, 'failed detector cost remains in the ledger');
  assert.ok(Math.abs((await sortUsage(deps.pool, deps.cfg)).usd30d - (0.00122 + 0.044)) < 1e-10);
});
