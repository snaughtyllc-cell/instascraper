// server/audio.js — Trending Audio ("Reel Radar, but for sounds").
// Ranks the audio tracks used by the reels we ALREADY scrape (musicInfo captured
// on posts.audio_*), so models see which sounds are heating up in their lane.
// Mirrors the radar/suggestion philosophy: pure query builder + pure score fn,
// both unit-testable against sqlite.

function audioConfig(env = process.env) {
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  return {
    maxAgeDays: num(env.AUDIO_MAX_AGE_DAYS, 30),
    minReels: Math.max(1, Math.floor(num(env.AUDIO_MIN_REELS, 2))), // a "trend" needs ≥2 reels
    limit: Math.max(1, Math.floor(num(env.AUDIO_LIMIT, 50))),
    // Trend weighting — distinct creators is the strongest "trending" signal
    // (a sound spreading across creators, not one creator spamming it), then
    // recency, reach (views, log-damped), and raw usage volume.
    wCreators: num(env.AUDIO_W_CREATORS, 10),
    wRecency: num(env.AUDIO_W_RECENCY, 15),
    wViews: num(env.AUDIO_W_VIEWS, 4),
    wReels: num(env.AUDIO_W_REELS, 2),
  };
}

// PURE. Score one aggregated audio row. Higher = hotter.
function trendScore(row, cfg = audioConfig(), nowMs = Date.now()) {
  const creators = Number(row.creator_count) || 0;
  const reels = Number(row.reel_count) || 0;
  const views = Number(row.total_views) || 0;
  const t = row.latest_posted_at ? Date.parse(row.latest_posted_at) : NaN;
  const ageDays = Number.isFinite(t) ? Math.max(0, (nowMs - t) / 86400000) : cfg.maxAgeDays;
  const recency = Math.max(0, 1 - ageDays / cfg.maxAgeDays); // 1 = today → 0 at window edge
  return Math.round(
    creators * cfg.wCreators +
    recency * cfg.wRecency +
    Math.log10(views + 1) * cfg.wViews +
    reels * cfg.wReels
  );
}

// PURE. Build the aggregation query. `niches` scopes to a model's lane (empty +
// all:true = roster-wide, admin). `cutoffIso` is the age boundary (passed for
// deterministic tests; else derived from maxAgeDays). Placeholders are numbered
// sequentially and each used once (SQLite adapter rewrites $N → ? positionally).
function buildTrendingAudioQuery(niches, { all = false, cutoffIso, minReels = 2 } = {}) {
  const list = all ? [] : (Array.isArray(niches) ? niches : []).filter(Boolean);
  if (!all && list.length === 0) return { sql: null, params: [] };

  // The SQLite adapter rewrites $N → ? by APPEARANCE order (not by number), so
  // placeholders must appear in the SQL in ascending order matching `params`.
  // Appearance order here: cutoff ($1) → niches ($2..) → minReels (last).
  const params = [cutoffIso];
  let nicheClause = '';
  if (!all) {
    const ph = list.map((_, i) => `$${i + 2}`).join(', ');
    nicheClause = ` AND COALESCE(posts.content_type, ct.content_type) IN (${ph})`;
    params.push(...list);
  }
  const minIdx = params.length + 1;
  params.push(minReels);

  const sql = `
    SELECT posts.audio_id AS audio_id,
           MAX(posts.audio_title) AS audio_title,
           MAX(posts.audio_author) AS audio_author,
           MAX(posts.is_original_audio) AS is_original_audio,
           COUNT(*) AS reel_count,
           COUNT(DISTINCT posts.account_handle) AS creator_count,
           COALESCE(SUM(posts.view_count), 0) AS total_views,
           MAX(posts.view_count) AS max_views,
           MAX(posts.posted_at) AS latest_posted_at
    FROM posts
    LEFT JOIN creator_types ct ON posts.account_handle = ct.account_handle
    WHERE posts.audio_id IS NOT NULL AND posts.audio_id <> ''
      AND posts.posted_at >= $1
      AND (posts.soft_deleted = 0 OR posts.soft_deleted IS NULL)
      AND (posts.archived = 0 OR posts.archived IS NULL)${nicheClause}
    GROUP BY posts.audio_id
    HAVING COUNT(*) >= $${minIdx}`;
  return { sql, params };
}

// PURE. Build the "reels using this audio" query (expand view / example reels).
function buildAudioReelsQuery(audioId, niches, { all = false, limit = 12 } = {}) {
  const params = [audioId];
  let nicheClause = '';
  if (!all) {
    const list = (Array.isArray(niches) ? niches : []).filter(Boolean);
    if (list.length === 0) return { sql: null, params: [] };
    const ph = list.map((_, i) => `$${i + 2}`).join(', ');
    nicheClause = ` AND COALESCE(posts.content_type, ct.content_type) IN (${ph})`;
    params.push(...list);
  }
  const limIdx = params.length + 1;
  params.push(limit);
  const sql = `
    SELECT posts.id, posts.shortcode, posts.audio_id, posts.view_count, posts.account_handle,
           posts.caption, posts.post_url, posts.posted_at,
           COALESCE(posts.content_type, ct.content_type) AS niche
    FROM posts
    LEFT JOIN creator_types ct ON posts.account_handle = ct.account_handle
    WHERE posts.audio_id = $1
      AND (posts.soft_deleted = 0 OR posts.soft_deleted IS NULL)
      AND (posts.archived = 0 OR posts.archived IS NULL)
      AND posts.video_cache_status = 'cached'${nicheClause}
    ORDER BY posts.view_count DESC NULLS LAST
    LIMIT $${limIdx}`;
  return { sql, params };
}

// Run the aggregation, score + rank in JS, attach up to `examples` top reels each.
async function trendingAudio(db, { niches = [], all = false, cfg = audioConfig(), nowMs = Date.now(), examples = 3 } = {}) {
  const cutoffIso = new Date(nowMs - cfg.maxAgeDays * 86400000).toISOString();
  const built = buildTrendingAudioQuery(niches, { all, cutoffIso, minReels: cfg.minReels });
  if (!built.sql) return [];
  const rows = (await db.query(built.sql, built.params)).rows || [];
  const ranked = rows
    .map(r => ({ ...r, trend_score: trendScore(r, cfg, nowMs) }))
    .sort((a, b) => b.trend_score - a.trend_score)
    .slice(0, cfg.limit);

  if (ranked.length === 0) return [];
  // Attach example reels for the ranked audios in one query, grouped in JS.
  const ids = ranked.map(r => r.audio_id);
  const ph = ids.map((_, i) => `$${i + 1}`).join(', ');
  const exParams = [...ids];
  let nicheClause = '';
  if (!all) {
    const list = (Array.isArray(niches) ? niches : []).filter(Boolean);
    const nph = list.map((_, i) => `$${ids.length + 1 + i}`).join(', ');
    if (list.length) { nicheClause = ` AND COALESCE(posts.content_type, ct.content_type) IN (${nph})`; exParams.push(...list); }
  }
  const exSql = `
    SELECT posts.id, posts.shortcode, posts.audio_id, posts.view_count, posts.account_handle, posts.post_url
    FROM posts
    LEFT JOIN creator_types ct ON posts.account_handle = ct.account_handle
    WHERE posts.audio_id IN (${ph})
      AND (posts.soft_deleted = 0 OR posts.soft_deleted IS NULL)
      AND (posts.archived = 0 OR posts.archived IS NULL)
      AND posts.video_cache_status = 'cached'${nicheClause}
    ORDER BY posts.view_count DESC NULLS LAST`;
  const exRows = (await db.query(exSql, exParams)).rows || [];
  const byAudio = {};
  for (const r of exRows) {
    (byAudio[r.audio_id] = byAudio[r.audio_id] || []);
    if (byAudio[r.audio_id].length < examples) byAudio[r.audio_id].push(r);
  }
  return ranked.map(r => ({ ...r, exampleReels: byAudio[r.audio_id] || [] }));
}

module.exports = { audioConfig, trendScore, buildTrendingAudioQuery, buildAudioReelsQuery, trendingAudio };
