function modelScopeClause(postsAlias = 'posts', startIdx = 1) {
  return {
    clause: `(NOT EXISTS (SELECT 1 FROM model_creators mcz WHERE mcz.model_id = $${startIdx}) OR EXISTS (SELECT 1 FROM model_creators mcs WHERE mcs.model_id = $${startIdx + 1} AND mcs.username = LOWER(${postsAlias}.account_handle)))`,
    params: modelId => [modelId, modelId],
  };
}

module.exports = { modelScopeClause };
