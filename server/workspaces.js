const { getCreators } = require('./creators-mix');

function normalizeUsername(username) {
  return typeof username === 'string' ? username.trim().replace(/^@/, '').toLowerCase() : '';
}

async function addCreator(pool, modelId, username, source = 'va') {
  const clean = normalizeUsername(username);
  if (!clean) throw new Error('username required');
  const work = db => linkCreator(db, modelId, clean, source);
  return pool.transaction ? pool.transaction(work) : work(pool);
}

async function linkCreator(db, modelId, clean, source) {
  const now = new Date().toISOString();
  const tracked = await db.query("UPDATE tracked_accounts SET status = 'active', updated_at = $1 WHERE LOWER(username) = $2", [now, clean]);
  if (!tracked.rowCount) {
    const suggested = await db.query('SELECT followers, bio, avg_er FROM suggested_accounts WHERE LOWER(username) = $1', [clean]);
    const account = suggested.rows[0] || {};
    await db.query(`INSERT INTO tracked_accounts (username, status, tags, followers, bio, avg_er, added_at, updated_at)
      VALUES ($1, 'active', $2, $3, $4, $5, $6, $7) ON CONFLICT (username) DO UPDATE SET status = 'active'`,
    [clean, source === 'suggestion' ? 'discovered' : '', account.followers || 0, account.bio || '', account.avg_er || 0, now, now]);
  }
  const result = await db.query(`INSERT INTO model_creators (model_id, username, source, added_at)
    VALUES ($1, $2, $3, $4) ON CONFLICT (model_id, username) DO NOTHING`, [modelId, clean, source, now]);
  await db.query(`UPDATE model_creator_proposals SET status = 'confirmed', decided_at = $1
    WHERE model_id = $2 AND username = $3`, [now, modelId, clean]);
  return { added: result.rowCount > 0 };
}

async function removeCreator(pool, modelId, username) {
  const clean = normalizeUsername(username);
  const work = async db => {
    // Acquire the same creator row lock as add before checking the final owner.
    await db.query('UPDATE tracked_accounts SET username = username WHERE LOWER(username) = $1', [clean]);
    const result = await db.query('DELETE FROM model_creators WHERE model_id = $1 AND username = $2', [modelId, clean]);
    if (!result.rowCount) return { removed: false, paused: false };
    const remaining = await db.query('SELECT model_id FROM model_creators WHERE username = $1 LIMIT 1', [clean]);
    const paused = remaining.rows.length === 0;
    if (paused) await db.query("UPDATE tracked_accounts SET status = 'paused', updated_at = $1 WHERE LOWER(username) = $2", [new Date().toISOString(), clean]);
    return { removed: true, paused };
  };
  return pool.transaction ? pool.transaction(work) : work(pool);
}

async function approveForModel(pool, modelId, username) {
  const clean = normalizeUsername(username);
  const work = async db => {
    await linkCreator(db, modelId, clean, 'suggestion');
    const now = new Date().toISOString();
    await db.query(`INSERT INTO model_suggestions (model_id, username, fit, status, reviewed_at, created_at)
      VALUES ($1, $2, 0, 'approved', $3, $4)
      ON CONFLICT (model_id, username) DO UPDATE SET status = 'approved',
        reviewed_at = EXCLUDED.reviewed_at, snoozed_until = NULL`, [modelId, clean, now, now]);
    await db.query("UPDATE suggested_accounts SET status = 'approved', reviewed_at = $1 WHERE LOWER(username) = $2", [now, clean]);
  };
  return pool.transaction ? pool.transaction(work) : work(pool);
}

async function listWorkspaceCreators(pool, modelId) {
  const result = await pool.query(`SELECT mc.username, mc.source, mc.added_at, ta.last_scraped_at, ta.status
    FROM model_creators mc LEFT JOIN tracked_accounts ta ON LOWER(ta.username) = mc.username
    WHERE mc.model_id = $1 ORDER BY mc.added_at DESC, mc.username`, [modelId]);
  const mixes = new Map((await getCreators(pool)).map(creator => [creator.account_handle, creator.mix]));
  return result.rows.map(row => ({ ...row, mix: mixes.get(row.username) || [] }));
}

module.exports = { addCreator, removeCreator, listWorkspaceCreators, approveForModel, normalizeUsername };
