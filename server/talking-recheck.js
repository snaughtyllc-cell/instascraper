const fs = require('node:fs/promises');
const { decideSort, sortConfig } = require('./sort-status');
const { describeReel, estimateCostUsd, makeGeminiClient, cleanAiLookTags, cleanTranscript, cleanAudioKind } = require('./gemini-sort');
const { attemptsToday, withSortLock } = require('./sort-runner');

const eligible = `sort_status='auto' AND content_type='talking' AND video_cache_status='cached'
  AND (soft_deleted=0 OR soft_deleted IS NULL) AND (archived=0 OR archived IS NULL)`;
const priority = 'EXISTS (SELECT 1 FROM model_creators mc WHERE mc.model_id=$1 AND LOWER(mc.username)=LOWER(posts.account_handle))';
const estimatedUsage = { inTokens: 3400, outTokens: 1600 };

async function talkingRecheckEstimate(pool, cfg = sortConfig(), { modelId } = {}) {
  const count = Number((await pool.query(`SELECT COUNT(*) AS n FROM posts WHERE ${eligible}`)).rows[0].n);
  const estimate = { count, estUsd: count * estimateCostUsd(estimatedUsage, cfg) };
  if (modelId !== undefined) {
    estimate.priorityCount = Number((await pool.query(`SELECT COUNT(*) AS n FROM posts WHERE ${eligible} AND ${priority}`, [modelId])).rows[0].n);
  }
  return estimate;
}

async function runTalkingRecheck({ pool = require('./db'), describe, cfg = sortConfig(), videoDir, limit, modelId } = {}) {
  const result = { rechecked: 0, auto: 0, needsLook: 0, errored: 0, skippedCap: 0 };
  if (!cfg.enabled) return result;
  return withSortLock(async () => {
    const available = Math.max(0, cfg.dailyMax - await attemptsToday(pool));
    const { count } = await talkingRecheckEstimate(pool, cfg);
    const requested = Math.max(0, Math.min(limit ?? count, count));
    result.skippedCap = Math.max(0, requested - available);
    const batch = Math.min(requested, available);
    if (!batch) return result;
    const types = (await pool.query('SELECT value,label,description FROM content_types ORDER BY sort_order,label')).rows;
    const lookTags = (await pool.query("SELECT value,label,category FROM look_tags WHERE category <> 'custom' ORDER BY category,sort_order,label")).rows;
    // Advance the unchecked queue across daily caps. A previously checked
    // workspace or a missing cache file must not repeatedly hide other reels.
    const order = `CASE WHEN ai_error IS NULL THEN 0 ELSE 1 END,
      CASE WHEN ai_audio_kind IN ('own_speech','music_or_trending_audio','other_voice','none') THEN 1 ELSE 0 END,
      ${modelId === undefined ? '' : `CASE WHEN ${priority} THEN 0 ELSE 1 END,`}
      CASE WHEN ai_classified_at IS NULL THEN 0 ELSE 1 END,ai_classified_at,posted_at DESC,id DESC`;
    // Snapshot this job's candidates once. Own-speech reels remain auto/talking
    // after a successful recheck and must not be selected again by this run.
    const posts = (await pool.query(`SELECT * FROM posts WHERE ${eligible} ORDER BY ${order} LIMIT $${modelId === undefined ? 1 : 2}`,
      modelId === undefined ? [batch] : [modelId, batch])).rows;
    let client;
    let consecutiveDescribeFailures = 0;
    for (const post of posts) {
      let attemptId;
      let cost = estimateCostUsd(estimatedUsage, cfg);
      try {
        const filePath = require('./videos').videoFilePath(post, videoDir);
        await fs.access(filePath);
        const current = (await pool.query(`SELECT * FROM posts WHERE id=$1 AND ${eligible}`, [post.id])).rows[0];
        if (!current) continue;
        // Reserve shared budget before the paid call, including failures and
        // calls whose result loses a race with a human classification.
        const attempt = await pool.query(`INSERT INTO look_backfill_attempts(post_id,attempted_at,cost_usd)
          VALUES($1,$2,$3) RETURNING id`, [post.id, new Date().toISOString(), cost]);
        attemptId = attempt.rows[0].id;
        const input = { filePath, caption: current.caption || '', handle: current.account_handle || '', types, lookTags };
        let ai;
        try {
          ai = describe ? await describe(input) : await describeReel(input, {
            client: client || (client = makeGeminiClient(process.env.GEMINI_API_KEY)), model: cfg.model,
          });
        } catch (error) {
          consecutiveDescribeFailures++;
          throw error;
        }
        consecutiveDescribeFailures = 0;
        const audioKind = cleanAudioKind(ai.audioKind);
        const decision = decideSort({ ai: { ...ai, audioKind }, typeValues: types.map(type => type.value), threshold: cfg.minConfidence });
        cost = ai.usage ? estimateCostUsd(ai.usage, cfg) : cost;
        await pool.query('UPDATE look_backfill_attempts SET cost_usd=$1 WHERE id=$2', [cost, attemptId]);
        const update = await pool.transaction(async db => {
          const update = await db.query(`UPDATE posts SET content_type=$1, sort_status=$2,
            ai_type=$3, ai_confidence=$4, ai_description=$5, ai_suggested_type=$6, ai_model=$7,
            ai_classified_at=$8, ai_cost_usd=COALESCE(ai_cost_usd,0)+$9, ai_look_tags=$10,
            ai_transcript=$11, ai_audio_kind=$12, ai_error=NULL
            WHERE id=$13 AND ${eligible}`,
          [decision.contentType, decision.sortStatus, ai.type, ai.confidence, ai.description, ai.suggestedType || null,
            cfg.model, new Date().toISOString(), cost, JSON.stringify(cleanAiLookTags(ai.lookTags, lookTags)),
            audioKind === 'own_speech' ? cleanTranscript(ai.transcript) : null, audioKind, post.id]);
          // Successful cost lives on the post; the attempt ledger still counts
          // this call toward the cap without counting its spend a second time.
          await db.query('UPDATE look_backfill_attempts SET cost_usd=$1 WHERE id=$2', [update.rowCount ? 0 : cost, attemptId]);
          return update;
        });
        if (update.rowCount) {
          result.rechecked++;
          result[decision.sortStatus === 'auto' ? 'auto' : 'needsLook']++;
        }
      } catch (error) {
        await pool.query(`UPDATE posts SET ai_error=$1 WHERE id=$2 AND ${eligible}`, [error.message, post.id]);
        result.errored++;
        console.error(`[Talking recheck] reel=${post.id}:`, error.message);
        if (consecutiveDescribeFailures >= 3) {
          result.stoppedOnDescribeErrors = true;
          break;
        }
      } finally {
        if (attemptId !== undefined) console.log(`[Talking recheck] reel=${post.id} estimated_usd=${cost.toFixed(6)}`);
      }
    }
    return result;
  });
}

module.exports = { talkingRecheckEstimate, runTalkingRecheck };
