const path = require('path');
const crypto = require('crypto');
const realFs = require('fs');
const realFetch = require('node-fetch');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { DEFAULT_THUMB_DIR } = require('./thumbnails');

const DEFAULT_VIDEO_DIR = path.join(DEFAULT_THUMB_DIR, 'videos');
const VIDEO_MAX_MB = Number(process.env.VIDEO_MAX_MB || 60);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const sharedInflight = new Map();

function videoFilePath(post, videoDir = DEFAULT_VIDEO_DIR) {
  const key = post.id != null ? post.id : post.shortcode;
  return path.join(videoDir, `${key}.mp4`);
}

function tempVideoPath(key, videoDir = DEFAULT_VIDEO_DIR) {
  // [R2-7] crypto suffix: concurrent same-id/different-url writers must not collide.
  return path.join(videoDir, `${key}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`);
}

async function downloadVideo(post, deps = {}) {
  const fs = deps.fs || realFs;
  const fetch = deps.fetch || realFetch;
  const videoDir = deps.videoDir || DEFAULT_VIDEO_DIR;
  const inflight = deps.inflight || sharedInflight;

  if (!post || !post.video_url) return { status: 'error', error: 'no video_url' };
  const key = post.id != null ? post.id : post.shortcode;
  const file = videoFilePath(post, videoDir);

  try {
    const st = fs.statSync(file);
    if (st.size > 0) return { status: 'cached', path: file };
  } catch { /* not cached yet */ }

  // [CX-5] key on id+url so a re-scrape with a fresh video_url starts a new download
  // instead of reusing (and resolving to) a stale in-flight promise for an old URL.
  const inflightKey = `${key}:${post.video_url}`;
  if (inflight.has(inflightKey)) return inflight.get(inflightKey);

  const job = (async () => {
    try {
      const res = await fetch(post.video_url, { headers: { 'User-Agent': UA }, timeout: 30000 });
      if (res.status === 403 || res.status === 404) return { status: 'expired', error: `HTTP ${res.status}` };
      if (!res.ok) return { status: 'error', error: `HTTP ${res.status}` };

      const cap = VIDEO_MAX_MB * 1024 * 1024;
      const cl = Number(res.headers.get('content-length'));
      if (Number.isFinite(cl) && cl > cap) return { status: 'skipped', error: `content-length ${cl} > cap` };
      const ctype = res.headers.get('content-type') || '';
      if (ctype && !ctype.startsWith('video/')) return { status: 'error', error: `bad content-type ${ctype}` };

      fs.mkdirSync(videoDir, { recursive: true });
      const tmp = tempVideoPath(key, videoDir);
      let seen = 0;
      const cap$ = new Transform({
        transform(chunk, _enc, cb) {
          seen += chunk.length;
          if (seen > cap) return cb(new Error('too_big'));
          cb(null, chunk);
        },
      });

      try {
        // [CX-6, R2-6] stream through a byte-counting Transform into a real write
        // stream via stream.pipeline — the promise only resolves after the write
        // stream has flushed/closed, so rename-after-await is safe (never before flush).
        await pipeline(res.body, cap$, fs.createWriteStream(tmp));
        if (seen === 0) {
          // [R3-4] empty-body guard: never rename a 0-byte file to the final path.
          try { fs.unlinkSync(tmp); } catch { /* ENOENT ok */ }
          return { status: 'error', error: 'empty body' };
        }
        fs.renameSync(tmp, file); // only after flush, only if non-empty
        return { status: 'cached', path: file };
      } catch (err) {
        try { fs.unlinkSync(tmp); } catch { /* ENOENT ok */ }
        if (err.message === 'too_big') return { status: 'skipped', error: 'stream over cap' };
        return { status: 'error', error: err.message };
      }
    } catch (err) {
      return { status: 'error', error: err.message };
    } finally {
      inflight.delete(inflightKey);
    }
  })();

  inflight.set(inflightKey, job);
  return job;
}

module.exports = { DEFAULT_VIDEO_DIR, VIDEO_MAX_MB, videoFilePath, tempVideoPath, downloadVideo };
