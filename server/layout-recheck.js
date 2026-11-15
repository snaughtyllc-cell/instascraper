const fs = require('node:fs/promises');
const { sortConfig } = require('./sort-status');
const { describeReel, estimateCostUsd, makeGeminiClient, cleanLayout } = require('./gemini-sort');
const { attemptsToday, withSortLock } = require('./sort-runner');

const eligible = `sort_status IN ('auto','manual') AND video_cache_status='cached'
  AND ai_layout IS NULL AND (soft_deleted=0 OR soft_deleted IS NULL) AND (archived=0 OR archived IS NULL)`;
const order = "CASE WHEN content_type='talking' THEN 0 ELSE 1 END,posted_at DESC,id DESC";
const estimatedUsage = { inTokens: 3400, outTokens: 1600 };

async function layoutRecheckEstimate(pool, cfg = sortConfig()) {
  const count = Number((await pool.query(`SELECT COUNT(*) AS n FROM posts WHERE ${eligible}`)).rows[0].n);
  return { count, estUsd: count * estimateCostUsd(estimatedUsage, cfg) };
}

async function runLayoutRecheck({ pool = require('./db'), describe, cfg = sortConfig(), videoDir, limit } = {}) {
  const result = { rechecked: 0, errored: 0, skippedCap: 0 };
  if (!cfg.enabled) return result;
  return withSortLock(async () => {
    let available = Math.max(0, cfg.dailyMax - await attemptsToday(pool));
    // Snapshot IDs once: errors and invalid responses leave layout unknown, but
    // must not be retried indefinitely by this job's later batches.
    let candidates = (await pool.query(`SELECT id FROM posts WHERE ${eligible} ORDER BY ${order}`)).rows;
    if (limit !== undefined) candidates = candidates.slice(0, Math.max(0, Math.floor(limit)));
    if (!available || !candidates.length) {
      result.skippedCap = candidates.length;
      return result;
    }
    const types = (await pool.query('SELECT value,label,description FROM content_types ORDER BY sort_order,label')).rows;
    const lookTags = (await pool.query("SELECT value,label,category FROM look_tags WHERE category <> 'custom' ORDER BY category,sort_order,label")).rows;
    let client;
    for (let offset = 0; offset < candidates.length; offset += cfg.batch) {
      const ids = candidates.slice(offset, offset + cfg.batch).map(post => post.id);
      const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
      const posts = (await pool.query(`SELECT * FROM posts WHERE id IN (${placeholders}) AND ${eligible} ORDER BY ${order}`, ids)).rows;
      for (let index = 0; index < posts.length; index++) {
        const post = posts[index];
        if (!available) {
          result.skippedCap = posts.length - index + Math.max(0, candidates.length - offset - ids.length);
          return result;
        }
        let attemptId;
        let cost = estimateCostUsd(estimatedUsage, cfg);
        try {
          const filePath = require('./videos').videoFilePath(post, videoDir);
          await fs.access(filePath);
          const current = (await pool.query(`SELECT * FROM posts WHERE id=$1 AND ${eligible}`, [post.id])).rows[0];
          if (!current) continue;
          // Keep attempts and spend in the shared ledger; the only post column
          // this job may change is ai_layout, even when the paid call fails.
          const attempt = await pool.query(`INSERT INTO look_backfill_attempts(post_id,attempted_at,cost_usd)
            VALUES($1,$2,$3) RETURNING id`, [post.id, new Date().toISOString(), cost]);
          attemptId = attempt.rows[0].id;
          available--;
          const input = { filePath, caption: current.caption || '', handle: current.account_handle || '', types, lookTags };
          const ai = describe ? await describe(input) : await describeReel(input, {
            client: client || (client = makeGeminiClient(process.env.GEMINI_API_KEY)), model: cfg.model,
          });
          cost = ai.usage ? estimateCostUsd(ai.usage, cfg) : cost;
          await pool.query('UPDATE look_backfill_attempts SET cost_usd=$1 WHERE id=$2', [cost, attemptId]);
          const layout = cleanLayout(ai.layout);
          if (!layout) throw new Error('Invalid layout classification');
          const update = await pool.query(`UPDATE posts SET ai_layout=$1 WHERE id=$2 AND ${eligible}`, [layout, post.id]);
          result.rechecked += update.rowCount;
        } catch (error) {
          result.errored++;
          console.error(`[Layout recheck] reel=${post.id}:`, error.message);
        } finally {
          if (attemptId !== undefined) console.log(`[Layout recheck] reel=${post.id} estimated_usd=${cost.toFixed(6)}`);
        }
      }
    }
    return result;
  });
}

module.exports = { layoutRecheckEstimate, runLayoutRecheck };
