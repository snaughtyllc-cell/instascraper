const { effectiveNicheExpr } = require('./sort-status');

async function getCreators(pool) {
  const niche = effectiveNicheExpr('p');
  const { rows } = await pool.query(`
    SELECT LOWER(TRIM(p.account_handle)) AS account_handle,
      ${niche} AS content_type, COUNT(*) AS reel_count
    FROM posts p
    WHERE TRIM(p.account_handle) != ''
      AND (p.soft_deleted = 0 OR p.soft_deleted IS NULL)
      AND (p.archived = 0 OR p.archived IS NULL)
    GROUP BY LOWER(TRIM(p.account_handle)), ${niche}
  `);
  const creators = new Map();
  const ownership = await pool.query(`SELECT mc.username, mc.model_id, m.name
    FROM model_creators mc JOIN models m ON m.id = mc.model_id ORDER BY mc.model_id`);
  const owners = new Map();
  for (const row of ownership.rows) {
    if (!owners.has(row.username)) owners.set(row.username, []);
    owners.get(row.username).push({ modelId: Number(row.model_id), name: row.name });
  }
  for (const row of rows) {
    if (!creators.has(row.account_handle)) {
      creators.set(row.account_handle, { account_handle: row.account_handle, post_count: 0, mix: [], owners: owners.get(row.account_handle) || [] });
    }
    const creator = creators.get(row.account_handle);
    const count = Number(row.reel_count);
    creator.post_count += count;
    if (row.content_type) creator.mix.push({ type: row.content_type, count });
  }
  return [...creators.values()]
    .map((creator) => {
      const total = creator.mix.reduce((sum, item) => sum + item.count, 0);
      creator.mix.sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
      creator.mix = creator.mix.map(({ type, count }) => ({ type, pct: Math.round(count / total * 100) }));
      return creator;
    })
    .sort((a, b) => b.post_count - a.post_count || a.account_handle.localeCompare(b.account_handle));
}

module.exports = { getCreators };
