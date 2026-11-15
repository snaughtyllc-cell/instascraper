const { modelScopeClause } = require('./model-scope');
const { effectiveNicheExpr } = require('./sort-status');

async function modelCanAccessPost(pool, modelId, postId, { requirePlayable = false } = {}) {
  if (!Number.isSafeInteger(Number(modelId)) || Number(modelId) <= 0
    || !Number.isSafeInteger(Number(postId)) || Number(postId) <= 0) return false;
  const model = await pool.query('SELECT primary_niche, secondary_niches FROM models WHERE id = $1', [modelId]);
  if (!model.rows.length) return false;
  // Each placeholder is used once in ascending appearance order for SQLite.
  const params = [postId, modelId, modelId, modelId];
  const scope = modelScopeClause('posts', params.length + 1);
  const sortedClause = ` OR (${effectiveNicheExpr()} IS NOT NULL AND ${scope.clause})`;
  params.push(...scope.params(modelId));
  const playableClause = requirePlayable ? ` AND posts.video_cache_status = 'cached'` : '';
  const result = await pool.query(
    `SELECT posts.id
       FROM posts
       LEFT JOIN creator_types ct ON posts.account_handle = ct.account_handle
      WHERE posts.id = $1
        AND (posts.soft_deleted = 0 OR posts.soft_deleted IS NULL)
        AND (posts.archived = 0 OR posts.archived IS NULL)
        AND (EXISTS (SELECT 1 FROM model_assigned_posts a
                     WHERE a.post_id = posts.id AND a.model_id = $2 AND a.status = 'assigned')
             OR EXISTS (SELECT 1 FROM model_saved_posts s2
                        WHERE s2.post_id = posts.id AND s2.model_id = $3)
             OR EXISTS (SELECT 1 FROM model_post_feedback f2
                        WHERE f2.post_id = posts.id AND f2.model_id = $4)${sortedClause})
        ${playableClause}
      LIMIT 1`,
    params);
  return result.rows.length > 0;
}

module.exports = { modelCanAccessPost };
