const fs = require('fs');
const fetch = require('node-fetch');
const { Transform } = require('stream');
const { pipeline, finished } = require('stream/promises');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const retryable = status => status === 429 || status >= 500 && status <= 599;

class TransferError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function secureUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash ? url : null;
  } catch { return null; }
}

function isHqUrl(value, env = process.env) {
  const url = secureUrl(value), hq = secureUrl(env.HQ_PUBLIC_URL);
  return !!(url && hq && url.origin === hq.origin);
}

function isDriveUploadUrl(value) {
  const url = secureUrl(value);
  return !!(url && url.host === 'www.googleapis.com' && url.pathname === '/upload/drive/v3/files'
    && url.searchParams.getAll('uploadType').length === 1 && url.searchParams.get('uploadType') === 'resumable');
}

async function downloadFile(url, destination, { maxBytes, timeoutMs = 600000, allowedUrl = isHqUrl,
  fetchImpl = fetch, sleep = delay } = {}) {
  if (!allowedUrl(url)) throw new TransferError('source_not_allowed');
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; attempt < 3; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new TransferError('source_download_failed');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      const response = await fetchImpl(url, { redirect: 'manual', signal: controller.signal });
      if (!response.ok) {
        response.body?.destroy?.();
        if (retryable(response.status) && attempt < 2) { await sleep(250 * 2 ** attempt); continue; }
        throw new TransferError('source_http_error');
      }
      const length = Number(response.headers.get('content-length'));
      if (Number.isFinite(length) && length > maxBytes) {
        response.body?.destroy?.();
        throw new TransferError('source_too_large');
      }
      let received = 0;
      const counter = new Transform({ transform(chunk, encoding, callback) {
        received += chunk.length;
        callback(received > maxBytes ? new TransferError('source_too_large') : null, chunk);
      } });
      await pipeline(response.body, counter, fs.createWriteStream(destination, { mode: 0o600 }));
      if (!received) throw new TransferError('source_empty');
      return;
    } catch (error) {
      fs.rmSync(destination, { force: true });
      if (error instanceof TransferError) throw error;
      if (attempt === 2) throw new TransferError('source_download_failed');
      await sleep(250 * 2 ** attempt);
    } finally { clearTimeout(timer); }
  }
}

async function driveResult(response) {
  // A truncated/lost final response can follow a committed upload. Let the
  // caller query session state again rather than report an uncertain failure.
  const body = await response.json();
  if (typeof body?.id === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(body.id)) return body.id;
  throw new TransferError('upload_invalid_response');
}

function committedOffset(response, size) {
  const range = response.headers.get('range');
  if (!range) return 0;
  const match = /^bytes=0-(\d+)$/.exec(range);
  const offset = match ? Number(match[1]) + 1 : NaN;
  if (!Number.isSafeInteger(offset) || offset < 1 || offset > size) throw new TransferError('upload_invalid_range');
  return offset;
}

async function uploadOutput(url, file, { allowedUrl = isDriveUploadUrl, fetchImpl = fetch,
  sleep = delay, timeoutMs = 600000 } = {}) {
  if (!allowedUrl(url)) throw new TransferError('upload_not_allowed');
  const size = fs.statSync(file).size;
  if (!Number.isSafeInteger(size) || size <= 0) throw new TransferError('upload_empty');
  let offset = 0, query = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await sleep(250 * 2 ** (attempt - 1));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let stream;
    try {
      if (query) {
        const response = await fetchImpl(url, { method: 'PUT', redirect: 'manual', signal: controller.signal, size: 65536,
          headers: { 'Content-Length': '0', 'Content-Range': `bytes */${size}` } });
        if (response.status === 200 || response.status === 201) return await driveResult(response);
        if (response.status !== 308) {
          response.body?.destroy?.();
          if (retryable(response.status)) continue;
          throw new TransferError('upload_http_error');
        }
        response.body?.destroy?.();
        offset = committedOffset(response, size);
        if (offset === size) continue;
      }
      stream = fs.createReadStream(file, { start: offset });
      // A transport can reject before it consumes the body. Keep the pending
      // filesystem open/error lifecycle handled even in that path.
      stream.on('error', () => {});
      const headers = { 'Content-Length': String(size - offset), 'Content-Type': 'video/mp4' };
      if (offset) headers['Content-Range'] = `bytes ${offset}-${size - 1}/${size}`;
      const response = await fetchImpl(url, { method: 'PUT', redirect: 'manual', signal: controller.signal,
        headers, body: stream, size: 65536 });
      if (response.status === 200 || response.status === 201) return await driveResult(response);
      response.body?.destroy?.();
      if (response.status !== 308 && !retryable(response.status)) throw new TransferError('upload_http_error');
      query = true;
    } catch (error) {
      if (error instanceof TransferError) throw error;
      query = true;
    } finally {
      if (stream) {
        stream.destroy();
        await finished(stream).catch(() => {});
      }
      clearTimeout(timer);
    }
  }
  throw new TransferError('upload_retry_exhausted');
}

async function sendCallback(url, payload, { serviceKey = process.env.FILM_SERVICE_KEY,
  allowedUrl = isHqUrl, fetchImpl = fetch, sleep = delay, timeoutMs = 30000 } = {}) {
  if (!allowedUrl(url) || !serviceKey) throw new TransferError('callback_not_allowed');
  // Initial attempt plus three retries on network errors, 429, and 5xx only.
  for (let attempt = 0; attempt < 4; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { method: 'POST', redirect: 'manual', signal: controller.signal,
        headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      response.body?.destroy?.();
      if (response.ok) return;
      if (!retryable(response.status)) throw new TransferError('callback_http_error');
    } catch (error) {
      if (error instanceof TransferError) throw error;
    } finally { clearTimeout(timer); }
    if (attempt < 3) await sleep(250 * 2 ** attempt);
  }
  throw new TransferError('callback_retry_exhausted');
}

module.exports = { TransferError, isHqUrl, isDriveUploadUrl, downloadFile, uploadOutput, sendCallback };
