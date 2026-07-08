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

// The reel-playback guarantee. The model feed must only surface reels /video/:id
// can DELIVER FROM DISK — i.e. a cached file. We deliberately do NOT trust the
// raw IG video_url here: those signed URLs expire within hours, so a
// "recently refreshed" URL can still 403 at Instagram → a frozen thumbnail the
// model can never play. The post-scrape sweep (scraper.js) caches reels while
// their URLs are alive, so cached-only stays populated with a short lag instead
// of showing reels that only *might* play. No placeholder — a bare status check.
const PLAYABLE_CLAUSE = `posts.video_cache_status = 'cached'`;

function buildMeFeedQuery(niches, { page = 1, limit = 24, all = false } = {}) {
  let clause, params;
  if (all) {
    clause = visibilityOnlyClause(); params = [];
  } else {
    ({ clause, params } = nicheVisibilityClause(niches, 1));
    if (!clause) return { sql: null, params: [] };
  }

  const offset = (Math.max(1, Number(page)) - 1) * limit;
  const limIdx = params.length + 1, offIdx = params.length + 2;
  const sql = `
    SELECT posts.*, COALESCE(posts.content_type, ct.content_type) AS niche
    FROM posts
    LEFT JOIN creator_types ct ON posts.account_handle = ct.account_handle
    WHERE ${clause} AND ${PLAYABLE_CLAUSE}
    ORDER BY posts.posted_at DESC
    LIMIT $${limIdx} OFFSET $${offIdx}`;
  return { sql, params: [...params, limit, offset] };
}
module.exports = { buildMeFeedQuery, nicheVisibilityClause, parseNiches, visibilityOnlyClause, PLAYABLE_CLAUSE };
