const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { makeSortDb } = require('./test-support/sort-db');
const { ensureFilmTables } = require('./film-migration');
const { sortConfig } = require('./sort-status');
const { attemptsToday, sortUsage } = require('./sort-runner');
const { createReactAnalysisWorker, analysisFile } = require('./react-analysis');
const { analyzeFrames, mergeLayout, parseSilences, snapCreatorCues, muteCreator } = require('./react-analysis-media');

function frame(seam = null) {
  const bytes = Buffer.alloc(90 * 160);
  for (let y = 0; y < 160; y++) for (let x = 0; x < 90; x++) {
    bytes[y * 90 + x] = seam === null ? 50 + (x % 20) : y < seam ? 20 + (x % 20) : 190 + (x % 20);
  }
  return bytes;
}

test('seam detects persistent horizontal split and layout covers full duration', () => {
  const result = analyzeFrames(Buffer.concat([frame(67), frame(67), frame(67), frame(67), frame(), frame(), frame(), frame()]), 2);
  assert.equal(result.seam, 67 / 160);
  assert.deepEqual(result.layout, [{ start: 0, end: 0.75, kind: 'split' }, { start: 0.75, end: 2, kind: 'full' }]);
  assert.deepEqual(analyzeFrames(Buffer.concat([frame(), frame(), frame(), frame()]), 0.9),
    { seam: null, layout: [{ start: 0, end: 0.9, kind: 'full' }] });
});

test('single-frame cuts smooth away and displaced seams count as full', () => {
  assert.deepEqual(mergeLayout(['split', 'split', 'full', 'split', 'split', 'split'], 1.5), [{ start: 0, end: 1.5, kind: 'split' }]);
  const result = analyzeFrames(Buffer.concat([frame(64), frame(64), frame(64), frame(64), frame(90), frame(90)]), 1.5);
  assert.deepEqual(result.layout, [{ start: 0, end: 1, kind: 'split' }, { start: 1, end: 1.5, kind: 'full' }]);
  assert.equal(analyzeFrames(Buffer.concat([frame(), frame(64), frame(), frame()]), 1).seam, null);
});

test('layout marks both a weak sample and its strong predecessor full', () => {
  const result = analyzeFrames(Buffer.concat([
    frame(64), frame(64), frame(64), frame(64), frame(),
    frame(64), frame(64), frame(64), frame(64),
  ]), 2.25);
  assert.deepEqual(result.layout, [
    { start: 0, end: 0.75, kind: 'split' },
    { start: 0.75, end: 1.25, kind: 'full' },
    { start: 1.25, end: 2.25, kind: 'split' },
  ]);
});

test('early layout boundaries retain minimum segment smoothing and do not invent a full tail', () => {
  const shortSplit = analyzeFrames(Buffer.concat([frame(64), frame(64), frame(), frame()]), 1);
  assert.equal(shortSplit.seam, 64 / 160);
  assert.deepEqual(shortSplit.layout, [{ start: 0, end: 1, kind: 'full' }]);
  assert.deepEqual(analyzeFrames(Buffer.concat([frame(64), frame(64), frame(64), frame(64)]), 1).layout,
    [{ start: 0, end: 1, kind: 'split' }]);
});

test('silence parser and creator cues snap outwards within 350 ms', () => {
  const silences = parseSilences('silence_start: -0.1\nsilence_end: 0.9\nsilence_start: 2.2\nsilence_end: 2.6\nsilence_start: 3.8', 4);
  assert.deepEqual(silences, [{ start: 0, end: 0.9 }, { start: 2.2, end: 2.6 }, { start: 3.8, end: 4 }]);
  assert.deepEqual(snapCreatorCues([
    { role: 'creator', start: 1, end: 2, text: 'Hello' },
    { role: 'stranger', start: 2.7, end: 3.1, text: 'Hi' },
    { role: 'creator', start: 3.2, end: 3.4, text: 'Bye' },
  ], silences, 4), [{ start: 0.9, end: 2.2, text: 'Hello' }, { start: 3.2, end: 3.4, text: 'Bye' }]);
});

async function setup(t, extra = {}) {
  const pool = await makeSortDb();
  await ensureFilmTables(pool, { isPg: false });
  t.after(() => pool.sqlite.close());
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'react-analysis-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const env = { REACT_REF_DIR: dir, GEMINI_API_KEY: 'fake', ...extra.env };
  let calls = 0, inFlight = 0, peak = 0;
  const deps = { pool, env, cfg: sortConfig(env),
    ensureReference: async (_db, shortcode) => ({ path: path.join(dir, `${shortcode}.mp4`), durationSec: 3 }),
    probe: async () => ({ durationSec: 3, hasAudio: true }),
    layout: async () => ({ seam: 0.42, layout: [{ start: 0, end: 3, kind: 'split' }] }),
    silence: async () => [{ start: 0.7, end: 0.9 }, { start: 2.2, end: 2.6 }],
    describe: async () => { calls++; return { utterances: [{ start: 1, end: 2, text: 'Hello', role: 'creator' }], usage: { inTokens: 100, outTokens: 10 } }; },
    mute: async (_input, output) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      await fs.writeFile(output, 'derivative');
      inFlight--;
    }, ...extra,
  };
  deps.env = env;
  return { pool, dir, deps, calls: () => calls, peak: () => peak,
    original: async shortcode => { const file = path.join(dir, `${shortcode}.mp4`); await fs.writeFile(file, 'original'); return { path: file, durationSec: 3 }; } };
}

test('analysis serially publishes derivatives, persists snapped cues and shared actual cost', async t => {
  const s = await setup(t), worker = createReactAnalysisWorker(s.deps);
  await worker.start();
  const refs = await Promise.all(['abcde', 'fghij'].map(async code => [code, await s.original(code)]));
  await Promise.all(refs.map(([code, reference]) => worker.request(code, reference)));
  await worker.waitForIdle();
  assert.equal(s.peak(), 1);
  const ready = await worker.getResult('abcde');
  assert.equal(ready.state, 'ready');
  assert.equal(await fs.readFile(ready.path, 'utf8'), 'derivative');
  assert.equal(ready.analysis.creatorMuted, true);
  assert.deepEqual(ready.analysis.cues, [{ start: 0.9, end: 2.2, text: 'Hello' }]);
  assert.equal(await attemptsToday(s.pool), 2);
  const usage = await sortUsage(s.pool, s.deps.cfg);
  assert.ok(Math.abs(usage.usd30d - 0.00011) < 1e-10);
  await worker.request('abcde', refs[0][1]);
  assert.equal(s.calls(), 2);
  await fs.unlink(analysisFile('abcde', s.deps.env));
  assert.deepEqual(await worker.getResult('abcde'), { state: 'failed', analysis: null });
});

test('existing shared cap blocks Gemini before call; failures keep cost reservation', async t => {
  const s = await setup(t, { env: { AUTO_SORT_DAILY_MAX: '1' } });
  s.deps.cfg = sortConfig(s.deps.env);
  await s.pool.query('INSERT INTO look_backfill_attempts(post_id,attempted_at,cost_usd) VALUES($1,$2,$3)', [99, new Date().toISOString(), 0.1]);
  const worker = createReactAnalysisWorker(s.deps);
  const ref = await s.original('abcde');
  await worker.request('abcde', ref);
  await worker.waitForIdle();
  assert.deepEqual(await worker.getResult('abcde'), { state: 'failed', analysis: null });
  assert.equal(s.calls(), 0);
  assert.equal(s.pool.sqlite.prepare('SELECT error FROM film_react_analysis').get().error, 'gemini_daily_cap');
  assert.equal(await attemptsToday(s.pool), 1);
});

test('Gemini errors fall back and failed paid attempts count against cap', async t => {
  const s = await setup(t, { describe: async () => { throw new Error('provider failure with secret'); } });
  const worker = createReactAnalysisWorker(s.deps);
  await worker.request('abcde', await s.original('abcde'));
  await worker.waitForIdle();
  assert.deepEqual(await worker.getResult('abcde'), { state: 'failed', analysis: null });
  assert.equal(await attemptsToday(s.pool), 1);
  assert.ok((await sortUsage(s.pool, s.deps.cfg)).usd30d > 0);
  assert.equal(s.pool.sqlite.prepare('SELECT error FROM film_react_analysis').get().error, 'analysis_failed');
});

test('startup analyses older pins, recovers queued work, fails interrupted running work', async t => {
  const s = await setup(t);
  await s.original('oldpin');
  await s.original('queued');
  const stamp = new Date().toISOString();
  await s.pool.query("INSERT INTO film_react_analysis(shortcode,state,attempts,created_at,updated_at) VALUES($1,$2,$3,$4,$5)", ['queued', 'queued', 1, stamp, stamp]);
  const stale = new Date(Date.now() - 180000).toISOString();
  await s.pool.query("INSERT INTO film_react_analysis(shortcode,state,attempts,created_at,updated_at) VALUES($1,$2,$3,$4,$5)", ['running', 'running', 1, stale, stale]);
  const worker = createReactAnalysisWorker(s.deps);
  await worker.start();
  await worker.waitForIdle();
  assert.equal((await worker.getResult('oldpin')).state, 'ready');
  assert.equal((await worker.getResult('queued')).state, 'ready');
  assert.deepEqual(await worker.getResult('running'), { state: 'failed', analysis: null });
  assert.equal(s.pool.sqlite.prepare("SELECT error FROM film_react_analysis WHERE shortcode='running'").get().error, 'worker_restarted');
});

test('starting another worker does not steal an active analysis', async t => {
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const s = await setup(t, { mute: async (_input, output) => {
    entered();
    await new Promise(resolve => { release = resolve; });
    await fs.writeFile(output, 'derivative');
  } });
  const worker = createReactAnalysisWorker(s.deps);
  await worker.start();
  await worker.request('abcde', await s.original('abcde'));
  await waiting;
  const second = createReactAnalysisWorker(s.deps);
  await second.start();
  assert.equal((await second.getResult('abcde')).state, 'fetching');
  release();
  await worker.waitForIdle();
  assert.equal((await second.getResult('abcde')).state, 'ready');
  assert.equal(s.calls(), 1);
});

test('startup discovery failure runs no work and retry recovers each durable claim once', async t => {
  const s = await setup(t);
  await s.original('queued');
  const stamp = new Date().toISOString();
  await s.pool.query("INSERT INTO film_react_analysis(shortcode,state,attempts,created_at,updated_at) VALUES($1,$2,$3,$4,$5)", ['queued', 'queued', 1, stamp, stamp]);
  const query = s.pool.query;
  let rejected = false;
  s.pool.query = async (sql, params) => {
    if (!rejected && /SELECT shortcode FROM film_react_refs/.test(sql)) { rejected = true; throw new Error('database interrupted'); }
    return query(sql, params);
  };
  const worker = createReactAnalysisWorker(s.deps);
  await assert.rejects(worker.start(), /database interrupted/);
  assert.equal(s.calls(), 0);
  assert.equal(s.pool.sqlite.prepare("SELECT state FROM film_react_analysis WHERE shortcode='queued'").get().state, 'queued');
  await worker.start();
  await worker.waitForIdle();
  assert.equal(s.calls(), 1);
  assert.equal((await worker.getResult('queued')).state, 'ready');
});

test('timeout during ready persistence cannot expose a late ready derivative', async t => {
  const s = await setup(t, { env: { REACT_ANALYSIS_TIMEOUT_SEC: '0.06' } });
  const query = s.pool.query;
  s.pool.query = async (sql, params) => {
    if (/SET state='ready'/.test(sql)) {
      const result = await query(sql, params);
      await new Promise(resolve => setTimeout(resolve, 100));
      return result;
    }
    return query(sql, params);
  };
  const worker = createReactAnalysisWorker(s.deps);
  await worker.start();
  await worker.request('abcde', await s.original('abcde'));
  await worker.waitForIdle();
  assert.deepEqual(await worker.getResult('abcde'), { state: 'failed', analysis: null });
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.deepEqual(await worker.getResult('abcde'), { state: 'failed', analysis: null });
  assert.deepEqual(await fs.readdir(s.dir), ['abcde.mp4']);
});

test('deadline aborts work, ignores late output and cleans unpublished temporary files', async t => {
  let finish;
  const s = await setup(t, { env: { REACT_ANALYSIS_TIMEOUT_SEC: '0.04' },
    mute: async (_input, output) => { await new Promise(resolve => { finish = resolve; }); await fs.writeFile(output, 'too late'); } });
  const worker = createReactAnalysisWorker(s.deps);
  await worker.start();
  await worker.request('abcde', await s.original('abcde'));
  await worker.waitForIdle();
  assert.deepEqual(await worker.getResult('abcde'), { state: 'failed', analysis: null });
  assert.equal(s.pool.sqlite.prepare('SELECT error FROM film_react_analysis').get().error, 'analysis_timeout');
  assert.equal(typeof finish, 'function');
  finish();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(await fs.readdir(s.dir), ['abcde.mp4']);
  assert.equal((await worker.getResult('abcde')).state, 'failed');
});

test('unconfigured Gemini fails immediately and no-audio reels publish without speech calls', async t => {
  const s = await setup(t), original = await s.original('abcde');
  const disabled = createReactAnalysisWorker({ ...s.deps, describe: undefined, cfg: sortConfig({}) });
  assert.deepEqual(await disabled.request('abcde', original), { state: 'failed', analysis: null });
  const other = await s.original('fghij');
  const worker = createReactAnalysisWorker({ ...s.deps, probe: async () => ({ durationSec: 3, hasAudio: false }) });
  await worker.request('fghij', other);
  await worker.waitForIdle();
  const result = await worker.getResult('fghij');
  assert.equal(result.state, 'ready');
  assert.equal(result.analysis.creatorMuted, false);
  assert.deepEqual(result.analysis.cues, []);
  assert.equal(s.calls(), 0);
});

const ffmpegAvailable = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
test('real creator mute preserves video, outputs stereo AAC and silences creator spans', { skip: !ffmpegAvailable }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'react-mute-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'input.mp4'), output = path.join(dir, 'output.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=90x160:r=4:d=3',
    '-f', 'lavfi', '-i', 'sine=frequency=600:sample_rate=48000:duration=3', '-c:v', 'libx264', '-threads', '1', '-c:a', 'aac', '-shortest', input]);
  await muteCreator(input, output, [{ start: 1, end: 2 }], true, 3, { env: { REACT_FFMPEG_THREADS: '1' } });
  const metadata = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', output], { encoding: 'utf8' }));
  const audio = metadata.streams.find(stream => stream.codec_type === 'audio');
  assert.equal(audio.codec_name, 'aac');
  assert.equal(audio.channels, 2);
  assert.equal(audio.sample_rate, '48000');
  const volume = (start, duration) => {
    const { spawnSync } = require('node:child_process');
    const result = spawnSync('ffmpeg', ['-hide_banner', '-ss', String(start), '-i', output, '-t', String(duration), '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return Number(/mean_volume: (-?[\d.]+) dB/.exec(result.stderr)[1]);
  };
  assert.ok(volume(1.2, 0.5) < -85);
  assert.ok(volume(0.2, 0.5) > -30);
});
