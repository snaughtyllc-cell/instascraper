const path = require('path');
const realFs = require('fs');
const realFetch = require('node-fetch');

const DEFAULT_THUMB_DIR = path.join(__dirname, 'thumbnails');
const sharedInflight = new Map();
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

async function downloadThumbnail(post, deps = {}) {
  const fs = deps.fs || realFs;
  const fetch = deps.fetch || realFetch;
  const thumbDir = deps.thumbDir || DEFAULT_THUMB_DIR;
  const inflight = deps.inflight || sharedInflight;

  if (!post || !post.thumbnail_url) return { status: 'error', error: 'no thumbnail_url' };
  const file = path.join(thumbDir, `${post.shortcode}.jpg`);

  try {
    const st = fs.statSync(file);
    if (st.size > 0) return { status: 'cached', path: file };
  } catch { /* not cached yet */ }

  if (inflight.has(post.shortcode)) return inflight.get(post.shortcode);

  const job = (async () => {
    try {
      const res = await fetch(post.thumbnail_url, { headers: { 'User-Agent': UA }, timeout: 15000 });
      if (res.status === 403 || res.status === 404) return { status: 'expired', error: `HTTP ${res.status}` };
      if (!res.ok) return { status: 'error', error: `HTTP ${res.status}` };
      const ctype = res.headers.get('content-type') || '';
      if (ctype && !ctype.startsWith('image/')) return { status: 'error', error: `bad content-type ${ctype}` };
      const buf = await res.buffer();
      if (!buf || buf.length === 0) return { status: 'error', error: 'empty body' };
      fs.mkdirSync(thumbDir, { recursive: true });
      const tmp = path.join(thumbDir, `${post.shortcode}.${process.pid}.${Date.now()}.tmp`);
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, file);
      return { status: 'cached', path: file };
    } catch (err) {
      return { status: 'error', error: err.message };
    } finally {
      inflight.delete(post.shortcode);
    }
  })();

  inflight.set(post.shortcode, job);
  return job;
}

module.exports = { downloadThumbnail, DEFAULT_THUMB_DIR };
