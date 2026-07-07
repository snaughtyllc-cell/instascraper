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
    WHERE ${clause}
    ORDER BY posts.posted_at DESC
    LIMIT $${limIdx} OFFSET $${offIdx}`;
  return { sql, params: [...params, limit, offset] };
}
module.exports = { buildMeFeedQuery, nicheVisibilityClause, parseNiches, visibilityOnlyClause };
