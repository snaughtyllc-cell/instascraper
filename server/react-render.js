const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildFfmpegArgs, probeVideo, renderVideo, resolveFfmpegThreads, resolveFfmpegNice, resolveFreezeMargin } = require('./react-ffmpeg');
const transfer = require('./react-transfer');
const { usableFile } = require('./react-reference');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORTCODE = /^[A-Za-z0-9_-]{5,64}$/;

function validateRenderRequest(body, env = process.env) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'invalid_request';
  if (typeof body.jobId !== 'string' || !UUID.test(body.jobId)) return 'invalid_job_id';
  const { crop } = body;
  if (!crop || typeof crop.top !== 'number' || typeof crop.height !== 'number'
    || !Number.isFinite(crop.top) || !Number.isFinite(crop.height)
    || crop.top < 0 || crop.height < 0.2 || crop.top + crop.height > 1) return 'invalid_crop';
  if (!Number.isInteger(body.syncMs) || body.syncMs < -7000 || body.syncMs > 32000) return 'invalid_sync';
  if (!['stitched', 'solo'].includes(body.output)) return 'invalid_output';
  if (typeof body.referenceAudio !== 'boolean') return 'invalid_reference_audio';
  if (!transfer.isDriveUploadUrl(body.uploadUrl)) return 'invalid_upload_url';
  if (!transfer.isHqUrl(body.rawUrl, env)) return 'invalid_raw_url';
  if (!transfer.isHqUrl(body.callbackUrl, env)) return 'invalid_callback_url';
  const ref = body.reference;
  if (!ref || !['instagram', 'url'].includes(ref.kind)) return 'invalid_reference';
  if (ref.kind === 'instagram' && (typeof ref.shortcode !== 'string' || !SHORTCODE.test(ref.shortcode))) return 'invalid_shortcode';
  if (ref.kind === 'url' && !transfer.isHqUrl(ref.url, env)) return 'invalid_reference_url';
  return null;
}

function positiveNumber(value, fallback, integer = false) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && (!integer || Number.isSafeInteger(number)) ? number : fallback;
}

// Only known, static error codes can leave the worker. Never forward exception text.
const FAILURE_CODES = new Set(['worker_restarted', 'invalid_stored_job', 'reference_not_available',
  'reference_seek_out_of_range',
  'source_not_allowed', 'source_http_error', 'source_too_large', 'source_empty', 'source_download_failed',
  'upload_not_allowed', 'upload_empty', 'upload_invalid_range', 'upload_invalid_response', 'upload_http_error',
  'upload_retry_exhausted', 'ffmpeg_failed', 'ffmpeg_timeout', 'ffprobe_failed', 'ffprobe_timeout', 'invalid_video']);
const safeError = error => {
  const code = error?.code || error?.message;
  return FAILURE_CODES.has(code) ? code : 'render_failed';
};

function createReactRenderWorker({ pool, env = process.env, download = transfer.downloadFile,
  probe = probeVideo, render = renderVideo, upload = transfer.uploadOutput, callback = transfer.sendCallback,
  ensureReference = (db, shortcode) => require('./react-reference').ensureReactReference(db, shortcode, { env }),
  lookupAnalysis,
  tempRoot = os.tmpdir() }) {
  const concurrency = positiveNumber(env.REACT_RENDER_CONCURRENCY, 1, true);
  const threads = resolveFfmpegThreads(env.REACT_FFMPEG_THREADS);
  const nice = resolveFfmpegNice(env.REACT_FFMPEG_NICE);
  const freezeMarginSec = resolveFreezeMargin(env.REACT_FREEZE_MARGIN_SEC);
  const jobs = new Map(), queue = [], idleWaiters = [];
  let active = 0, initialization, analysisWorker;

  function getAnalysis(shortcode, reference) {
    if (lookupAnalysis) return lookupAnalysis(shortcode, reference);
    analysisWorker ||= require('./react-analysis').createReactAnalysisWorker({ pool, env });
    return analysisWorker.request(shortcode, reference);
  }

  async function persist(jobId, state, error = null, driveFileId = null) {
    await pool.query(`UPDATE film_react_jobs SET state=$1, error=$2, drive_file_id=$3, updated_at=$4 WHERE job_id=$5`,
      [state, error, driveFileId, new Date().toISOString(), jobId]);
    jobs.set(jobId, state);
  }

  async function notify(body, state, error, driveFileId) {
    try {
      await callback(body.callbackUrl, state === 'done'
        ? { jobId: body.jobId, state, driveFileId } : { jobId: body.jobId, state: 'failed', error },
      { serviceKey: env.FILM_SERVICE_KEY, allowedUrl: url => transfer.isHqUrl(url, env) });
    } catch (callbackError) {
      if (callbackError?.code !== 'callback_http_error') {
        console.error('[React render] callback_pending');
        return;
      }
      // Permanent HTTP failures (including 403) must not be retried on restart.
      console.error('[React render] callback_rejected');
    }
    try {
      await pool.query('UPDATE film_react_jobs SET payload_json=NULL, updated_at=$1 WHERE job_id=$2',
        [new Date().toISOString(), body.jobId]);
    } catch { console.error('[React render] callback_pending'); }
  }

  async function run(entry) {
    const { body } = entry;
    if (entry.state !== 'queued') {
      if (entry.state === 'running') {
        await persist(body.jobId, 'failed', 'worker_restarted');
        await notify(body, 'failed', 'worker_restarted');
      } else await notify(body, entry.state, entry.error, entry.driveFileId);
      return;
    }
    const claim = await pool.query("UPDATE film_react_jobs SET state='running', updated_at=$1 WHERE job_id=$2 AND state='queued'",
      [new Date().toISOString(), body.jobId]);
    if (!claim.rowCount) return;
    jobs.set(body.jobId, 'running');
    let dir, driveFileId, failure;
    try {
      dir = fs.mkdtempSync(path.join(tempRoot, 'film-react-'));
      const rawPath = path.join(dir, 'raw'), referenceDownload = path.join(dir, 'reference');
      const outputPath = path.join(dir, 'output.mp4');
      const allowedUrl = url => transfer.isHqUrl(url, env);
      await download(body.rawUrl, rawPath, {
        maxBytes: positiveNumber(env.REACT_RAW_MAX_MB, 1024) * 1024 * 1024, allowedUrl,
      });
      let referencePath, analysis = null;
      if (body.reference.kind === 'instagram') {
        const ref = await ensureReference(pool, body.reference.shortcode);
        if (!ref) throw Object.assign(new Error('reference_not_available'), { code: 'reference_not_available' });
        referencePath = ref.path;
        // Analysis is an enhancement: failed, pending or missing cached results
        // must leave an otherwise available Instagram reference renderable.
        try {
          const result = await getAnalysis(body.reference.shortcode, ref);
          if (result?.state === 'ready' && result.analysis && typeof result.path === 'string' &&
              usableFile(result.path)) {
            referencePath = result.path;
            analysis = result.analysis;
          }
        } catch { /* The original reference remains usable after analysis failure. */ }
      } else {
        await download(body.reference.url, referenceDownload, { maxBytes: 500 * 1024 * 1024, allowedUrl });
        referencePath = referenceDownload;
      }
      const raw = await probe(rawPath, { ffprobePath: env.FFPROBE_PATH || 'ffprobe', nice });
      const reference = await probe(referencePath, { ffprobePath: env.FFPROBE_PATH || 'ffprobe', nice });
      if (body.output === 'stitched' && body.syncMs < 0 && -body.syncMs / 1000 >= reference.durationSec) {
        throw Object.assign(new Error('reference_seek_out_of_range'), { code: 'reference_seek_out_of_range' });
      }
      await render({ ...body, analysis, rawPath, referencePath, outputPath, rawDuration: raw.durationSec,
        rawHasAudio: raw.hasAudio, referenceHasAudio: reference.hasAudio },
      { ffmpegPath: env.FFMPEG_PATH || 'ffmpeg', threads, nice, freezeMarginSec,
        timeoutMs: positiveNumber(env.REACT_RENDER_TIMEOUT_SEC, 900) * 1000 });
      driveFileId = await upload(body.uploadUrl, outputPath);
    } catch (error) { failure = safeError(error); }
    finally { if (dir) fs.rmSync(dir, { recursive: true, force: true }); }
    const state = failure ? 'failed' : 'done';
    await persist(body.jobId, state, failure || null, driveFileId || null);
    await notify(body, state, failure, driveFileId);
  }

  function pump() {
    while (active < concurrency && queue.length) {
      const entry = queue.shift();
      active++;
      run(entry).catch(() => console.error('[React render] worker_error')).finally(() => {
        active--;
        pump();
      });
    }
    if (!active && !queue.length) idleWaiters.splice(0).forEach(resolve => resolve());
  }

  function start() {
    if (!initialization) initialization = (async () => {
      const result = await pool.query('SELECT * FROM film_react_jobs WHERE payload_json IS NOT NULL ORDER BY created_at, job_id');
      const recovered = [];
      for (const row of result.rows) {
        let body;
        try { body = JSON.parse(row.payload_json); } catch { /* Invalid durable input fails closed. */ }
        if (validateRenderRequest(body, env) || body.jobId.toLowerCase() !== row.job_id) {
          await persist(row.job_id, 'failed', 'invalid_stored_job');
          continue;
        }
        body.jobId = row.job_id;
        jobs.set(row.job_id, row.state);
        recovered.push({ body, state: row.state, error: row.error, driveFileId: row.drive_file_id });
      }
      queue.push(...recovered);
      pump();
    })().catch(error => { initialization = undefined; throw error; });
    return initialization;
  }

  async function enqueue(input) {
    const invalid = validateRenderRequest(input, env);
    if (invalid) throw new Error(invalid);
    // Snapshot validated input; later mutation by an API caller cannot alter queued work.
    const body = JSON.parse(JSON.stringify(input));
    body.jobId = body.jobId.toLowerCase();
    await start();
    if (jobs.has(body.jobId)) return;
    const now = new Date().toISOString();
    const result = await pool.query(`INSERT INTO film_react_jobs (job_id,state,error,payload_json,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (job_id) DO NOTHING RETURNING job_id`,
    [body.jobId, 'queued', null, JSON.stringify(body), now, now]);
    if (!result.rows.length) return;
    jobs.set(body.jobId, 'queued');
    queue.push({ body, state: 'queued' });
    pump();
  }

  async function waitForIdle() {
    await start();
    if (active || queue.length) await new Promise(resolve => idleWaiters.push(resolve));
  }

  return { start, enqueue, waitForIdle };
}

module.exports = { validateRenderRequest, createReactRenderWorker, buildFfmpegArgs };
