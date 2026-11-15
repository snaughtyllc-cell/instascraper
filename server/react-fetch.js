const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');
const videos = require('./videos');
const scraper = require('./scraper');
const { probeVideo, resolveFfmpegNice } = require('./react-ffmpeg');
const { isValidShortcode, referenceFile, usableFile } = require('./react-reference');

const DAY = 24 * 60 * 60 * 1000;
const RETRY_AFTER = 6 * 60 * 60 * 1000;
const TRANSIENT_RETRY_AFTER = 10 * 60 * 1000;
const TRANSIENT_FAILURE_CODES = new Set(['apify_failed', 'apify_busy', 'apify_network', 'fetch_timeout', 'worker_restarted']);
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);
const FAILURE_CODES = new Set(['fetch_timeout', 'apify_failed', 'apify_busy', 'apify_network', 'apify_error_stub', 'no_video',
  'download_failed', 'download_too_large', 'invalid_video_type', 'invalid_video_url', 'invalid_video']);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const failure = code => Object.assign(new Error(code), { code });
const unavailable = () => ({ state: 'unavailable', launched: false });
const positive = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;

function allowedVideoUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.port
      && ['cdninstagram.com', 'fbcdn.net', 'instagram.com'].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch { return false; }
}

// Keep the existing capped streaming downloader and temporary-file publication;
// tighten its transport for fetched references and only retry transient HTTP errors.
async function downloadReference(post, { videoDir, signal = new AbortController().signal, fetchImpl = fetch, sleep = delay } = {}) {
  if (!allowedVideoUrl(post.video_url)) throw failure('invalid_video_url');
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal.aborted) throw failure('fetch_timeout');
    const outcome = await videos.downloadVideo(post, { videoDir, inflight: new Map(),
      fetch: async (url, options) => {
        const response = await fetchImpl(url, { ...options, signal, redirect: 'manual' });
        if (response.ok && !/^video\//i.test(response.headers.get('content-type') || '')) {
          response.body?.destroy?.();
          throw failure('invalid_video_type');
        }
        if (!response.ok) response.body?.destroy?.();
        return response;
      } });
    if (signal.aborted) throw failure('fetch_timeout');
    if (outcome.status === 'cached') return outcome;
    if (/^HTTP (429|5\d\d)$/.test(outcome.error || '') && attempt < 2) {
      await sleep(250 * 2 ** attempt);
      continue;
    }
    throw failure(outcome.status === 'skipped' ? 'download_too_large'
      : outcome.error === 'invalid_video_type' ? 'invalid_video_type' : 'download_failed');
  }
}

function createApifyClient(env = process.env, fetchImpl = fetch, sleep = delay, timeoutMs = 180000) {
  const retryDelays = [15000, 30000, 60000];
  const deadlines = new WeakMap();
  const configuredMemory = Number(env.REACT_FETCH_MEMORY_MB);
  const memory = Number.isSafeInteger(configuredMemory) && configuredMemory > 0 ? configuredMemory : 512;

  async function backoff(ms, signal) {
    let onAbort, timer;
    try {
      const pause = sleep === delay ? new Promise(resolve => { timer = setTimeout(resolve, ms); })
        : Promise.resolve().then(() => sleep(ms, signal));
      await Promise.race([pause, new Promise((_, reject) => {
        onAbort = () => reject(failure('fetch_timeout'));
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      })]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  async function request(route, resource, signal, options = {}, params = {}) {
    if (!env.APIFY_API_KEY) throw failure('apify_failed');
    if (!deadlines.has(signal)) deadlines.set(signal, Date.now() + timeoutMs);
    const url = new URL(`https://api.apify.com/v2/${resource}`);
    url.search = new URLSearchParams({ token: env.APIFY_API_KEY, ...params }).toString();
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) throw failure('fetch_timeout');
      let response;
      try {
        response = await fetchImpl(url.toString(), { ...options, signal, redirect: 'manual',
          headers: { 'Content-Type': 'application/json' } });
      } catch {
        throw failure(signal.aborted ? 'fetch_timeout' : 'apify_network');
      }
      if (response.ok) {
        try { return await response.json(); }
        catch { throw failure(signal.aborted ? 'fetch_timeout' : 'apify_network'); }
      }
      let body;
      try { body = await response.json(); }
      catch { /* Error bodies are untrusted and may not be JSON. */ }
      finally { response.body?.destroy?.(); }
      const errorType = typeof body?.error?.type === 'string' ? body.error.type : '';
      const safeType = /^[a-z0-9-]{1,64}$/.test(errorType) && !errorType.includes(env.APIFY_API_KEY)
        ? errorType : 'unknown';
      console.error(`[React fetch] apify_http route=${route} status=${response.status} type=${safeType}`);
      if (signal.aborted) throw failure('fetch_timeout');
      const transient = response.status !== 403 && (response.status === 402 || response.status === 429
        || response.status >= 500 && response.status <= 599 || /limit|memory|concurrent|rate/i.test(errorType));
      if (!transient) throw failure('apify_failed');
      const wait = retryDelays[attempt];
      if (wait === undefined || Date.now() + wait >= deadlines.get(signal)) throw failure('apify_busy');
      await backoff(wait, signal);
    }
  }
  return {
    startRun: async (actor, input, signal) => (await request('startRun', `acts/${actor}/runs`, signal,
      { method: 'POST', body: JSON.stringify(input) },
      { timeout: String(Math.max(1, Math.ceil(timeoutMs / 1000))), memory: String(memory) })).data,
    getRun: async (id, signal) => (await request('getRun', `actor-runs/${encodeURIComponent(id)}`, signal)).data,
    getItems: (id, signal) => request('getItems', `actor-runs/${encodeURIComponent(id)}/dataset/items`, signal),
    abortRun: async (id, signal) => (await request('abortRun', `actor-runs/${encodeURIComponent(id)}/abort`, signal,
      { method: 'POST' }, { gracefully: 'false' })).data,
  };
}

function createReactFetchWorker({ pool, env = process.env, now = Date.now, apify,
  fetchImpl = fetch, sleep = delay, download = downloadReference, probe = probeVideo,
  budgetStatus = scraper.budgetStatus, recordRunLaunch = scraper.recordRunLaunch,
  recordRunCompletion = scraper.recordRunCompletion } = {}) {
  const configuredConcurrency = Number(env.REACT_FETCH_CONCURRENCY);
  const concurrency = Number.isSafeInteger(configuredConcurrency) && configuredConcurrency > 0
    ? Math.min(configuredConcurrency, 2) : 1;
  const configuredTimeout = positive(env.REACT_FETCH_TIMEOUT_SEC, 180) * 1000;
  const timeoutMs = configuredTimeout <= 2147483647 ? configuredTimeout : 180000;
  const configuredCap = Number(env.REACT_FETCH_DAILY_MAX ?? 100);
  const dailyMax = Number.isSafeInteger(configuredCap) && configuredCap >= 0 ? configuredCap : 100;
  const client = apify || createApifyClient(env, fetchImpl, sleep, timeoutMs);
  const claims = new Map(), queue = [], idleWaiters = [];
  let active = 0, initialization, heartbeat;

  async function transaction(work) {
    // The application DB exposes pinned-connection transactions on both backends.
    if (typeof pool.transaction !== 'function') throw failure('fetch_failed');
    return pool.transaction(async db => {
      if (env.DATABASE_URL || pool._pool) await db.query('SELECT pg_advisory_xact_lock(1953719666)');
      return work(db);
    });
  }

  async function recoverStale(db) {
    const cutoff = new Date(now() - 10 * 60 * 1000).toISOString();
    const stale = await db.query("SELECT shortcode FROM film_react_refs WHERE state='fetching' AND updated_at < $1", [cutoff]);
    for (const row of stale.rows) {
      const recovered = await db.query("UPDATE film_react_refs SET state='failed', error='worker_restarted' WHERE shortcode=$1 AND state='fetching' AND updated_at < $2",
        [row.shortcode, cutoff]);
      if (recovered.rowCount) await db.query('DELETE FROM film_react_ref_attempts WHERE shortcode=$1 AND started_at IS NULL', [row.shortcode]);
    }
  }

  function start() {
    if (!initialization) initialization = transaction(recoverStale)
      .catch(error => { initialization = undefined; throw error; });
    return initialization;
  }

  async function touchClaims() {
    for (const entry of claims.values()) {
      await pool.query("UPDATE film_react_refs SET updated_at=$1 WHERE shortcode=$2 AND state='fetching' AND attempts=$3",
        [new Date(now()).toISOString(), entry.shortcode, entry.attempt]);
    }
  }

  async function finalizeRun(entry) {
    if (!entry.runId) return;
    if (!TERMINAL.has(entry.runObject?.status) && client.abortRun) {
      if (!entry.abortPromise) entry.abortPromise = (async () => {
        const controller = new AbortController();
        let timer;
        try {
          const run = await Promise.race([client.abortRun(entry.runId, controller.signal), new Promise((_, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(failure('apify_failed')); }, 5000);
          })]);
          if (run && run.id === entry.runId) entry.runObject = run;
        } catch { console.error('[React fetch] apify_abort_pending'); }
        finally { clearTimeout(timer); controller.abort(); }
      })();
      await entry.abortPromise;
    }
    // Unknown remote state must stay running in the existing ledger so the
    // budget guard still reserves its projected cost after local cancellation.
    if (!TERMINAL.has(entry.runObject?.status)) {
      console.error('[React fetch] ledger_completion_pending');
      return;
    }
    // A slow launch insert can finish after the overall timeout. Its late
    // continuation calls us again once the row exists; never memoize completion
    // before that insert, or it could leave a permanent running ledger row.
    if (!entry.launchRecorded) return;
    if (!entry.completionPromise) entry.completionPromise = (async () => {
      try { await recordRunCompletion(pool, { runId: entry.runId, runObject: entry.runObject,
        status: entry.runObject.status === 'SUCCEEDED' ? 'succeeded' : 'failed', nowMs: now() }); }
      catch { console.error('[React fetch] ledger_completion_failed'); }
    })();
    return entry.completionPromise;
  }

  async function fetchActorItems(entry, actorId, input, signal, attemptId) {
    const run = await client.startRun(actorId, input, signal);
    if (!run || typeof run.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(run.id)) throw failure('apify_failed');
    entry.runId = run.id;
    entry.runObject = run;
    // Only accepted runs consume the launch cap. Reinsert a reservation if a
    // non-cancellable launch returns after the local timeout released it.
    const stamp = new Date(now()).toISOString();
    await pool.query(`INSERT INTO film_react_ref_attempts (attempt_id,shortcode,created_at,started_at)
      VALUES ($1,$2,$3,$4) ON CONFLICT (attempt_id) DO UPDATE SET started_at=excluded.started_at`,
    [attemptId, entry.shortcode, stamp, stamp]);
    await recordRunLaunch(pool, { runId: run.id, actorId,
      purpose: 'react_ref', query: `reel:${entry.shortcode}`, nowMs: now() });
    entry.launchRecorded = true;
    if (signal.aborted) {
      // An injected/non-cancellable client can return after the deadline. Record
      // its cost without allowing that late continuation to publish any files.
      if (entry.finished) await finalizeRun(entry);
      throw failure('fetch_timeout');
    }
    let current = run;
    while (current.status !== 'SUCCEEDED') {
      if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(current.status)) throw failure('apify_failed');
      await sleep(1000);
      if (signal.aborted) throw failure('fetch_timeout');
      current = await client.getRun(run.id, signal);
      if (!current) throw failure('apify_failed');
      entry.runObject = current;
    }
    return client.getItems(run.id, signal);
  }

  async function fetchReference(entry, signal, deadline) {
    const directUrls = [`https://www.instagram.com/reel/${entry.shortcode}/`];
    entry.runAttemptIds = [entry.id];
    let items = await fetchActorItems(entry, scraper.REEL_ACTOR_ID, { directUrls, resultsLimit: 1 }, signal, entry.id);
    const usableItem = candidates => Array.isArray(candidates) && candidates.find(candidate => candidate
      && !scraper.isErrorStub(candidate) && typeof candidate.videoUrl === 'string' && allowedVideoUrl(candidate.videoUrl));
    let item = usableItem(items);
    if (!item) {
      // A successful reel run without a playable URL gets one generic fallback.
      // Complete its cost ledger before replacing the current remote run.
      await finalizeRun(entry);
      if (signal.aborted) throw failure('fetch_timeout');
      const attemptId = crypto.randomUUID();
      await transaction(async db => {
        const budget = await budgetStatus(db, now());
        const count = await db.query('SELECT COUNT(*) AS total FROM film_react_ref_attempts WHERE started_at >= $1 OR started_at IS NULL',
          [new Date(now() - DAY).toISOString()]);
        if (budget.over || budget.blocked || Number(count.rows[0]?.total) >= dailyMax) throw failure('apify_busy');
        if (signal.aborted) throw failure('fetch_timeout');
        await db.query('INSERT INTO film_react_ref_attempts (attempt_id,shortcode,created_at) VALUES ($1,$2,$3)',
          [attemptId, entry.shortcode, new Date(now()).toISOString()]);
      });
      entry.runAttemptIds.push(attemptId);
      if (signal.aborted) {
        await pool.query('DELETE FROM film_react_ref_attempts WHERE attempt_id=$1 AND started_at IS NULL', [attemptId]);
        throw failure('fetch_timeout');
      }
      entry.runId = entry.runObject = entry.launchRecorded = entry.abortPromise = entry.completionPromise = undefined;
      items = await fetchActorItems(entry, scraper.GENERIC_ACTOR_ID,
        { directUrls, resultsType: 'posts', resultsLimit: 1 }, signal, attemptId);
      item = usableItem(items);
    }
    if (!item) throw failure(Array.isArray(items) && items.length && items.every(scraper.isErrorStub) ? 'apify_error_stub' : 'no_video');
    if (signal.aborted) throw failure('fetch_timeout');
    const finalPath = referenceFile(entry.shortcode, env);
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    entry.dir = fs.mkdtempSync(path.join(path.dirname(finalPath), `.${entry.shortcode}-`));
    const outcome = await download({ shortcode: entry.shortcode, video_url: item.videoUrl },
      { videoDir: entry.dir, signal, fetchImpl, sleep });
    if (signal.aborted) throw failure('fetch_timeout');
    const staged = videos.videoFilePath({ shortcode: entry.shortcode }, entry.dir);
    if (outcome?.status !== 'cached' || !usableFile(staged)) throw failure(outcome?.status === 'skipped' ? 'download_too_large' : 'download_failed');
    const metadata = await probe(staged, { ffprobePath: env.FFPROBE_PATH || 'ffprobe',
      nice: resolveFfmpegNice(env.REACT_FFMPEG_NICE), timeoutMs: Math.max(1, deadline - Date.now()) });
    if (signal.aborted) throw failure('fetch_timeout');
    if (!Number.isFinite(metadata?.durationSec) || metadata.durationSec <= 0) throw failure('invalid_video');
    return { staged, finalPath, durationSec: metadata.durationSec };
  }

  async function run(entry) {
    const claimed = await transaction(async db => {
      const ownership = await db.query("UPDATE film_react_refs SET updated_at=$1 WHERE shortcode=$2 AND state='fetching' AND attempts=$3",
        [new Date(now()).toISOString(), entry.shortcode, entry.attempt]);
      if (!ownership.rowCount) return false;
      const budget = await budgetStatus(db, now());
      if (budget.over || budget.blocked) {
        await db.query("UPDATE film_react_refs SET state='failed', error='budget_blocked', updated_at=$1 WHERE shortcode=$2 AND attempts=$3",
          [new Date(now()).toISOString(), entry.shortcode, entry.attempt]);
        await db.query('DELETE FROM film_react_ref_attempts WHERE attempt_id=$1', [entry.id]);
        console.log('[Metric] react_fetch blocked=budget');
        console.error('[React fetch] failed code=budget_blocked');
        return false;
      }
      return true;
    });
    if (!claimed) return;
    const controller = new AbortController(), deadline = Date.now() + timeoutMs;
    let timer, error;
    try {
      const result = await Promise.race([fetchReference(entry, controller.signal, deadline), new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(failure('fetch_timeout')); }, timeoutMs);
      })]);
      await transaction(async db => {
        if (controller.signal.aborted) throw failure('fetch_timeout');
        const updated = await db.query("UPDATE film_react_refs SET state='ready', error=NULL, duration_sec=$1, updated_at=$2 WHERE shortcode=$3 AND state='fetching' AND attempts=$4",
          [result.durationSec, new Date(now()).toISOString(), entry.shortcode, entry.attempt]);
        if (controller.signal.aborted || Date.now() >= deadline) throw failure('fetch_timeout');
        if (updated.rowCount) {
          fs.renameSync(result.staged, result.finalPath);
          entry.publishedPath = result.finalPath;
        }
      });
    } catch (caught) {
      error = FAILURE_CODES.has(caught?.code || caught?.message) ? (caught.code || caught.message) : 'fetch_failed';
      console.error(`[React fetch] failed code=${error}`);
      const failed = await pool.query("UPDATE film_react_refs SET state='failed', error=$1, updated_at=$2 WHERE shortcode=$3 AND state='fetching' AND attempts=$4",
        [error, new Date(now()).toISOString(), entry.shortcode, entry.attempt]);
      if (failed.rowCount && entry.publishedPath) fs.rmSync(entry.publishedPath, { force: true });
    } finally {
      entry.finished = true;
      clearTimeout(timer);
      controller.abort();
      if (entry.dir) fs.rmSync(entry.dir, { recursive: true, force: true });
      await finalizeRun(entry);
      for (const id of entry.runAttemptIds || [entry.id]) {
        await pool.query('DELETE FROM film_react_ref_attempts WHERE attempt_id=$1 AND started_at IS NULL', [id]);
      }
      console.log(`[Metric] react_fetch outcome=${error || 'ready'}`);
    }
  }

  function pump() {
    while (active < concurrency && queue.length) {
      const entry = queue.shift();
      active++;
      run(entry).catch(async () => {
        console.error('[React fetch] worker_error');
        console.error('[React fetch] failed code=fetch_failed');
        try {
          await transaction(async db => {
            const failed = await db.query("UPDATE film_react_refs SET state='failed', error='fetch_failed', updated_at=$1 WHERE shortcode=$2 AND state='fetching' AND attempts=$3",
              [new Date(now()).toISOString(), entry.shortcode, entry.attempt]);
            if (failed.rowCount) {
              await db.query('DELETE FROM film_react_ref_attempts WHERE attempt_id=$1 AND started_at IS NULL', [entry.id]);
              if (entry.publishedPath) fs.rmSync(entry.publishedPath, { force: true });
            }
          });
        } catch { console.error('[React fetch] persistence_failed'); }
      }).finally(() => {
        if (claims.get(entry.shortcode) === entry) claims.delete(entry.shortcode);
        active--;
        pump();
      });
    }
    if (!active && !queue.length) {
      clearInterval(heartbeat);
      heartbeat = undefined;
      idleWaiters.splice(0).forEach(resolve => resolve());
    }
  }

  async function request(shortcode) {
    if (!isValidShortcode(shortcode)) return unavailable();
    await start();
    const result = await transaction(async db => {
      // Recover every orphan, including unrelated queued rows whose reservations
      // would otherwise continue consuming the daily allowance after a restart.
      await recoverStale(db);
      // Older workers stamped attempts before Apify accepted a run. Release
      // those rejected launches across the whole failed cohort; real launches
      // remain charged through their corresponding cost-ledger entries.
      await db.query(`DELETE FROM film_react_ref_attempts WHERE EXISTS (
        SELECT 1 FROM film_react_refs refs
        WHERE refs.shortcode=film_react_ref_attempts.shortcode AND refs.state='failed' AND refs.error='apify_failed'
        AND NOT EXISTS (SELECT 1 FROM apify_runs runs
          WHERE runs.purpose='react_ref' AND runs.query='reel:' || refs.shortcode
          AND substr(runs.started_at,1,19) >= substr(film_react_ref_attempts.created_at,1,19)
          AND substr(runs.started_at,1,19) <= substr(refs.updated_at,1,19)))`);
      const selected = await db.query('SELECT * FROM film_react_refs WHERE shortcode=$1', [shortcode]);
      const row = selected.rows[0];
      if (row?.state === 'ready' && usableFile(referenceFile(shortcode, env))) {
        return { state: 'ready', durationSec: row.duration_sec, launched: false };
      }
      if (row?.state === 'fetching') return { state: 'fetching', launched: false };
      if (row?.state === 'failed' && Date.parse(row.updated_at) > now()
        - (TRANSIENT_FAILURE_CODES.has(row.error) ? TRANSIENT_RETRY_AFTER : RETRY_AFTER)) return unavailable();
      const budget = await budgetStatus(db, now());
      if (budget.over || budget.blocked) { console.log('[Metric] react_fetch blocked=budget'); return unavailable(); }
      const count = await db.query('SELECT COUNT(*) AS total FROM film_react_ref_attempts WHERE started_at >= $1 OR started_at IS NULL',
        [new Date(now() - DAY).toISOString()]);
      if (Number(count.rows[0]?.total) >= dailyMax) { console.log('[Metric] react_fetch blocked=daily_cap'); return unavailable(); }
      const stamp = new Date(now()).toISOString(), id = crypto.randomUUID();
      const claimed = await db.query(`INSERT INTO film_react_refs (shortcode,state,error,duration_sec,attempts,created_at,updated_at)
        VALUES ($1,'fetching',NULL,NULL,1,$2,$3)
        ON CONFLICT (shortcode) DO UPDATE SET state='fetching',error=NULL,duration_sec=NULL,
        attempts=film_react_refs.attempts+1,updated_at=excluded.updated_at
        WHERE film_react_refs.state <> 'fetching' RETURNING attempts`, [shortcode, stamp, stamp]);
      if (!claimed.rows.length) return { state: 'fetching', launched: false };
      await db.query('INSERT INTO film_react_ref_attempts (attempt_id,shortcode,created_at) VALUES ($1,$2,$3)', [id, shortcode, stamp]);
      return { state: 'fetching', launched: true, entry: { id, shortcode, attempt: claimed.rows[0].attempts } };
    });
    if (result.entry) {
      const { entry } = result;
      delete result.entry;
      claims.set(shortcode, entry);
      queue.push(entry);
      if (!heartbeat) {
        heartbeat = setInterval(() => touchClaims().catch(() => console.error('[React fetch] heartbeat_failed')), 60000);
        heartbeat.unref();
      }
      pump();
    }
    return result;
  }

  async function waitForIdle() {
    await start();
    if (active || queue.length) await new Promise(resolve => idleWaiters.push(resolve));
  }

  return { start, request, waitForIdle };
}

module.exports = { createReactFetchWorker, createApifyClient, downloadReference, allowedVideoUrl };
