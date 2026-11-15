const { effectiveNicheExpr } = require('./sort-status');
const { parseNiches } = require('./me-feed');
const { addCreator } = require('./workspaces');
const { parseTagList, cleanModelLookTags } = require('./look-tags');
const { creatorLookProfiles, creatorLookMatch } = require('./look-match');

async function computeProposals(pool, { minShare = Number(process.env.WORKSPACE_PROPOSE_MIN_SHARE || 0.3), modelId = null } = {}) {
  const threshold = Number.isFinite(minShare) ? minShare : 0.3;
  const niche = effectiveNicheExpr('p');
  const mixes = await pool.query(`SELECT LOWER(ta.username) AS username, ${niche} AS content_type, COUNT(*) AS reel_count
    FROM tracked_accounts ta JOIN posts p ON LOWER(p.account_handle) = LOWER(ta.username)
    WHERE (p.soft_deleted = 0 OR p.soft_deleted IS NULL)
      AND (p.archived = 0 OR p.archived IS NULL) AND ${niche} IS NOT NULL
    GROUP BY LOWER(ta.username), ${niche}`);
  const creators = new Map();
  for (const row of mixes.rows) {
    if (!creators.has(row.username)) creators.set(row.username, []);
    creators.get(row.username).push({ type: row.content_type, count: Number(row.reel_count) });
  }
  const models = await pool.query(`SELECT * FROM models WHERE status = 'active'${modelId == null ? '' : ' AND id = $1'}`, modelId == null ? [] : [modelId]);
  const vocabulary = (await pool.query('SELECT value FROM look_tags')).rows;
  const profiles = await creatorLookProfiles(pool, [...creators.keys()]);
  let proposed = 0;
  for (const model of models.rows) {
    const niches = parseNiches(model);
    const lookTags = cleanModelLookTags(parseTagList(model.look_tags), vocabulary);
    for (const [username, mix] of creators) {
      const total = mix.reduce((sum, row) => sum + row.count, 0);
      const share = mix.filter(row => niches.includes(row.type)).reduce((sum, row) => sum + row.count, 0) / total;
      const owned = await pool.query('SELECT 1 FROM model_creators WHERE model_id = $1 AND username = $2', [model.id, username]);
      if (owned.rows.length) continue;
      const existing = await pool.query('SELECT status FROM model_creator_proposals WHERE model_id = $1 AND username = $2', [model.id, username]);
      if (existing.rows.length) {
        if (existing.rows[0].status === 'pending') {
          await pool.query("UPDATE model_creator_proposals SET share = $1 WHERE model_id = $2 AND username = $3 AND status = 'pending'", [share, model.id, username]);
        }
      } else if (share >= threshold || creatorLookMatch(lookTags, profiles.get(username) || new Map()) >= 0.5) {
        const inserted = await pool.query(`INSERT INTO model_creator_proposals (model_id, username, share, status, created_at)
          SELECT $1, $2, $3, 'pending', $4
          WHERE NOT EXISTS (SELECT 1 FROM model_creators WHERE model_id = $5 AND username = $6)
          ON CONFLICT (model_id, username) DO NOTHING`, [model.id, username, share, new Date().toISOString(), model.id, username]);
        proposed += inserted.rowCount;
      }
    }
  }
  return { proposed };
}

async function confirmAllProposals(pool, modelId) {
  const { rows } = await pool.query("SELECT username FROM model_creator_proposals WHERE model_id = $1 AND status = 'pending' ORDER BY username", [modelId]);
  for (const row of rows) await addCreator(pool, modelId, row.username, 'proposal');
  return { confirmed: rows.length };
}

module.exports = { computeProposals, confirmAllProposals };
