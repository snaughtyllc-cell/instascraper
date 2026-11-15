const fs = require('node:fs/promises');
const { sortConfig } = require('./sort-status');
const { describeReel, estimateCostUsd, makeGeminiClient, cleanAiLookTags } = require('./gemini-sort');
const { attemptsToday, withSortLock } = require('./sort-runner');

const eligible = `sort_status IN ('auto','manual','needs_look') AND video_cache_status='cached'
  AND ai_look_tags IS NULL AND (soft_deleted=0 OR soft_deleted IS NULL) AND (archived=0 OR archived IS NULL)`;
const estimatedUsage = { inTokens: 3400, outTokens: 1600 };

async function lookBackfillEstimate(pool, cfg = sortConfig()) {
  const count = Number((await pool.query(`SELECT COUNT(*) AS n FROM posts WHERE ${eligible}`)).rows[0].n);
  return { count, estUsd: count * estimateCostUsd(estimatedUsage, cfg) };
}

async function runLookBackfill({ pool = require('./db'), describe, cfg = sortConfig(), videoDir, limit } = {}) {
  const result = { tagged: 0, errored: 0, skippedCap: 0 };
  if (!cfg.enabled) return result;
  return withSortLock(async () => {
    const available = Math.max(0, cfg.dailyMax - await attemptsToday(pool));
    const { count } = await lookBackfillEstimate(pool, cfg);
    const requested = Math.max(0, Math.min(limit ?? cfg.batch, cfg.batch, count));
    result.skippedCap = Math.max(0, requested - available);
    const batch = Math.min(requested, available);
    if (!batch) return result;
    const types = (await pool.query('SELECT value,label,description FROM content_types ORDER BY sort_order,label')).rows;
    const lookTags = (await pool.query("SELECT value,label,category FROM look_tags WHERE category <> 'custom' ORDER BY category,sort_order,label")).rows;
    const posts = (await pool.query(`SELECT * FROM posts WHERE ${eligible} ORDER BY posted_at DESC,id DESC LIMIT $1`, [batch])).rows;
    let client;
    for (const post of posts) {
      let attemptId;
      let cost = estimateCostUsd(estimatedUsage, cfg);
      try {
        const filePath = require('./videos').videoFilePath(post, videoDir);
        await fs.access(filePath);
        // A separate ledger counts failed/aborted calls without changing the reel's sort metadata.
        // Reserve the estimated spend before the call; replace it with reported usage on success.
        const attempt = await pool.query(`INSERT INTO look_backfill_attempts(post_id,attempted_at,cost_usd)
          VALUES($1,$2,$3) RETURNING id`, [post.id, new Date().toISOString(), cost]);
        attemptId = attempt.rows[0].id;
        const input = { filePath, caption: post.caption || '', handle: post.account_handle || '', types, lookTags };
        const ai = describe ? await describe(input) : await describeReel(input, {
          client: client || (client = makeGeminiClient(process.env.GEMINI_API_KEY)), model: cfg.model,
        });
        cost = ai.usage ? estimateCostUsd(ai.usage, cfg) : cost;
        await pool.query('UPDATE look_backfill_attempts SET cost_usd=$1 WHERE id=$2', [cost, attemptId]);
        const update = await pool.query(`UPDATE posts SET ai_look_tags=$1 WHERE id=$2 AND ${eligible}`,
          [JSON.stringify(cleanAiLookTags(ai.lookTags, lookTags)), post.id]);
        result.tagged += update.rowCount;
      } catch (error) {
        await pool.query(`UPDATE posts SET ai_look_tags='[]' WHERE id=$1 AND ${eligible}`, [post.id]);
        result.errored++;
        console.error(`[Look] reel=${post.id}:`, error.message);
      } finally {
        if (attemptId !== undefined) console.log(`[Look] reel=${post.id} estimated_usd=${cost.toFixed(6)}`);
      }
    }
    return result;
  });
}

module.exports = { lookBackfillEstimate, runLookBackfill };
