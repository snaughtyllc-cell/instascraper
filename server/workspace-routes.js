const { buildMeFeedQuery, parseNiches } = require('./me-feed');
const { addCreator, removeCreator, listWorkspaceCreators, approveForModel, normalizeUsername } = require('./workspaces');
const { confirmAllProposals } = require('./proposals');
const { attachTopReels } = require('./scraper');
const { parseTagList, cleanModelLookTags } = require('./look-tags');
const { reelLookMatch, creatorLookProfiles, creatorLookMatch, candidateLookProfile } = require('./look-match');
const { loadTaste, tasteForFeed, creatorTaste } = require('./model-taste');

async function workspaceLook(pool, model) {
  const { rows } = await pool.query('SELECT value FROM look_tags');
  return { tags: cleanModelLookTags(parseTagList(model.look_tags), rows), known: new Set(rows.map(row => row.value)) };
}

function registerWorkspaceRoutes(app, { pool }) {
  const wrap = handler => async (req, res, next) => {
    try { await handler(req, res); } catch (error) { next(error); }
  };
  app.use('/workspaces/:modelId', async (req, res, next) => {
    try {
      const modelId = Number(req.params.modelId);
      if (!Number.isSafeInteger(modelId) || modelId <= 0) return res.status(400).json({ error: 'Invalid modelId' });
      const result = await pool.query('SELECT * FROM models WHERE id = $1', [modelId]);
      if (!result.rows.length) return res.status(404).json({ error: 'Model not found' });
      req.workspaceModel = result.rows[0];
      req.workspaceModelId = modelId;
      next();
    } catch (error) { next(error); }
  });

  app.get('/workspaces/:modelId', wrap(async (req, res) => {
    const { rows } = await pool.query('SELECT COUNT(*) AS count FROM model_creators WHERE model_id = $1', [req.workspaceModelId]);
    const creatorCount = Number(rows[0].count);
    const { tags } = await workspaceLook(pool, req.workspaceModel);
    res.json({ model: { ...req.workspaceModel, look_tags: tags }, creatorCount, fallback: creatorCount === 0 });
  }));
  app.get('/workspaces/:modelId/creators', wrap(async (req, res) => {
    res.json(await listWorkspaceCreators(pool, req.workspaceModelId));
  }));
  app.post('/workspaces/:modelId/creators', wrap(async (req, res) => {
    const username = normalizeUsername(req.body?.username);
    if (!username) return res.status(400).json({ error: 'username required' });
    res.json(await addCreator(pool, req.workspaceModelId, username));
  }));
  app.delete('/workspaces/:modelId/creators/:username', wrap(async (req, res) => {
    res.json(await removeCreator(pool, req.workspaceModelId, req.params.username));
  }));
  app.get('/workspaces/:modelId/reels', wrap(async (req, res) => {
    const { tags, known } = await workspaceLook(pool, req.workspaceModel);
    const taste = tasteForFeed(await loadTaste(pool, req.workspaceModelId), known);
    const built = buildMeFeedQuery(parseNiches(req.workspaceModel), { modelId: req.workspaceModelId, lookTags: tags, taste, page: Math.max(1, parseInt(req.query.page, 10) || 1) });
    const result = built.sql ? await pool.query(built.sql, built.params) : { rows: [] };
    res.json(result.rows.map(row => ({ ...row, look_match: reelLookMatch(tags, parseTagList(row.ai_look_tags)) })));
  }));
  app.get('/workspaces/:modelId/proposals', wrap(async (req, res) => {
    const result = await pool.query("SELECT * FROM model_creator_proposals WHERE model_id = $1 AND status = 'pending' ORDER BY share DESC, username", [req.workspaceModelId]);
    const { tags } = await workspaceLook(pool, req.workspaceModel);
    const profiles = await creatorLookProfiles(pool, result.rows.map(row => row.username));
    const taste = await loadTaste(pool, req.workspaceModelId);
    const rows = result.rows.map(row => {
      const profile = profiles.get(row.username) || new Map();
      return { ...row, look_match: creatorLookMatch(tags, profile), taste_score: creatorTaste(taste, row.username, profile) };
    });
    rows.sort((a, b) => Number(b.share) - Number(a.share) || (b.look_match + b.taste_score) - (a.look_match + a.taste_score));
    res.json(rows);
  }));
  app.post('/workspaces/:modelId/proposals/confirm-all', wrap(async (req, res) => {
    res.json(await confirmAllProposals(pool, req.workspaceModelId));
  }));
  app.post('/workspaces/:modelId/proposals/:username/confirm', wrap(async (req, res) => {
    const username = normalizeUsername(req.params.username);
    const proposal = await pool.query("SELECT username FROM model_creator_proposals WHERE model_id = $1 AND username = $2 AND status = 'pending'", [req.workspaceModelId, username]);
    if (!proposal.rows.length) return res.status(404).json({ error: 'Pending proposal not found' });
    res.json(await addCreator(pool, req.workspaceModelId, username, 'proposal'));
  }));
  app.post('/workspaces/:modelId/proposals/:username/reject', wrap(async (req, res) => {
    const result = await pool.query("UPDATE model_creator_proposals SET status = 'rejected', decided_at = $1 WHERE model_id = $2 AND username = $3 AND status = 'pending'", [new Date().toISOString(), req.workspaceModelId, normalizeUsername(req.params.username)]);
    if (!result.rowCount) return res.status(404).json({ error: 'Pending proposal not found' });
    res.json({ success: true });
  }));
  app.get('/workspaces/:modelId/suggestions', wrap(async (req, res) => {
    const { rows } = await pool.query(`SELECT sa.*, ms.username AS username, ms.model_id, ms.fit, ms.reason,
      ms.status, ms.snoozed_until, ms.reviewed_at, ms.created_at
      FROM model_suggestions ms JOIN suggested_accounts sa ON LOWER(sa.username) = ms.username
      WHERE ms.model_id = $1 AND ms.status = 'pending' AND (ms.snoozed_until IS NULL OR ms.snoozed_until <= $2)
      ORDER BY ms.fit DESC, sa.suggestion_score DESC, ms.username`, [req.workspaceModelId, new Date().toISOString()]);
    let reels = [];
    if (rows.length) {
      const usernames = rows.map(row => row.username);
      const placeholders = usernames.map((_, i) => `$${i + 1}`).join(',');
      const result = await pool.query(`SELECT * FROM suggested_reels WHERE LOWER(username) IN (${placeholders}) ORDER BY rank`, usernames);
      reels = result.rows.map(row => ({ ...row, username: normalizeUsername(row.username) }));
    }
    const { tags, known } = await workspaceLook(pool, req.workspaceModel);
    const taste = await loadTaste(pool, req.workspaceModelId);
    const ranked = attachTopReels(rows, reels).map(row => {
      const profile = new Map([...candidateLookProfile(row.top_reels)].filter(([tag]) => known.has(tag)));
      return { ...row, look_match: creatorLookMatch(tags, profile), taste_score: creatorTaste(taste, row.username, profile) };
    });
    ranked.sort((a, b) => Number(b.fit) - Number(a.fit) || (b.look_match + b.taste_score) - (a.look_match + a.taste_score) || Number(b.suggestion_score) - Number(a.suggestion_score));
    res.json(ranked);
  }));
  app.get('/workspaces/:modelId/taste', wrap(async (req, res) => {
    const { rows } = await pool.query('SELECT feature, affinity, positives, negatives FROM model_taste WHERE model_id = $1 ORDER BY affinity DESC, feature', [req.workspaceModelId]);
    const { known } = await workspaceLook(pool, req.workspaceModel);
    const current = rows.filter(row => !row.feature.startsWith('tag:') || known.has(row.feature.slice(4)));
    res.json({ liked: current.filter(row => Number(row.affinity) > 0).slice(0, 5),
      disliked: current.filter(row => Number(row.affinity) < 0).sort((a, b) => Number(a.affinity) - Number(b.affinity)).slice(0, 5) });
  }));
  app.post('/workspaces/:modelId/suggestions/:username/approve', wrap(async (req, res) => {
    const username = normalizeUsername(req.params.username);
    const suggested = await pool.query('SELECT username FROM suggested_accounts WHERE LOWER(username) = $1', [username]);
    if (!suggested.rows.length) return res.status(404).json({ error: 'Suggestion not found' });
    await approveForModel(pool, req.workspaceModelId, username);
    res.json({ success: true });
  }));
  app.post('/workspaces/:modelId/suggestions/:username/dismiss', wrap(async (req, res) => {
    const result = await pool.query("UPDATE model_suggestions SET status = 'dismissed', reviewed_at = $1 WHERE model_id = $2 AND username = $3 AND status = 'pending'", [new Date().toISOString(), req.workspaceModelId, normalizeUsername(req.params.username)]);
    if (!result.rowCount) return res.status(404).json({ error: 'Suggestion not found' });
    res.json({ success: true });
  }));
  app.post('/workspaces/:modelId/suggestions/:username/snooze', wrap(async (req, res) => {
    const now = new Date();
    const until = new Date(now.getTime() + 7 * 86400000).toISOString();
    const result = await pool.query("UPDATE model_suggestions SET snoozed_until = $1, reviewed_at = $2 WHERE model_id = $3 AND username = $4 AND status = 'pending'", [until, now.toISOString(), req.workspaceModelId, normalizeUsername(req.params.username)]);
    if (!result.rowCount) return res.status(404).json({ error: 'Pending suggestion not found' });
    res.json({ success: true });
  }));
}

module.exports = { registerWorkspaceRoutes };
