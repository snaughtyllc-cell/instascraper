const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sortConfig } = require('./sort-status');
const { attemptsToday, withSortLock } = require('./sort-runner');
const { describeReactSpeech, cleanReactUtterances, estimateCostUsd, makeGeminiClient } = require('./gemini-sort');
const { probeVideo, resolveFfmpegNice } = require('./react-ffmpeg');
const { isValidShortcode, referenceFile, usableFile, ensureReactReference } = require('./react-reference');
const { inspectLayout, detectSilences, snapCreatorCues, muteCreator } = require('./react-analysis-media');

const pending = state => state === 'queued' || state === 'running';
const failed = () => ({ state: 'failed', analysis: null });
const failure = code => Object.assign(new Error(code), { code });

function analysisFile(shortcode, env = process.env) {
  const original = referenceFile(shortcode, env);
  return original ? original.replace(/\.mp4$/, '.react.mp4') : null;
}

function validAnalysis(analysis) {
  if (!analysis || analysis.version !== 1 || typeof analysis.creatorMuted !== 'boolean'
    || !(analysis.seam === null || (Number.isFinite(analysis.seam) && analysis.seam >= 0 && analysis.seam <= 1))
    || !Array.isArray(analysis.layout) || !analysis.layout.length
    || !Array.isArray(analysis.cues) || analysis.cues.length > 200) return false;
  let end = 0;
  for (const segment of analysis.layout) {
    if (!segment || !Number.isFinite(segment.start) || !Number.isFinite(segment.end)
      || Math.abs(segment.start - end) > 0.00001 || segment.end <= segment.start
      || !['split', 'full'].includes(segment.kind)) return false;
    end = segment.end;
  }
  let start = 0;
  for (const cue of analysis.cues) {
    if (!cue || !Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < start
      || cue.end <= cue.start || cue.end > end + 0.00001 || typeof cue.text !== 'string'
      || !cue.text.trim() || cue.text.length > 300) return false;
    start = cue.start;
  }
  return analysis.creatorMuted === (analysis.cues.length > 0);
}

function createReactAnalysisWorker({ pool, env = process.env, now = Date.now,
  describe, probe = probeVideo, layout = inspectLayout, silence = detectSilences, mute = muteCreator,
  ensureReference = (db, shortcode) => ensureReactReference(db, shortcode, { env }),
  cfg = sortConfig(env) } = {}) {
  const configured = Number(env.REACT_ANALYSIS_TIMEOUT_SEC) * 1000;
  const timeoutMs = Number.isFinite(configured) && configured > 0 && configured <= 2147483647 ? configured : 120000;
  const entries = new Map(), queue = [], idleWaiters = [];
  let active = false, initialization, initializing = false, client;

  async function getResult(shortcode) {
    if (!isValidShortcode(shortcode)) return failed();
    const result = await pool.query('SELECT * FROM film_react_analysis WHERE shortcode=$1', [shortcode]);
    const row = result.rows[0];
    if (!row) return failed();
    if (pending(row.state)) {
      const created = Date.parse(row.created_at);
      return Number.isFinite(created) && now() - created < timeoutMs ? { state: 'fetching', analysis: null } : failed();
    }
    if (row.state !== 'ready' || !usableFile(analysisFile(shortcode, env))) return failed();
    let analysis;
    try { analysis = JSON.parse(row.analysis_json); } catch { return failed(); }
    return validAnalysis(analysis) ? { state: 'ready', analysis, path: analysisFile(shortcode, env) } : failed();
  }

  async function markFailed(shortcode, error, attempts, includeReady = false) {
    await pool.query(`UPDATE film_react_analysis SET state='failed',analysis_json=NULL,error=$1,updated_at=$2
      WHERE shortcode=$3 AND attempts=$4 AND state IN (${includeReady ? "'queued','running','ready'" : "'queued','running'"})`,
    [error, new Date(now()).toISOString(), shortcode, attempts]);
  }

  async function speech(filePath, durationSec, signal) {
    // Reuse the shared sort ledger (no FK). post_id=0 denotes a React reference,
    // which may have no posts row. Failed/aborted calls retain estimated spend.
    const attemptId = await withSortLock(async () => {
      signal.throwIfAborted();
      if (await attemptsToday(pool) >= cfg.dailyMax) throw failure('gemini_daily_cap');
      const reservation = await pool.query(`INSERT INTO look_backfill_attempts(post_id,attempted_at,cost_usd)
        VALUES($1,$2,$3) RETURNING id`,
      [0, new Date(now()).toISOString(), estimateCostUsd({ inTokens: 3400, outTokens: 1600 }, cfg)]);
      return reservation.rows[0].id;
    });
    signal.throwIfAborted();
    const result = describe ? await describe({ filePath, durationSec }, { signal, model: cfg.model })
      : await describeReactSpeech({ filePath, durationSec }, {
        client: client || (client = makeGeminiClient(env.GEMINI_API_KEY)), model: cfg.model, signal });
    if (result.usage) await pool.query('UPDATE look_backfill_attempts SET cost_usd=$1 WHERE id=$2',
      [estimateCostUsd(result.usage, cfg), attemptId]);
    signal.throwIfAborted();
    return cleanReactUtterances(result.utterances, durationSec);
  }

  async function run(entry) {
    const stamp = new Date(now()).toISOString();
    const claimed = await pool.query(`UPDATE film_react_analysis SET state='running',updated_at=$1
      WHERE shortcode=$2 AND attempts=$3 AND state='queued'`, [stamp, entry.shortcode, entry.attempts]);
    if (!claimed.rowCount) return;
    const controller = new AbortController();
    entry.controller = controller;
    let timer, temporary, published;
    const deadline = entry.created + timeoutMs;
    const check = () => {
      if (controller.signal.aborted || now() >= deadline) throw failure('analysis_timeout');
    };
    const work = async () => {
      try {
        check();
        const reference = entry.reference || await ensureReference(pool, entry.shortcode);
        check();
        if (!reference || !usableFile(reference.path)) throw failure('reference_not_available');
        const options = { env, signal: controller.signal, timeoutMs: Math.max(1, deadline - now()) };
        const metadata = await probe(reference.path, { ...options, ffprobePath: env.FFPROBE_PATH || 'ffprobe',
          nice: resolveFfmpegNice(env.REACT_FFMPEG_NICE) });
        check();
        const durationSec = metadata.durationSec;
        if (!Number.isFinite(durationSec) || durationSec <= 0) throw failure('invalid_video');
        const visual = await layout(reference.path, durationSec, options);
        check();
        const utterances = metadata.hasAudio ? await speech(reference.path, durationSec, controller.signal) : [];
        check();
        const silences = metadata.hasAudio && utterances.some(item => item.role === 'creator')
          ? await silence(reference.path, durationSec, options) : [];
        check();
        const cues = snapCreatorCues(utterances, silences, durationSec);
        const analysis = { version: 1, seam: visual.seam, layout: visual.layout, cues, creatorMuted: cues.length > 0 };
        if (!validAnalysis(analysis)) throw failure('invalid_analysis');
        const destination = analysisFile(entry.shortcode, env);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        temporary = `${destination}.${crypto.randomBytes(8).toString('hex')}.mp4`;
        await mute(reference.path, temporary, cues, metadata.hasAudio, durationSec, options);
        check();
        if (!usableFile(temporary)) throw failure('invalid_analysis_video');
        // A timed-out or superseded row must never publish a late derivative.
        const ownership = await pool.query("SELECT state,attempts FROM film_react_analysis WHERE shortcode=$1", [entry.shortcode]);
        check();
        if (ownership.rows[0]?.state !== 'running' || ownership.rows[0]?.attempts !== entry.attempts) return;
        fs.renameSync(temporary, destination);
        published = destination;
        await pool.query(`UPDATE film_react_analysis SET state='ready',analysis_json=$1,error=NULL,updated_at=$2
          WHERE shortcode=$3 AND attempts=$4 AND state='running'`,
        [JSON.stringify(analysis), new Date(now()).toISOString(), entry.shortcode, entry.attempts]);
        check();
      } finally {
        // Injected/non-cancellable operations can finish after the outer timeout.
        if (temporary) { try { fs.unlinkSync(temporary); } catch { /* Absent or published. */ } }
      }
    };
    try {
      await Promise.race([work(), new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(failure('analysis_timeout')); }, Math.max(1, deadline - now()));
      })]);
    } catch (error) {
      controller.abort();
      const safe = ['analysis_timeout', 'gemini_daily_cap', 'reference_not_available', 'invalid_video'].includes(error.code)
        ? error.code : 'analysis_failed';
      await markFailed(entry.shortcode, safe, entry.attempts, true);
      if (published) { try { fs.unlinkSync(published); } catch { /* Already absent. */ } }
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (temporary) { try { fs.unlinkSync(temporary); } catch { /* Absent or published. */ } }
    }
  }

  function pump() {
    if (!active && queue.length) {
      active = true;
      const entry = queue.shift();
      run(entry).catch(() => console.error('[React analysis] worker_failed')).finally(() => {
        entries.delete(entry.shortcode);
        active = false;
        pump();
      });
    }
    if (!active && !queue.length) idleWaiters.splice(0).forEach(resolve => resolve());
  }

  async function claim(shortcode, reference) {
    const stamp = new Date(now()).toISOString();
    const enabled = cfg.enabled || !!describe;
    const result = await pool.query(`INSERT INTO film_react_analysis
      (shortcode,state,analysis_json,error,attempts,created_at,updated_at)
      VALUES ($1,$2,NULL,$3,$4,$5,$6) ON CONFLICT (shortcode) DO NOTHING RETURNING attempts,created_at`,
    [shortcode, enabled ? 'queued' : 'failed', enabled ? null : 'gemini_not_configured', enabled ? 1 : 0, stamp, stamp]);
    if (result.rows.length && enabled) {
      const entry = { shortcode, reference, attempts: result.rows[0].attempts, created: Date.parse(result.rows[0].created_at) };
      entries.set(shortcode, entry);
      queue.push(entry);
      if (!initializing) pump();
    }
  }

  function start() {
    if (!initialization) {
      initializing = true;
      initialization = (async () => {
        await pool.query(`UPDATE film_react_analysis SET state='failed',analysis_json=NULL,error='worker_restarted',updated_at=$1
          WHERE state='running' AND created_at <= $2`,
        [new Date(now()).toISOString(), new Date(now() - timeoutMs).toISOString()]);
        const queued = await pool.query("SELECT shortcode,attempts,created_at FROM film_react_analysis WHERE state='queued' ORDER BY created_at,shortcode");
        for (const row of queued.rows) {
          if (!isValidShortcode(row.shortcode)) continue;
          if (!cfg.enabled && !describe) { await markFailed(row.shortcode, 'gemini_not_configured', row.attempts); continue; }
          const entry = { shortcode: row.shortcode, attempts: row.attempts, created: Date.parse(row.created_at) };
          entries.set(entry.shortcode, entry);
          queue.push(entry);
        }
        const ready = await pool.query("SELECT shortcode FROM film_react_refs WHERE state='ready'");
        const shortcodes = new Set(ready.rows.map(row => row.shortcode).filter(isValidShortcode));
        try {
          for (const filename of fs.readdirSync(path.dirname(referenceFile('probe_ref', env)))) {
            const match = /^([A-Za-z0-9_-]{5,64})\.mp4$/.exec(filename);
            if (match) shortcodes.add(match[1]);
          }
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        for (const shortcode of shortcodes) {
          if (usableFile(referenceFile(shortcode, env))) await claim(shortcode);
        }
        initializing = false;
        pump();
      })().catch(error => {
        initialization = undefined;
        initializing = false;
        // Discovery may fail after durable claims. They are recovered afresh on
        // retry; none may begin before startup has completed successfully.
        queue.length = 0;
        entries.clear();
        throw error;
      });
    }
    return initialization;
  }

  async function request(shortcode, reference) {
    if (!isValidShortcode(shortcode)) return failed();
    await start();
    if (reference && entries.has(shortcode)) entries.get(shortcode).reference = reference;
    await claim(shortcode, reference);
    const result = await getResult(shortcode);
    if (result.state === 'failed') {
      const entry = entries.get(shortcode);
      entry?.controller?.abort();
      if (entry) await markFailed(shortcode, 'analysis_timeout', entry.attempts);
      else {
        const row = (await pool.query('SELECT state,attempts FROM film_react_analysis WHERE shortcode=$1', [shortcode])).rows[0];
        if (row && pending(row.state)) await markFailed(shortcode, 'analysis_timeout', row.attempts);
      }
    }
    return result;
  }

  async function waitForIdle() {
    await start();
    if (active || queue.length) await new Promise(resolve => idleWaiters.push(resolve));
  }

  return { start, request, getResult, waitForIdle };
}

module.exports = { createReactAnalysisWorker, analysisFile, validAnalysis };
