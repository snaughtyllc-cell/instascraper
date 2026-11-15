const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const Database = require('better-sqlite3');
const { ensureFilmTables } = require('./film-migration');
const { validateRenderRequest, createReactRenderWorker, buildFfmpegArgs } = require('./react-render');
const { isDriveUploadUrl, downloadFile, uploadOutput, sendCallback } = require('./react-transfer');
const { appRequest } = require('./test-support/app-request');

const env = { HQ_PUBLIC_URL: 'https://hq.example', FILM_SERVICE_KEY: 'test-key' };
function request(overrides = {}) {
  return { jobId: 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb', reference: { kind: 'url', url: 'https://hq.example/reference' },
    rawUrl: 'https://hq.example/raw', uploadUrl: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=secret',
    callbackUrl: 'https://hq.example/api/filming/react/callback', crop: { top: 0, height: 0.5 }, syncMs: 500,
    output: 'stitched', referenceAudio: true, ...overrides };
}

async function database(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE models (id INTEGER PRIMARY KEY)');
  const pool = { query: async (sql, values = []) => {
    assert.deepEqual([...sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1])), values.map((_, i) => i + 1));
    const stmt = db.prepare(sql.replace(/\$\d+/g, '?'));
    if (stmt.reader) { const rows = stmt.all(...values); return { rows, rowCount: rows.length }; }
    const info = stmt.run(...values);
    return { rows: [], rowCount: info.changes };
  } };
  await ensureFilmTables(pool, { isPg: false });
  return { db, pool };
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'react-worker-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const callbacks = [], renders = [];
  const dependencies = { env, tempRoot: dir,
    download: async (url, file) => fs.writeFileSync(file, 'video'),
    probe: async () => ({ durationSec: 3, hasAudio: true }),
    render: async opts => { renders.push(opts); fs.writeFileSync(opts.outputPath, 'rendered'); },
    upload: async () => 'drive-file-id', callback: async (url, payload) => callbacks.push(payload) };
  return { dir, callbacks, renders, dependencies };
}

test('render contract rejects invalid values and SSRF variants, and exports pure builder', () => {
  assert.equal(validateRenderRequest(request(), env), null);
  assert.equal(typeof buildFfmpegArgs, 'function');
  for (const overrides of [
    { jobId: '../../oops' }, { crop: { top: -0.1, height: 0.5 } }, { crop: { top: 0, height: 0.19 } },
    { crop: { top: 0.6, height: 0.5 } }, { crop: { top: NaN, height: 0.5 } },
    { crop: { top: 0, height: Infinity } }, { crop: { top: '0', height: 0.5 } },
    { syncMs: -7001 }, { syncMs: 32001 }, { syncMs: 0.5 }, { output: 'other' }, { referenceAudio: 'true' },
    { rawUrl: 'http://hq.example/raw' }, { rawUrl: 'https://evil.example/raw' },
    { rawUrl: 'https://hq.example.evil.example/raw' }, { rawUrl: 'https://hq.example:444/raw' },
    { rawUrl: 'https://user:password@hq.example/raw' }, { callbackUrl: 'https://evil.example/callback' },
    { reference: { kind: 'url', url: 'https://evil.example/ref' } }, { reference: { kind: 'file', url: '/etc/passwd' } },
    { reference: { kind: 'instagram', shortcode: '../bad' } }, { reference: { kind: 'instagram', shortcode: 'tiny' } },
    { uploadUrl: 'https://www.googleapis.com.evil.example/upload/drive/v3/files?uploadType=resumable' },
    { uploadUrl: 'https://www.googleapis.com/upload/drive/v3/files/extra?uploadType=resumable' },
    { uploadUrl: 'http://www.googleapis.com/upload/drive/v3/files?uploadType=resumable' },
    { uploadUrl: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=media' },
    { uploadUrl: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&uploadType=media' },
  ]) assert.equal(typeof validateRenderRequest(request(overrides), env), 'string', JSON.stringify(overrides));
  assert.equal(typeof validateRenderRequest(request(), {}), 'string');
  assert.equal(validateRenderRequest(request({ syncMs: -7000 }), env), null);
  assert.equal(validateRenderRequest(request({ syncMs: 32000, reference: { kind: 'instagram', shortcode: 'valid_123' } }), env), null);
});

test('queue is durable, case-insensitively idempotent and removes all temporary data', async t => {
  const { db, pool } = await database(t), f = fixture(t);
  const worker = createReactRenderWorker({ pool, ...f.dependencies });
  await Promise.all([worker.enqueue(request()), worker.enqueue(request()), worker.enqueue(request({ jobId: request().jobId.toUpperCase() }))]);
  await worker.waitForIdle();
  assert.equal(f.renders.length, 1);
  assert.deepEqual(f.callbacks, [{ jobId: request().jobId, state: 'done', driveFileId: 'drive-file-id' }]);
  assert.equal(db.prepare('SELECT state FROM film_react_jobs').get().state, 'done');
  assert.equal(db.prepare('SELECT payload_json FROM film_react_jobs').get().payload_json, null);
  const restarted = createReactRenderWorker({ pool, ...f.dependencies });
  await restarted.enqueue(request());
  await restarted.waitForIdle();
  assert.equal(f.renders.length, 1);
  assert.deepEqual(fs.readdirSync(f.dir), []);
});

test('worker passes trusted thread and priority configuration instead of request overrides', async t => {
  for (const [configured, expected] of [
    [{}, { threads: 2, nice: 10 }],
    [{ REACT_FFMPEG_THREADS: '4', REACT_FFMPEG_NICE: '6' }, { threads: 4, nice: 6 }],
    [{ REACT_FFMPEG_THREADS: '100', REACT_FFMPEG_NICE: '0' }, { threads: 16, nice: 0 }],
    [{ REACT_FFMPEG_THREADS: 'invalid', REACT_FFMPEG_NICE: '-1' }, { threads: 2, nice: 10 }],
  ]) {
    const { pool } = await database(t), f = fixture(t), probes = [], renders = [];
    const worker = createReactRenderWorker({ pool, ...f.dependencies, env: { ...env, ...configured },
      probe: async (file, options) => { probes.push(options); return { durationSec: 3, hasAudio: true }; },
      render: async (opts, options) => { renders.push(options); fs.writeFileSync(opts.outputPath, 'rendered'); } });
    await worker.enqueue(request({ threads: 1000, nice: 0 }));
    await worker.waitForIdle();
    assert.deepEqual(probes, Array.from({ length: 2 }, () => ({ ffprobePath: 'ffprobe', nice: expected.nice })));
    assert.deepEqual(renders, [{ ffmpegPath: 'ffmpeg', ...expected, timeoutMs: 900000 }]);
    assert.equal(f.callbacks[0].state, 'done');
  }
});

test('worker enforces configured concurrency and atomic database queue claims', async t => {
  const { pool } = await database(t), f = fixture(t);
  let active = 0, peak = 0;
  const worker = createReactRenderWorker({ pool, ...f.dependencies, env: { ...env, REACT_RENDER_CONCURRENCY: '2' },
    render: async opts => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 10));
      fs.writeFileSync(opts.outputPath, 'output'); active--; } });
  await Promise.all(Array.from({ length: 5 }, (_, i) => worker.enqueue(request({ jobId: `aaaaaaaa-1111-2222-3333-bbbbbbbbbbb${i}` }))));
  await worker.waitForIdle();
  assert.equal(peak, 2);
  assert.equal(f.callbacks.length, 5);
});

test('recovery retries do not publish partial queues and duplicate rows cannot render twice', async t => {
  const { db, pool } = await database(t), f = fixture(t), body = request();
  db.prepare('INSERT INTO film_react_jobs (job_id,state,payload_json) VALUES (?,?,?)')
    .run(body.jobId, 'queued', JSON.stringify(body));
  const row = db.prepare('SELECT * FROM film_react_jobs').get();
  const query = pool.query;
  let selects = 0, failed = false;
  pool.query = async (sql, values) => {
    if (/^SELECT \*/.test(sql)) {
      selects++;
      return { rows: [row, row, { ...row, job_id: 'bbbbbbbb-1111-2222-3333-bbbbbbbbbbbb', payload_json: '{}' }] };
    }
    if (!failed && values?.[1] === 'invalid_stored_job') { failed = true; throw new Error('database unavailable'); }
    return query(sql, values);
  };
  const worker = createReactRenderWorker({ pool, ...f.dependencies });
  await assert.rejects(worker.start(), /database unavailable/);
  assert.equal(f.renders.length, 0);
  await worker.start();
  await worker.waitForIdle();
  assert.equal(selects, 2);
  assert.equal(f.renders.length, 1);
  assert.equal(f.callbacks.length, 1);
});

test('worker failures use static error codes and clean temporary files', async t => {
  const { db, pool } = await database(t), f = fixture(t);
  const worker = createReactRenderWorker({ pool, ...f.dependencies,
    render: async () => { throw new Error('https://secret.example/token?secret=capability'); } });
  await worker.enqueue(request());
  await worker.waitForIdle();
  assert.deepEqual(f.callbacks, [{ jobId: request().jobId, state: 'failed', error: 'render_failed' }]);
  assert.equal(db.prepare('SELECT error FROM film_react_jobs').get().error, 'render_failed');
  assert.deepEqual(fs.readdirSync(f.dir), []);
});

test('raw download failures and reference seeks beyond EOF fail safely before rendering', async t => {
  const { pool } = await database(t), f = fixture(t);
  const worker = createReactRenderWorker({ pool, ...f.dependencies,
    download: async (url, file, options) => {
      assert.equal(options.maxBytes, 1024 * 1024 * 1024);
      assert.equal(options.allowedUrl(url), true);
      fs.writeFileSync(file, 'partial');
      throw Object.assign(new Error('secret source URL'), { code: 'source_too_large' });
    } });
  await worker.enqueue(request());
  await worker.waitForIdle();
  assert.equal(f.callbacks[0].error, 'source_too_large');
  assert.equal(f.renders.length, 0);
  assert.deepEqual(fs.readdirSync(f.dir), []);
  const seekWorker = createReactRenderWorker({ pool, ...f.dependencies });
  await seekWorker.enqueue(request({ jobId: 'bbbbbbbb-1111-2222-3333-bbbbbbbbbbbb', syncMs: -7000 }));
  await seekWorker.waitForIdle();
  assert.equal(f.callbacks[1].error, 'reference_seek_out_of_range');
  assert.equal(f.renders.length, 0);
});

test('restart fails interrupted jobs with callbacks, resumes queued jobs and retries pending completed callbacks', async t => {
  const { db, pool } = await database(t), f = fixture(t);
  for (const [suffix, state] of [['1', 'running'], ['2', 'queued'], ['3', 'done'], ['4', 'failed']]) {
    const body = request({ jobId: `aaaaaaaa-1111-2222-3333-bbbbbbbbbbb${suffix}` });
    db.prepare('INSERT INTO film_react_jobs (job_id,state,error,payload_json,drive_file_id) VALUES (?,?,?,?,?)')
      .run(body.jobId, state, state === 'failed' ? 'render_failed' : null, JSON.stringify(body), state === 'done' ? 'previous-id' : null);
  }
  const worker = createReactRenderWorker({ pool, ...f.dependencies });
  await worker.start();
  await worker.waitForIdle();
  assert.equal(f.renders.length, 1);
  assert.equal(f.callbacks.length, 4);
  assert.equal(f.callbacks[0].error, 'worker_restarted');
  assert.ok(f.callbacks.some(c => c.driveFileId === 'previous-id'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM film_react_jobs WHERE payload_json IS NOT NULL').get().n, 0);
});

test('undelivered callback is persisted and retried on restart without re-rendering', async t => {
  const { db, pool } = await database(t), f = fixture(t);
  const worker = createReactRenderWorker({ pool, ...f.dependencies, callback: async () => { throw new Error('callback unavailable'); } });
  await worker.enqueue(request());
  await worker.waitForIdle();
  assert.equal(db.prepare('SELECT state FROM film_react_jobs').get().state, 'done');
  assert.ok(db.prepare('SELECT payload_json FROM film_react_jobs').get().payload_json);
  const restarted = createReactRenderWorker({ pool, ...f.dependencies });
  await restarted.start();
  await restarted.waitForIdle();
  assert.equal(f.renders.length, 1);
  assert.equal(f.callbacks[0].driveFileId, 'drive-file-id');
});

test('permanently rejected callbacks are never retried after restart', async t => {
  const { db, pool } = await database(t), f = fixture(t);
  let attempts = 0;
  const worker = createReactRenderWorker({ pool, ...f.dependencies, callback: async () => {
    attempts++;
    throw Object.assign(new Error('rejected'), { code: 'callback_http_error' });
  } });
  await worker.enqueue(request());
  await worker.waitForIdle();
  assert.equal(db.prepare('SELECT payload_json FROM film_react_jobs').get().payload_json, null);
  const restarted = createReactRenderWorker({ pool, ...f.dependencies });
  await restarted.start();
  await restarted.waitForIdle();
  assert.equal(attempts, 1);
  assert.deepEqual(f.callbacks, []);
});

const socketlessServers = new Map();
async function localServer(t, handler) {
  const server = http.createServer(handler);
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
    // Restricted sandboxes deny even loopback listeners. Dispatch real Node HTTP
    // messages through the same local server using the repo's socketless harness.
    const base = `http://127.0.0.1:${41000 + socketlessServers.size}`;
    socketlessServers.set(base, server);
    t.after(() => socketlessServers.delete(base));
    return base;
  }
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
async function testFetch(url, options = {}) {
  const parsed = new URL(url), server = socketlessServers.get(parsed.origin);
  if (!server) return require('node-fetch')(url, options);
  let body = options.body;
  if (body && typeof body !== 'string' && !Buffer.isBuffer(body)) {
    const chunks = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    body = Buffer.concat(chunks);
  }
  const explicitLength = Object.entries(options.headers || {}).find(([key]) => key.toLowerCase() === 'content-length')?.[1];
  if (explicitLength !== undefined) assert.equal(Number(explicitLength), body ? Buffer.byteLength(body) : 0);
  let abort;
  try {
    const result = await Promise.race([
      appRequest({ handle: (req, res) => server.emit('request', req, res) }, {
        method: options.method || 'GET', path: parsed.pathname + parsed.search, body, headers: options.headers,
      }),
      new Promise((resolve, reject) => {
        abort = () => reject(new Error('request aborted'));
        if (options.signal?.aborted) abort();
        else options.signal?.addEventListener('abort', abort, { once: true });
      }),
    ]);
    return new (require('node-fetch').Response)(require('stream').Readable.from([Buffer.from(result.text)]), { status: result.status, headers: result.headers });
  } finally { options.signal?.removeEventListener('abort', abort); }
}
const localAllowed = url => new URL(url).hostname === '127.0.0.1';
const noWait = async () => {};

test('Drive PUT uses exact lengths and resumes 308 after querying the committed byte range', async t => {
  const f = fixture(t), file = path.join(f.dir, 'upload.mp4');
  fs.writeFileSync(file, '0123456789');
  const requests = [];
  const base = await localServer(t, (req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (requests.length === 1) { res.writeHead(308, { Range: 'bytes=0-3' }); res.end(); }
      else if (requests.length === 2) { res.writeHead(308, { Range: 'bytes=0-3' }); res.end(); }
      else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"id":"uploaded-id"}'); }
    });
  });
  const url = `${base}/upload`;
  assert.equal(isDriveUploadUrl(url), false);
  assert.equal(await uploadOutput(url, file, { allowedUrl: localAllowed, sleep: noWait, fetchImpl: testFetch }), 'uploaded-id');
  assert.equal(requests.length, 3);
  assert.equal(requests[0].headers['content-length'], '10');
  assert.equal(requests[0].headers['content-type'], 'video/mp4');
  assert.equal(requests[1].headers['content-range'], 'bytes */10');
  assert.equal(requests[1].body, '');
  assert.equal(requests[2].headers['content-range'], 'bytes 4-9/10');
  assert.equal(requests[2].headers['content-length'], '6');
  assert.equal(requests[2].body, '456789');
});

test('Drive retries 5xx via status query, bounds retries, rejects redirects and never retries 403', async t => {
  const f = fixture(t), file = path.join(f.dir, 'upload.mp4');
  fs.writeFileSync(file, '0123456789');
  for (const status of [503, 403, 307]) {
    let count = 0;
    const base = await localServer(t, (req, res) => { count++; req.resume(); res.writeHead(status, { Location: 'http://127.0.0.1:1/leak' }); res.end(); });
    await assert.rejects(uploadOutput(`${base}/upload`, file, { allowedUrl: localAllowed, sleep: noWait, fetchImpl: testFetch }),
      error => error.code === (status === 503 ? 'upload_retry_exhausted' : 'upload_http_error'));
    assert.equal(count, status === 503 ? 5 : 1);
  }
});

test('Drive queries status after losing the final response body and rejects invalid server ranges', async t => {
  const f = fixture(t), file = path.join(f.dir, 'upload.mp4');
  fs.writeFileSync(file, '0123456789');
  const requests = [];
  const id = await uploadOutput(request().uploadUrl, file, { sleep: noWait, fetchImpl: async (url, options) => {
    requests.push(options.headers);
    if (requests.length === 1) return { status: 200, json: async () => { throw new Error('connection reset'); } };
    return { status: 200, json: async () => ({ id: 'committed-id' }) };
  } });
  assert.equal(id, 'committed-id');
  assert.equal(requests.length, 2);
  assert.equal(requests[1]['Content-Range'], 'bytes */10');
  for (const range of ['bytes=0-100', 'bytes=5-6', 'bytes=0-9007199254740992', 'nonsense']) {
    let calls = 0, destroys = 0;
    await assert.rejects(uploadOutput(request().uploadUrl, file, { sleep: noWait, fetchImpl: async () => {
      calls++;
      return { status: 308, headers: new (require('node-fetch').Headers)({ Range: range }), body: { destroy: () => destroys++ } };
    } }), { code: 'upload_invalid_range' });
    assert.equal(calls, 2);
    assert.equal(destroys, 2);
  }
});

test('callback sends authenticated done/failed JSON, retries network/5xx and stops on 403/redirect', async t => {
  const received = [];
  const base = await localServer(t, (req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      received.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
      res.writeHead(received.length < 3 ? 503 : 204); res.end();
    });
  });
  const opts = { allowedUrl: localAllowed, sleep: noWait, serviceKey: 'test-key', fetchImpl: testFetch };
  await sendCallback(`${base}/callback`, { jobId: request().jobId, state: 'done', driveFileId: 'drive-id' }, opts);
  assert.equal(received.length, 3);
  assert.equal(received[0].headers.authorization, 'Bearer test-key');
  await sendCallback(`${base}/callback`, { jobId: request().jobId, state: 'failed', error: 'render_failed' }, opts);
  assert.equal(received[3].body.state, 'failed');
  for (const status of [403, 307, 503]) {
    let count = 0;
    const failBase = await localServer(t, (req, res) => { count++; req.resume(); res.writeHead(status); res.end(); });
    await assert.rejects(sendCallback(`${failBase}/callback`, { state: 'failed' }, opts));
    assert.equal(count, status === 503 ? 4 : 1);
  }
  let calls = 0;
  await sendCallback(`${base}/callback`, { state: 'done' }, { ...opts, fetchImpl: async (...args) => {
    if (++calls < 3) throw new Error('network');
    return testFetch(...args);
  } });
  assert.equal(calls, 3);
});

test('downloads stream with byte caps and timeout, reject redirects, retry 429/5xx, and never retry 403', async t => {
  const f = fixture(t), file = path.join(f.dir, 'source');
  let count = 0;
  const base = await localServer(t, (req, res) => {
    count++;
    if (req.url === '/retry' && count === 1) { res.writeHead(429); res.end(); }
    else if (req.url === '/large') { res.writeHead(200); res.write('1234'); res.end('5678'); }
    else if (req.url === '/redirect') { res.writeHead(302, { Location: '/okay' }); res.end(); }
    else if (req.url === '/forbidden') { res.writeHead(403); res.end(); }
    else if (req.url === '/slow') { res.writeHead(200); res.write('1'); }
    else res.end('1234');
  });
  const opts = { allowedUrl: localAllowed, maxBytes: 5, sleep: noWait, fetchImpl: testFetch };
  await downloadFile(`${base}/retry`, file, opts);
  assert.equal(fs.readFileSync(file, 'utf8'), '1234');
  assert.equal(count, 2);
  await assert.rejects(downloadFile(`${base}/large`, file, opts), { code: 'source_too_large' });
  assert.equal(fs.existsSync(file), false);
  for (const url of ['/redirect', '/forbidden']) {
    const before = count;
    await assert.rejects(downloadFile(`${base}${url}`, file, opts), { code: 'source_http_error' });
    assert.equal(count, before + 1);
  }
  await assert.rejects(downloadFile(`${base}/slow`, file, { ...opts, timeoutMs: 20 }), { code: 'source_download_failed' });
  assert.equal(fs.existsSync(file), false);
});
