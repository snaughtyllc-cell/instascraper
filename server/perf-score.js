const { median } = require('./engagement-metrics');

const handleRefreshes = new WeakMap();

function computePerfScores(rows, { minReels = 5 } = {}) {
  const eligible = rows.filter((row) => Number.isFinite(Number(row.view_count)) && Number(row.view_count) > 0);
  const medianViews = eligible.length >= minReels
    ? median(eligible.map((row) => row.view_count))
    : null;
  return new Map(rows.map((row) => {
    const views = Number(row.view_count);
    const score = medianViews > 0 && Number.isFinite(views) && views > 0
      ? Math.round(Math.max(-2, Math.min(2, Math.log2(views / medianViews))) * 1000) / 1000
      : null;
    return [row.id, score];
  }));
}

async function refreshPerfScores(pool, handles = null) {
  const selectedHandles = handles === null
    ? (await pool.query('SELECT DISTINCT account_handle FROM posts')).rows.map((row) => row.account_handle)
    : handles;
  const uniqueHandles = [...new Set(selectedHandles.filter(Boolean))];
  const configuredMinReels = Number(process.env.PERF_MIN_REELS);
  const minReels = Number.isInteger(configuredMinReels) && configuredMinReels > 0 ? configuredMinReels : 5;
  let updated = 0;
  for (const handle of uniqueHandles) {
    let pending = handleRefreshes.get(pool);
    if (!pending) {
      pending = new Map();
      handleRefreshes.set(pool, pending);
    }
    // A scrape refresh must read after an overlapping boot backfill finishes,
    // otherwise the older view snapshot can overwrite the creator's new scores.
    const previous = pending.get(handle) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => refreshHandle(pool, handle, minReels));
    pending.set(handle, current);
    try {
      updated += await current;
    } finally {
      if (pending.get(handle) === current) {
        pending.delete(handle);
        if (pending.size === 0) handleRefreshes.delete(pool);
      }
    }
  }
  return { handles: uniqueHandles.length, updated };
}

async function refreshHandle(pool, handle, minReels) {
  const { rows } = await pool.query(
    `SELECT id, view_count, perf_score FROM posts
     WHERE account_handle = $1
       AND (archived = 0 OR archived IS NULL)
       AND (soft_deleted = 0 OR soft_deleted IS NULL)`,
    [handle]
  );
  const scores = computePerfScores(rows, { minReels });
  let updated = 0;
  for (const row of rows) {
    const score = scores.get(row.id);
    // PostgreSQL REAL stores float32 values; compare at that precision so a
    // rounded decimal score does not get rewritten on every refresh.
    const unchanged = score === null
      ? row.perf_score === null
      : row.perf_score !== null && Math.fround(Number(row.perf_score)) === Math.fround(score);
    if (unchanged) continue;
    const result = await pool.query(
      `UPDATE posts SET perf_score = $1 WHERE id = $2
         AND (archived = 0 OR archived IS NULL)
         AND (soft_deleted = 0 OR soft_deleted IS NULL)
         AND perf_score IS DISTINCT FROM CAST($3 AS REAL)`,
      [score, row.id, score]
    );
    updated += result.rowCount;
  }
  return updated;
}

module.exports = { computePerfScores, refreshPerfScores };
