const { modelScopeClause } = require('./model-scope');
const { effectiveNicheExpr } = require('./sort-status');
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

function nicheMatchExpr(niches, params) {
  if (!niches.length) return '0';
  const ph = niches.map(value => {
    params.push(value);
    return `$${params.length}`;
  }).join(', ');
  return `CASE WHEN ${effectiveNicheExpr()} IN (${ph}) THEN 1 ELSE 0 END`;
}

// PURE. Build the aggregation query. Model niches rank audio; non-model niche
// selections remain hard filters. `cutoffIso` is the age boundary (passed for
// deterministic tests; else derived from maxAgeDays). Placeholders are numbered
// sequentially and each used once (SQLite adapter rewrites $N → ? positionally).
function buildTrendingAudioQuery(niches, { all = false, cutoffIso, minReels = 2, modelId = null } = {}) {
  const list = all ? [] : (Array.isArray(niches) ? niches : []).filter(Boolean);
  const modelScoped = !all && Number(modelId) > 0;
  if (!all && !modelScoped && list.length === 0) return { sql: null, params: [] };

  // The SQLite adapter rewrites $N → ? by APPEARANCE order (not by number), so
  // placeholders must appear in the SQL in ascending order matching `params`.
  // The model's niche rank appears in SELECT before the WHERE placeholders.
  const params = [];
  const nicheRank = modelScoped ? `MAX(${nicheMatchExpr(list, params)})` : '0';
  params.push(cutoffIso);
  const cutoffIdx = params.length;
  let nicheClause = '';
  if (modelScoped) {
    nicheClause = ` AND ${effectiveNicheExpr()} IS NOT NULL`;
  } else if (!all) {
    const ph = list.map((_, i) => `$${params.length + 1 + i}`).join(', ');
    nicheClause = ` AND ${effectiveNicheExpr()} IN (${ph})`;
    params.push(...list);
  }
  if (modelScoped) {
    const scope = modelScopeClause('posts', params.length + 1);
    nicheClause += ` AND ${scope.clause}`;
    params.push(...scope.params(Number(modelId)));
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
           MAX(posts.posted_at) AS latest_posted_at,
           ${nicheRank} AS niche_match
    FROM posts
    LEFT JOIN creator_types ct ON posts.account_handle = ct.account_handle
    WHERE posts.audio_id IS NOT NULL AND posts.audio_id <> ''
      AND posts.posted_at >= $${cutoffIdx}
      AND (posts.soft_deleted = 0 OR posts.soft_deleted IS NULL)
      AND (posts.archived = 0 OR posts.archived IS NULL)${nicheClause}
    GROUP BY posts.audio_id
    HAVING COUNT(*) >= $${minIdx}`;
  return { sql, params };
}

// PURE. Build the "reels using this audio" query (expand view / example reels).
function buildAudioReelsQuery(audioId, niches, { all = false, limit = 12, modelId = null } = {}) {
  const params = [audioId];
  const modelScoped = !all && Number(modelId) > 0;
  const list = (Array.isArray(niches) ? niches : []).filter(Boolean);
  let nicheClause = '';
  if (modelScoped) {
    nicheClause = ` AND ${effectiveNicheExpr()} IS NOT NULL`;
  } else if (!all) {
    if (list.length === 0) return { sql: null, params: [] };
    const ph = list.map((_, i) => `$${i + 2}`).join(', ');
    nicheClause = ` AND ${effectiveNicheExpr()} IN (${ph})`;
    params.push(...list);
  }
  if (modelScoped) {
    const scope = modelScopeClause('posts', params.length + 1);
    nicheClause += ` AND ${scope.clause}`;
    params.push(...scope.params(Number(modelId)));
  }
  const nicheOrder = modelScoped && list.length ? `${nicheMatchExpr(list, params)} DESC, ` : '';
  const limIdx = params.length + 1;
  params.push(limit);
  const sql = `
    SELECT posts.id, posts.shortcode, posts.audio_id, posts.view_count, posts.account_handle,
           posts.caption, posts.post_url, posts.posted_at,
           ${effectiveNicheExpr()} AS niche
    FROM posts
    LEFT JOIN creator_types ct ON posts.account_handle = ct.account_handle
    WHERE posts.audio_id = $1
      AND (posts.soft_deleted = 0 OR posts.soft_deleted IS NULL)
      AND (posts.archived = 0 OR posts.archived IS NULL)
      AND posts.video_cache_status = 'cached'${nicheClause}
    ORDER BY ${nicheOrder}posts.view_count DESC NULLS LAST
    LIMIT $${limIdx}`;
  return { sql, params };
}

// Run the aggregation, score + rank in JS, attach up to `examples` top reels each.
async function trendingAudio(db, { niches = [], all = false, cfg = audioConfig(), nowMs = Date.now(), examples = 3, modelId = null } = {}) {
  const cutoffIso = new Date(nowMs - cfg.maxAgeDays * 86400000).toISOString();
  const built = buildTrendingAudioQuery(niches, { all, cutoffIso, minReels: cfg.minReels, modelId });
  if (!built.sql) return [];
  const rows = (await db.query(built.sql, built.params)).rows || [];
  const ranked = rows
    .map(r => ({ ...r, trend_score: trendScore(r, cfg, nowMs) }))
    .sort((a, b) => Number(b.niche_match) - Number(a.niche_match) || b.trend_score - a.trend_score)
    .slice(0, cfg.limit);

  if (ranked.length === 0) return [];
  // Attach example reels for the ranked audios in one query, grouped in JS.
  const ids = ranked.map(r => r.audio_id);
  const ph = ids.map((_, i) => `$${i + 1}`).join(', ');
  const exParams = [...ids];
  const modelScoped = !all && Number(modelId) > 0;
  const list = (Array.isArray(niches) ? niches : []).filter(Boolean);
  let nicheClause = '';
  if (modelScoped) {
    nicheClause = ` AND ${effectiveNicheExpr()} IS NOT NULL`;
  } else if (!all) {
    const nph = list.map((_, i) => `$${ids.length + 1 + i}`).join(', ');
    if (list.length) { nicheClause = ` AND ${effectiveNicheExpr()} IN (${nph})`; exParams.push(...list); }
  }
  if (modelScoped) {
    const scope = modelScopeClause('posts', exParams.length + 1);
    nicheClause += ` AND ${scope.clause}`;
    exParams.push(...scope.params(Number(modelId)));
  }
  const nicheOrder = modelScoped && list.length ? `${nicheMatchExpr(list, exParams)} DESC, ` : '';
  const exSql = `
    SELECT posts.id, posts.shortcode, posts.audio_id, posts.view_count, posts.account_handle, posts.post_url
    FROM posts
    LEFT JOIN creator_types ct ON posts.account_handle = ct.account_handle
    WHERE posts.audio_id IN (${ph})
      AND (posts.soft_deleted = 0 OR posts.soft_deleted IS NULL)
      AND (posts.archived = 0 OR posts.archived IS NULL)
      AND posts.video_cache_status = 'cached'${nicheClause}
    ORDER BY ${nicheOrder}posts.view_count DESC NULLS LAST`;
  const exRows = (await db.query(exSql, exParams)).rows || [];
  const byAudio = {};
  for (const r of exRows) {
    (byAudio[r.audio_id] = byAudio[r.audio_id] || []);
    if (byAudio[r.audio_id].length < examples) byAudio[r.audio_id].push(r);
  }
  return ranked.map(r => ({ ...r, exampleReels: byAudio[r.audio_id] || [] }));
}

module.exports = { audioConfig, trendScore, buildTrendingAudioQuery, buildAudioReelsQuery, trendingAudio };
