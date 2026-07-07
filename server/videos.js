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

async function sweepVideos(opts = {}, deps = {}) {
  const { maxAgeDays = 30, freshnessDays = 14, batchLimit = 60, concurrency = 3 } = opts;
  const db = deps.db || require('./db');
  const download = deps.download || ((p) => downloadVideo(p, { videoDir: deps.videoDir }));
  const delay = deps.delay || ((ms) => new Promise(r => setTimeout(r, ms)));
  const started = Date.now();

  // [R2-4, R3-3] Both cutoffs are JS-computed ISO-Z strings: posted_at and
  // video_url_refreshed_at are both stored via .toISOString() in both Postgres
  // and SQLite (scraper.js:632), so a single ISO-Z cutoff is correct for both
  // backends — unlike sweepThumbnails' scraped_at compare, no PG/SQLite format
  // split is needed here.
  const now = deps.now ? deps.now() : Date.now();
  const nowIso = new Date(now).toISOString();
  const retentionCutoff = new Date(now - maxAgeDays * 86400000).toISOString();
  const freshnessCutoff = new Date(now - freshnessDays * 86400000).toISOString();

  const sel = await db.query(
    `SELECT id, shortcode, video_url FROM posts
     WHERE video_url IS NOT NULL
       AND posted_at IS NOT NULL AND posted_at >= $1
       AND ( video_cache_status = 'pending'
             OR (video_cache_status IS NULL AND video_url_refreshed_at >= $2) )
     ORDER BY id DESC LIMIT $3`,
    [retentionCutoff, freshnessCutoff, batchLimit]
  );
  const posts = sel.rows || [];
  const tally = { attempted: 0, cached: 0, expired: 0, skipped: 0, errored: 0 };

  // [CX-3] URL-guarded write: post.video_url is the URL captured at selection
  // time (the one actually downloaded). If a concurrent re-scrape has since
  // written a fresh video_url onto this row, the WHERE clause matches 0 rows
  // and the status write is silently skipped — the row stays 'pending' so the
  // next sweep picks it up with the fresh URL instead of clobbering it.
  //
  // NOTE: unlike Postgres, this repo's SQLite adapter (db.js) does a naive
  // `sql.replace(/\$(\d+)/g, '?')` that does NOT collapse repeated $N
  // placeholders to a single bound value — reusing $1 in both the SET clause
  // and the CASE guard (as sketched in the task brief) produces 6 "?" marks
  // for only 5 bound params and throws "Too few parameter values were
  // provided" under SQLite. Every placeholder below is therefore given its
  // own number, with `status` passed twice ($1 and $3) — identical semantics,
  // correct positional binding on both backends.
  async function writeStatus(post, status, error) {
    await db.query(
      `UPDATE posts SET video_cache_status = $1, video_cache_error = $2,
        video_cached_at = CASE WHEN $3 = 'cached' THEN $4 ELSE video_cached_at END
       WHERE id = $5 AND video_url = $6`,
      [status, error || null, status, nowIso, post.id, post.video_url]
    );
  }

  async function worker(queue) {
    while (queue.length) {
      const post = queue.shift();
      tally.attempted++;
      let outcome;
      try {
        const r = await download(post);
        outcome = r.status;
        await writeStatus(post, r.status, r.error);
      } catch (err) {
        outcome = 'error';
        try { await writeStatus(post, 'error', err.message); } catch { /* ignore */ }
      }
      if (outcome === 'cached') tally.cached++;
      else if (outcome === 'expired') tally.expired++;
      else if (outcome === 'skipped') tally.skipped++;
      else tally.errored++;
      await delay(100 + Math.floor(Math.random() * 200));
    }
  }

  const queue = posts.slice();
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker(queue)));
  console.log(`[Metric] video_sweep cached=${tally.cached} expired=${tally.expired} skipped=${tally.skipped} errored=${tally.errored} attempted=${tally.attempted} ms=${Date.now() - started}`);
  return tally;
}

async function pruneOldVideos(opts = {}, deps = {}) {
  const { maxAgeDays = 30 } = opts;
  const fs = deps.fs || realFs;
  const db = deps.db || require('./db');
  const videoDir = deps.videoDir || DEFAULT_VIDEO_DIR;
  const now = deps.now ? deps.now() : Date.now();
  const cutoff = new Date(now - maxAgeDays * 86400000).toISOString();

  const sel = await db.query(
    `SELECT id, video_cache_status FROM posts WHERE posted_at < $1 AND video_cache_status IS NOT NULL`,
    [cutoff]
  );
  const rows = sel.rows || [];
  let deleted = 0;

  // [R4-1] Self-healing two-phase claim. A row already at 'pruning' (an
  // orphan left by an interrupted prior run) skips straight to unlink +
  // finalize — Phase 1's `<> 'pruning'` guard would otherwise match 0 rows
  // for it and strand it forever. A fresh row must win the Phase-1 claim
  // (0 rows changed = raced by a concurrent run, or already handled) before
  // its file is touched.
  for (const row of rows) {
    if (row.video_cache_status !== 'pruning') {
      const claim = await db.query(
        `UPDATE posts SET video_cache_status='pruning', video_cached_at=NULL
         WHERE id=$1 AND posted_at < $2 AND video_cache_status IS NOT NULL AND video_cache_status <> 'pruning'`,
        [row.id, cutoff]
      );
      if ((claim.rowCount || claim.changes || 0) === 0) continue; // raced / already handled
    }
    // row is now 'pruning' (freshly claimed OR a pre-existing orphan) -> delete file + finalize
    try {
      fs.unlinkSync(videoFilePath(row, videoDir));
    } catch (e) {
      if (e.code !== 'ENOENT') { console.error('[Prune] unlink failed', e.code); continue; }
    }
    await db.query(`UPDATE posts SET video_cache_status=NULL WHERE id=$1 AND video_cache_status='pruning'`, [row.id]);
    deleted++;
  }

  console.log(`[Metric] video_prune deleted=${deleted}`);
  return { deleted };
}

module.exports = { DEFAULT_VIDEO_DIR, VIDEO_MAX_MB, videoFilePath, tempVideoPath, downloadVideo, sweepVideos, pruneOldVideos };
