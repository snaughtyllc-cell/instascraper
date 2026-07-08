// server/me-feed.js
// [R2-#2] parseNiches lives HERE (Task 5) — the /me/feed route uses it immediately, and
// /me/saves (Task 6) reuses it. One definition, one import site.
function parseNiches(modelRow = {}) {
  return [modelRow.primary_niche, ...String(modelRow.secondary_niches || '').split(',')]
    .map(s => (s || '').trim()).filter(Boolean);
}

function nicheVisibilityClause(niches, startIdx = 1) {
  const list = (Array.isArray(niches) ? niches : []).filter(Boolean);
  if (list.length === 0) return { clause: null, params: [] };
  const ph = list.map((_, i) => `$${startIdx + i}`).join(', ');
  const clause =
    `COALESCE(posts.content_type, ct.content_type) IN (${ph})` +
    ` AND (posts.soft_deleted = 0 OR posts.soft_deleted IS NULL)` +
    ` AND (posts.archived = 0 OR posts.archived IS NULL)`;
  return { clause, params: list };
}

function visibilityOnlyClause() {
  return `(posts.soft_deleted = 0 OR posts.soft_deleted IS NULL)`
    + ` AND (posts.archived = 0 OR posts.archived IS NULL)`;
}

// The reel-playback fix. The model feed must only surface reels /video/:id can
// actually deliver — otherwise the model sees frozen thumbnails for reels whose
// cached file was never built AND whose raw IG URL has expired. This mirrors
// serveVideo (index.js) exactly: a reel is playable iff we hold a cached file
// ('cached'), OR its raw video_url is still fresh (refreshed within
// VIDEO_FRESHNESS_DAYS) so serveVideo can 302 to it. A 'pruning' row is
// mid-delete → excluded. `cutoff` is the ISO-Z freshness boundary; it consumes
// exactly one placeholder ($startIdx), numbered by the caller.
function playableClause(cutoffIdx) {
  const clause =
    `(posts.video_cache_status = 'cached'` +
    ` OR (posts.video_url IS NOT NULL` +
    ` AND posts.video_url_refreshed_at IS NOT NULL` +
    ` AND posts.video_url_refreshed_at >= $${cutoffIdx}` +
    ` AND (posts.video_cache_status IS NULL OR posts.video_cache_status <> 'pruning')))`;
  return clause;
}

function buildMeFeedQuery(niches, { page = 1, limit = 24, all = false, freshnessCutoff } = {}) {
  // Default the freshness boundary from the same env knob serveVideo uses, so the
  // feed and the video route agree on what "fresh" means. Overridable for tests.
  const cutoff = freshnessCutoff
    || new Date(Date.now() - Number(process.env.VIDEO_FRESHNESS_DAYS || 2) * 86400000).toISOString();

  let clause, params;
  if (all) {
    clause = visibilityOnlyClause(); params = [];
  } else {
    ({ clause, params } = nicheVisibilityClause(niches, 1));
    if (!clause) return { sql: null, params: [] };
  }

  // Append the playable filter. Its single placeholder ($cutoffIdx) follows the
  // visibility params; then limit/offset follow that. Every $N is used exactly
  // once, so the SQLite adapter's naive `$N -> ?` rewrite binds positionally on
  // both backends.
  const cutoffIdx = params.length + 1;
  const play = playableClause(cutoffIdx);
  const whereParams = [...params, cutoff];

  const offset = (Math.max(1, Number(page)) - 1) * limit;
  const limIdx = whereParams.length + 1, offIdx = whereParams.length + 2;
  const sql = `
    SELECT posts.*, COALESCE(posts.content_type, ct.content_type) AS niche
    FROM posts
    LEFT JOIN creator_types ct ON posts.account_handle = ct.account_handle
    WHERE ${clause} AND ${play}
    ORDER BY posts.posted_at DESC
    LIMIT $${limIdx} OFFSET $${offIdx}`;
  return { sql, params: [...whereParams, limit, offset] };
}
module.exports = { buildMeFeedQuery, nicheVisibilityClause, parseNiches, visibilityOnlyClause, playableClause };
