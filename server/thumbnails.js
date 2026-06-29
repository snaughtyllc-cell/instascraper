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

async function sweepThumbnails(opts = {}, deps = {}) {
  const { maxAgeDays = 14, batchLimit = 200, concurrency = 4 } = opts;
  const db = deps.db || require('./db');
  const download = deps.download || ((p) => downloadThumbnail(p, { thumbDir: deps.thumbDir }));
  const delay = deps.delay || ((ms) => new Promise(r => setTimeout(r, ms)));
  const started = Date.now();

  // 'pending' is set by a scrape (insert OR conflict-upsert) the moment it refreshes
  // thumbnail_url, so a pending row ALWAYS has a freshly-scraped URL — sweep it
  // regardless of scraped_at (this is the heal path: a re-scraped OLD post keeps its
  // old scraped_at but gets status='pending', and must still be downloaded). A pending
  // row leaves the pool after one attempt (cached/expired/error), so this never
  // repeatedly hammers a URL. Only legacy NULL-status rows (pre-migration, URLs likely
  // already expired) get the recency filter, so we don't keep retrying dead URLs.
  // Stored scraped_at is ISO 'YYYY-MM-DDThh:mm:ssZ' → lexicographic compare = chronological, PG/SQLite-safe.
  const now = deps.now ? deps.now() : Date.now();
  const cutoff = new Date(now - maxAgeDays * 86400000).toISOString().slice(0, 19) + 'Z';
  const sel = await db.query(
    `SELECT id, shortcode, thumbnail_url FROM posts
     WHERE thumbnail_url IS NOT NULL
       AND ( thumbnail_cache_status = 'pending'
             OR (thumbnail_cache_status IS NULL AND scraped_at >= $1) )
     ORDER BY id DESC LIMIT $2`,
    [cutoff, batchLimit]
  );
  const posts = sel.rows || [];
  const tally = { attempted: 0, cached: 0, expired: 0, errored: 0 };

  async function worker(queue) {
    while (queue.length) {
      const post = queue.shift();
      tally.attempted++;
      let outcome;
      try {
        const r = await download(post);
        outcome = r.status;
        await db.query(`UPDATE posts SET thumbnail_cache_status = $1, thumbnail_cache_error = $2 WHERE id = $3`,
          [r.status, r.error || null, post.id]);
      } catch (err) {
        outcome = 'error';
        try { await db.query(`UPDATE posts SET thumbnail_cache_status = 'error', thumbnail_cache_error = $1 WHERE id = $2`, [err.message, post.id]); } catch { /* ignore */ }
      }
      if (outcome === 'cached') tally.cached++;
      else if (outcome === 'expired') tally.expired++;
      else tally.errored++;
      await delay(100 + Math.floor(Math.random() * 200));
    }
  }

  const queue = posts.slice();
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker(queue)));
  console.log(`[Metric] thumbnail_sweep cached=${tally.cached} expired=${tally.expired} errored=${tally.errored} attempted=${tally.attempted} ms=${Date.now() - started}`);
  return tally;
}

module.exports = { downloadThumbnail, sweepThumbnails, DEFAULT_THUMB_DIR };
