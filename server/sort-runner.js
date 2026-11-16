const fs = require('node:fs/promises');
const { decideSort, sortConfig } = require('./sort-status');
const { describeReel, estimateCostUsd, makeGeminiClient, cleanAiLookTags, cleanTranscript, cleanAudioKind, cleanLayout } = require('./gemini-sort');
const { decideTalkingVsLipSync } = require('./lipsync-signals');

let running = false;
let whenIdle = Promise.resolve();
const liveClause = "(soft_deleted = 0 OR soft_deleted IS NULL) AND (archived = 0 OR archived IS NULL)";
const candidateClause = `video_cache_status = 'cached' AND sort_status = 'unsorted' AND COALESCE(ai_attempts,0) < $1 AND ${liveClause}`;
const emptyResult = () => ({ classified: 0, auto: 0, needsLook: 0, errored: 0, skippedCap: 0 });

async function attemptsToday(pool) {
  // Lifetime attempts on recently attempted rows conservatively bound 24h spend.
  // COUNT(*) would undercount retries and let a failing batch exceed the cap.
  const cutoff = new Date(Date.now() - 86400000).toISOString();
  const result = await pool.query(`SELECT COALESCE(SUM(n),0) AS n FROM (
    SELECT COALESCE(SUM(ai_attempts),0) AS n FROM posts WHERE ai_last_attempt_at >= $1
    UNION ALL SELECT COUNT(*) AS n FROM suggested_reels WHERE ai_classified_at >= $2
    UNION ALL SELECT COUNT(*) AS n FROM look_backfill_attempts WHERE attempted_at >= $3
  ) attempts`, [cutoff, cutoff, cutoff]);
  return Number(result.rows[0].n);
}

async function withSortLock(work, { waitForIdle = true, skipped } = {}) {
  if (running) {
    if (!waitForIdle) return skipped;
    await whenIdle;
    return withSortLock(work, { waitForIdle, skipped });
  }
  running = true; // Posts and candidate reels share the same daily Gemini budget.
  let release;
  whenIdle = new Promise(resolve => { release = resolve; });
  try { return await work(); }
  finally { running = false; release(); }
}

async function runAutoSort({ pool = require('./db'), describe, detect, cfg = sortConfig(), limit, videoDir, waitForIdle = false } = {}) {
  const result = emptyResult();
  if (!cfg.enabled) return result;
  return withSortLock(async () => {
    const { repeatedAudio, refreshRepeatedAudio, checkTalkingPost, lipSyncDetector } = require('./lipsync-recheck');
    await refreshRepeatedAudio(pool, await repeatedAudio(pool));
    // Recover a process exit after claiming the final attempt, even at the cap.
    await pool.query(`UPDATE posts SET sort_status='needs_look', content_type=NULL,
      ai_error=COALESCE(ai_error,'Classification interrupted after final attempt')
      WHERE sort_status='unsorted' AND COALESCE(ai_attempts,0) >= $1 AND ${liveClause}`, [cfg.maxAttempts]);
    const available = Math.max(0, cfg.dailyMax - await attemptsToday(pool));
    const count = Number((await pool.query(`SELECT COUNT(*) AS n FROM posts WHERE ${candidateClause}`, [cfg.maxAttempts])).rows[0].n);
    const requested = Math.max(0, Math.min(limit ?? cfg.batch, cfg.batch, count));
    result.skippedCap = Math.max(0, requested - available);
    const batch = Math.min(requested, available);
    if (!batch) return result;
    const types = (await pool.query('SELECT value,label,description FROM content_types ORDER BY sort_order,label')).rows;
    const lookTags = (await pool.query("SELECT value,label,category FROM look_tags WHERE category <> 'custom' ORDER BY category,sort_order,label")).rows;
    const candidates = (await pool.query(`SELECT * FROM posts WHERE ${candidateClause} ORDER BY posted_at DESC, id DESC LIMIT $2`, [cfg.maxAttempts, batch])).rows;
    if (!describe) {
      const client = makeGeminiClient(process.env.GEMINI_API_KEY);
      describe = input => describeReel(input, { client, model: cfg.model });
    }
    let consecutiveDescribeFailures = 0;
    for (const [index, post] of candidates.entries()) {
      // A talking reel spends another attempt on its dedicated detector, so
      // the budget calculated before this batch is no longer sufficient.
      if (await attemptsToday(pool) >= cfg.dailyMax) {
        result.skippedCap += candidates.length - index;
        break;
      }
      const claim = await pool.query(`UPDATE posts SET ai_attempts = COALESCE(ai_attempts,0)+1, ai_last_attempt_at = $1
        WHERE id = $2 AND sort_status = 'unsorted' AND ${liveClause}`, [new Date().toISOString(), post.id]);
      if (!claim.rowCount) continue;
      try {
        const filePath = require('./videos').videoFilePath(post, videoDir);
        await fs.access(filePath); // A cache row can outlive a pruned volume file.
        let ai;
        try {
          ai = await describe({ filePath, caption: post.caption || '', handle: post.account_handle || '', types, lookTags });
        } catch (error) {
          consecutiveDescribeFailures++;
          throw error;
        }
        consecutiveDescribeFailures = 0;
        const decision = decideSort({ ai, typeValues: types.map(t => t.value), threshold: cfg.minConfidence });
        const checkTalking = decision.sortStatus === 'auto' && decision.contentType === 'talking';
        const cost = estimateCostUsd(ai.usage || {}, cfg);
        const update = await pool.query(`UPDATE posts SET content_type=$1, sort_status=$2,
          ai_type=$3, ai_confidence=$4, ai_description=$5, ai_suggested_type=$6, ai_model=$7,
          ai_classified_at=$8, ai_cost_usd=$9, ai_look_tags=$10, ai_transcript=$11, ai_audio_kind=$12, ai_layout=$13, ai_error=NULL
          WHERE id=$14 AND sort_status='unsorted' AND ${liveClause}`,
        [decision.contentType, checkTalking ? 'needs_look' : decision.sortStatus, ai.type, ai.confidence, ai.description,
          checkTalking ? 'lipsync' : ai.suggestedType, cfg.model, new Date().toISOString(), cost,
          JSON.stringify(cleanAiLookTags(ai.lookTags, lookTags)), ai.audioKind === 'own_speech' ? cleanTranscript(ai.transcript) : null,
          cleanAudioKind(ai.audioKind), cleanLayout(ai.layout), post.id]);
        console.log(`[Sort] reel=${post.id} status=${decision.sortStatus} estimated_usd=${cost.toFixed(6)}`);
        if (update.rowCount) {
          result.classified++;
          result[decision.sortStatus === 'auto' ? 'auto' : 'needsLook']++;
          if (checkTalking) {
            let checked;
            try {
              detect ||= lipSyncDetector(cfg);
              const repeats = await repeatedAudio(pool);
              checked = await checkTalkingPost({ pool, post, detect, cfg, videoDir, repeated: repeats.get(post.id), pendingSort: true });
              if (checked.updated && checked.decision.sortStatus === 'needs_look') {
                result.auto--;
                result.needsLook++;
              }
              if (checked.skippedCap) result.skippedCap++;
            } catch (error) {
              result.errored++;
              console.error(`[Lip sync] reel=${post.id}:`, error.message);
            } finally {
              const repeats = await repeatedAudio(pool);
              if (!checked?.detected) {
                // A missing paid verdict is weak evidence too. Do not publish
                // unchecked talking reels to Film when the cap or API fails.
                const repeated = repeats.get(post.id);
                const fallback = decideTalkingVsLipSync({ repeated });
                const update = await pool.query(`UPDATE posts SET sort_status=$1,content_type=$2,
                  ai_suggested_type=$3,lipsync_repeat_of=$4
                  WHERE id=$5 AND sort_status='needs_look' AND ai_suggested_type='lipsync' AND content_type='talking'
                    AND ai_lipsync_checked_at IS NULL AND ${liveClause}`,
                [fallback.sortStatus, fallback.contentType || 'talking', fallback.suggestedType || null,
                  repeated?.matchId ?? null, post.id]);
                if (update.rowCount && fallback.sortStatus === 'needs_look') {
                  result.auto--;
                  result.needsLook++;
                }
              }
              await refreshRepeatedAudio(pool, repeats);
            }
          }
        }
      } catch (error) {
        await pool.query(`UPDATE posts SET ai_error=$1,
          sort_status=CASE WHEN ai_attempts >= $2 THEN 'needs_look' ELSE 'unsorted' END, content_type=NULL
          WHERE id=$3 AND sort_status='unsorted' AND ${liveClause}`, [error.message, cfg.maxAttempts, post.id]);
        result.errored++;
        console.error(`[Sort] reel=${post.id}:`, error.message);
        if (consecutiveDescribeFailures >= 3) {
          result.stoppedOnDescribeErrors = true;
          break;
        }
      }
    }
    return result;
  }, { waitForIdle, skipped: result });
}

async function backfillEstimate(pool, cfg = sortConfig()) {
  const count = Number((await pool.query(`SELECT COUNT(*) AS n FROM posts WHERE ${candidateClause}`, [cfg.maxAttempts])).rows[0].n);
  return { count, estUsd: count * estimateCostUsd({ inTokens: 3400, outTokens: 1600 }, cfg) };
}

async function sortUsage(pool, cfg = sortConfig()) {
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
  const result = await pool.query(`SELECT COALESCE(SUM(reels),0) AS reels, COALESCE(SUM(usd),0) AS usd FROM (
    SELECT COUNT(*) AS reels, COALESCE(SUM(ai_cost_usd),0) AS usd FROM posts WHERE ai_classified_at >= $1
    UNION ALL SELECT COUNT(*) AS reels, COALESCE(SUM(ai_cost_usd),0) AS usd FROM suggested_reels WHERE ai_classified_at >= $2
    UNION ALL SELECT COUNT(*) AS reels, COALESCE(SUM(cost_usd),0) AS usd FROM look_backfill_attempts WHERE attempted_at >= $3
  ) usage`, [cutoff, cutoff, cutoff]);
  return { reels30d: Number(result.rows[0].reels), usd30d: Number(result.rows[0].usd), today: await attemptsToday(pool), dailyMax: cfg.dailyMax };
}

module.exports = { runAutoSort, backfillEstimate, sortUsage, attemptsToday, withSortLock };
