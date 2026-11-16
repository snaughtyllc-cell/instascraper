const { effectiveNicheExpr } = require('./sort-status');
const { modelScopeClause } = require('./model-scope');
// server/me-feed.js
// [R2-#2] parseNiches lives HERE (Task 5) — the /me/feed route uses it immediately, and
// /me/saves (Task 6) reuses it. One definition, one import site.
function parseNiches(modelRow = {}) {
  return [...new Set([modelRow.primary_niche, ...String(modelRow.secondary_niches || '').split(',')]
    .map(s => (s || '').trim()).filter(Boolean))];
}

function allowedNicheOptions(niches, contentTypes) {
  const labels = new Map((Array.isArray(contentTypes) ? contentTypes : []).map((row) => [row.value, row.label]));
  return [...new Set(Array.isArray(niches) ? niches : [])].filter(Boolean).map((value) => ({
    value,
    label: labels.get(value) || value.split('-').map((word) => word ? word[0].toUpperCase() + word.slice(1) : '').join(' '),
  }));
}

function nicheVisibilityClause(niches, startIdx = 1) {
  const list = (Array.isArray(niches) ? niches : []).filter(Boolean);
  if (list.length === 0) return { clause: null, params: [] };
  const ph = list.map((_, i) => `$${startIdx + i}`).join(', ');
  const clause =
    `${effectiveNicheExpr()} IN (${ph})` +
    ` AND (posts.soft_deleted = 0 OR posts.soft_deleted IS NULL)` +
    ` AND (posts.archived = 0 OR posts.archived IS NULL)`;
  return { clause, params: list };
}

function visibilityOnlyClause() {
  return `(posts.soft_deleted = 0 OR posts.soft_deleted IS NULL)`
    + ` AND (posts.archived = 0 OR posts.archived IS NULL)`;
}

function sortedVisibilityClause() {
  return `${effectiveNicheExpr()} IS NOT NULL AND ${visibilityOnlyClause()}`;
}

// The reel-playback guarantee. The model feed must only surface reels /video/:id
// can DELIVER FROM DISK — i.e. a cached file. We deliberately do NOT trust the
// raw IG video_url here: those signed URLs expire within hours, so a
// "recently refreshed" URL can still 403 at Instagram → a frozen thumbnail the
// model can never play. The post-scrape sweep (scraper.js) caches reels while
// their URLs are alive, so cached-only stays populated with a short lag instead
// of showing reels that only *might* play. No placeholder — a bare status check.
const PLAYABLE_CLAUSE = `posts.video_cache_status = 'cached'`;

function buildEasyFilmClause(configuredTypes = process.env.FEED_EASY_FILM_EXEMPT_TYPES ?? 'omegle') {
  const exemptTypes = [...new Set(configuredTypes.split(',').map(value => value.trim())
    .filter(value => /^[a-z0-9-]+$/.test(value)))];
  // Only validated ASCII content-type values enter SQL; no extra bind slots.
  const exemptClause = exemptTypes.length
    ? ` OR posts.content_type IN (${exemptTypes.map(value => `'${value}'`).join(', ')})` : '';
  return `(posts.ai_layout IS NULL OR posts.ai_layout = 'self_filmed'${exemptClause})`;
}

const EASY_FILM_CLAUSE = buildEasyFilmClause('omegle');

function buildMeFeedQuery(niches, { page = 1, limit = 24, pageSize = limit, all = false, shuffle = false, modelId = null, lookTags = [], taste = {}, niche = null } = {}) {
  let clause, params;
  if (all) {
    clause = visibilityOnlyClause(); params = [];
  } else if (niche) {
    ({ clause, params } = nicheVisibilityClause([niche], 1));
  } else {
    clause = sortedVisibilityClause(); params = [];
  }

  let modelClause = '';
  if (Number.isSafeInteger(Number(modelId)) && Number(modelId) > 0) {
    if (!all) {
      const scope = modelScopeClause('posts', params.length + 1);
      clause += ` AND ${scope.clause}`;
      params.push(...scope.params(Number(modelId)));
    }
    const assignmentModelIdx = params.length + 1;
    params.push(Number(modelId));
    const feedbackModelIdx = params.length + 1;
    params.push(Number(modelId));
    const savedModelIdx = params.length + 1;
    params.push(Number(modelId));
    modelClause = `
      AND NOT EXISTS (
        SELECT 1 FROM model_assigned_posts a
        WHERE a.model_id = $${assignmentModelIdx} AND a.post_id = posts.id AND a.status = 'assigned'
      )
      AND NOT EXISTS (
        SELECT 1 FROM model_post_feedback f
        WHERE f.model_id = $${feedbackModelIdx} AND f.post_id = posts.id AND f.feedback = 'not_my_style'
      )
      AND NOT EXISTS (
        SELECT 1 FROM model_saved_posts s
        WHERE s.model_id = $${savedModelIdx} AND s.post_id = posts.id
      )`;
  }

  let nicheRank = '0';
  let nicheOrder = '';
  const preferredNiches = [...new Set((Array.isArray(niches) ? niches : []).filter(Boolean))];
  if (!all && !shuffle && preferredNiches.length) {
    const ph = preferredNiches.map(value => {
      params.push(value);
      return `$${params.length}`;
    }).join(', ');
    nicheRank = `CASE WHEN ${effectiveNicheExpr()} IN (${ph}) THEN 1 ELSE 0 END`;
    nicheOrder = `${nicheRank} DESC, `;
  }
  const lookTerms = shuffle ? [] : [...new Set(lookTags)].map(tag => {
    params.push(`%"${tag}"%`);
    return `CASE WHEN posts.ai_look_tags LIKE $${params.length} THEN 1 ELSE 0 END`;
  });
  const tasteTerms = [];
  if (!shuffle) {
    for (const [kind, column] of [['types', 'posts.content_type'], ['tags', 'posts.ai_look_tags'], ['creators', 'LOWER(posts.account_handle)']]) {
      for (const [value, score] of taste[kind] || []) {
        params.push(kind === 'tags' ? `%"${value}"%` : value);
        const valueIdx = params.length;
        params.push(score);
        tasteTerms.push(`CASE WHEN ${column} ${kind === 'tags' ? 'LIKE' : '='} $${valueIdx} THEN CAST($${params.length} AS REAL) ELSE 0 END`);
      }
    }
  }
  const rankTerms = [...lookTerms, ...tasteTerms];
  const configuredPerfWeight = Number(process.env.FEED_PERF_WEIGHT ?? 1);
  const perfWeight = Number.isFinite(configuredPerfWeight) && configuredPerfWeight >= 0 ? configuredPerfWeight : 1;
  if (!shuffle && perfWeight > 0) rankTerms.push(`COALESCE(posts.perf_score, 0) * ${perfWeight}`);
  const order = shuffle ? 'RANDOM()' : nicheOrder + (rankTerms.length
    ? `(${rankTerms.join(' + ')}) DESC, posts.posted_at DESC` : 'posts.posted_at DESC');
  const offset = (Math.max(1, Number(page)) - 1) * pageSize;
  const limIdx = params.length + 1, offIdx = params.length + 2;
  const easyFilmClause = ['0', 'false', 'off'].includes(String(process.env.FEED_REQUIRE_EASY_FILM || '').trim().toLowerCase())
    ? '' : ` AND ${buildEasyFilmClause()}`;
  const selection = `
    SELECT posts.*, ${effectiveNicheExpr()} AS niche
    FROM posts
    LEFT JOIN creator_types ct ON posts.account_handle = ct.account_handle
    WHERE ${clause} AND ${PLAYABLE_CLAUSE}${easyFilmClause}${modelClause}`;
  let sql = `${selection}
    ORDER BY ${order}
    LIMIT $${limIdx} OFFSET $${offIdx}`;
  const configuredSpread = String(process.env.FEED_CREATOR_SPREAD ?? '2').trim();
  const creatorSpread = /^\d+$/.test(configuredSpread) && Number.isSafeInteger(Number(configuredSpread))
    ? Number(configuredSpread) : 2;
  if (!shuffle && creatorSpread > 0) {
    const rankScore = rankTerms.length ? `(${rankTerms.join(' + ')})` : '0';
    sql = `
    SELECT posts.*, ranked.niche
    FROM (
      SELECT scored.id, scored.niche, scored.niche_rank, scored.rank_score, scored.posted_at,
        ROW_NUMBER() OVER (
          PARTITION BY LOWER(scored.account_handle), scored.niche_rank
          ORDER BY scored.rank_score DESC, scored.posted_at DESC, scored.id DESC
        ) AS creator_pos
      FROM (
        SELECT posts.*, ${nicheRank} AS niche_rank, ${rankScore} AS rank_score
        FROM (${selection}
        ) posts
      ) scored
    ) ranked
    JOIN posts ON posts.id = ranked.id
    ORDER BY ranked.niche_rank DESC, ((ranked.creator_pos - 1) / ${creatorSpread}) ASC,
      ranked.rank_score DESC, ranked.posted_at DESC, ranked.id DESC
    LIMIT $${limIdx} OFFSET $${offIdx}`;
    // Scores precede the filters in SQL text. Bind in that order for SQLite's
    // positional adapter, while retaining PostgreSQL's ascending placeholders.
    const sourceParams = [...params, limit, offset];
    const orderedParams = [];
    sql = sql.replace(/\$(\d+)/g, (_, index) => {
      orderedParams.push(sourceParams[Number(index) - 1]);
      return `$${orderedParams.length}`;
    });
    return { sql, params: orderedParams };
  }
  return { sql, params: [...params, limit, offset] };
}
module.exports = { buildMeFeedQuery, nicheVisibilityClause, parseNiches, allowedNicheOptions, visibilityOnlyClause, sortedVisibilityClause, PLAYABLE_CLAUSE, EASY_FILM_CLAUSE };
