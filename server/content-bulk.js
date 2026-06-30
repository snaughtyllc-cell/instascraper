// Pure builder for the bulk content UPDATE. Validates against the same
// allow-lists the single-item /content routes use, coerces ids to positive
// integers, and returns a portable `id IN ($2,$3,…)` UPDATE (never ANY()).
const TAG_VALUES = ['recreate', 'reference', 'skip', null];
const CONTENT_TYPE_VALUES = ['talking', 'dance', 'skit', 'snapchat', 'omegle', 'osc', null];

function buildBulkUpdate(action, value, ids) {
  let column, param;
  if (action === 'tag') {
    if (!TAG_VALUES.includes(value)) return { error: 'Invalid tag' };
    column = 'tag'; param = value;
  } else if (action === 'content-type') {
    if (!CONTENT_TYPE_VALUES.includes(value)) return { error: 'Invalid content type' };
    column = 'content_type'; param = value;
  } else if (action === 'archive') {
    column = 'archived'; param = value ? 1 : 0;
  } else {
    return { error: 'Invalid action' };
  }

  const cleanIds = (Array.isArray(ids) ? ids : [])
    .map(n => Number(n))
    .filter(n => Number.isInteger(n) && n > 0);

  if (cleanIds.length === 0) return { sql: null, params: [], ids: [] };

  const placeholders = cleanIds.map((_, i) => `$${i + 2}`).join(',');
  const sql = `UPDATE posts SET ${column} = $1 WHERE id IN (${placeholders})`;
  return { sql, params: [param, ...cleanIds], ids: cleanIds };
}

module.exports = { buildBulkUpdate };
