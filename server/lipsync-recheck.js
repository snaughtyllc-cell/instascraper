const fs = require('node:fs/promises');
const { sortConfig, lipSyncConfig } = require('./sort-status');
const { detectLipSync, cleanLipSyncResult, estimateCostUsd, makeGeminiClient } = require('./gemini-sort');
const { findRepeatedAudio, decideTalkingVsLipSync } = require('./lipsync-signals');

const live = '(soft_deleted=0 OR soft_deleted IS NULL) AND (archived=0 OR archived IS NULL)';
const eligible = `sort_status='auto' AND content_type='talking' AND video_cache_status='cached'
  AND ai_lipsync_checked_at IS NULL AND ${live}`;
const priority = 'EXISTS (SELECT 1 FROM model_creators mc WHERE mc.model_id=$1 AND LOWER(mc.username)=LOWER(posts.account_handle))';
// Budget allowance for medium-resolution video and medium thinking. Successful
// calls use the detector's reported tokens rather than this per-reel estimate.
const estimatedUsage = { inTokens: 10000, outTokens: 2400 };

async function repeatedAudio(pool) {
  const rows = (await pool.query(`SELECT id,account_handle,ai_transcript FROM posts
    WHERE (soft_deleted=0 OR soft_deleted IS NULL) AND ai_transcript IS NOT NULL AND ai_transcript<>''`)).rows;
  return findRepeatedAudio(rows);
}

// This free sweep also revisits older reels when a new transcript matches them.
// Current paid-job candidates are held back so both signals decide together.
async function refreshRepeatedAudio(pool, repeats, excludeIds = new Set()) {
  const rows = (await pool.query(`SELECT * FROM posts WHERE sort_status='auto' AND content_type='talking' AND ${live}`)).rows;
  for (const post of rows) {
    const repeated = repeats.get(post.id);
    if (!repeated || excludeIds.has(post.id)) continue;
    const decision = decideTalkingVsLipSync({ detector: { verdict: post.ai_lipsync_verdict,
      confidence: post.ai_lipsync_confidence }, repeated, audioKind: post.ai_audio_kind });
    await pool.query(`UPDATE posts SET sort_status=$1,content_type=$2,ai_suggested_type=$3,lipsync_repeat_of=$4
      WHERE id=$5 AND sort_status='auto' AND content_type='talking' AND ${live}`,
    [decision.sortStatus, decision.contentType || post.content_type, decision.suggestedType || null, repeated.matchId, post.id]);
  }
}

async function lipSyncRecheckEstimate(pool, cfg = sortConfig(), { modelId } = {}) {
  const count = Number((await pool.query(`SELECT COUNT(*) AS n FROM posts WHERE ${eligible}`)).rows[0].n);
  const priorityCount = modelId === undefined ? 0 : Number((await pool.query(`SELECT COUNT(*) AS n FROM posts
    WHERE ${eligible} AND ${priority}`, [modelId])).rows[0].n);
  return { count, priorityCount, estUsd: count * estimateCostUsd(estimatedUsage, lipSyncConfig()) };
}

// The caller owns withSortLock; keeping this helper unlocked avoids a nested lock
// when automatic sorting checks a talking reel in the same pass.
async function checkTalkingPost({ pool, post, detect, cfg, videoDir, repeated, pendingSort = false }) {
  const { attemptsToday } = require('./sort-runner');
  const checkable = pendingSort
    ? `sort_status='needs_look' AND content_type='talking' AND ai_suggested_type='lipsync'
      AND video_cache_status='cached' AND ai_lipsync_checked_at IS NULL AND ${live}`
    : eligible;
  const current = (await pool.query(`SELECT * FROM posts WHERE id=$1 AND ${checkable}`, [post.id])).rows[0];
  if (!current) return { updated: false };
  if (await attemptsToday(pool) >= cfg.dailyMax) return { updated: false, skippedCap: 1 };
  const prices = lipSyncConfig();
  let attemptId;
  let cost = estimateCostUsd(estimatedUsage, prices);
  try {
    const filePath = require('./videos').videoFilePath(current, videoDir);
    await fs.access(filePath);
    const attempt = await pool.query(`INSERT INTO look_backfill_attempts(post_id,attempted_at,cost_usd)
      VALUES($1,$2,$3) RETURNING id`, [post.id, new Date().toISOString(), cost]);
    attemptId = attempt.rows[0].id;
    let raw;
    try {
      raw = await detect({ filePath, caption: current.caption || '', handle: current.account_handle || '' });
      raw = { ...cleanLipSyncResult(raw), usage: raw.usage };
    } catch (error) {
      error.lipSyncDetectorFailure = true;
      throw error;
    }
    const decision = decideTalkingVsLipSync({ detector: raw, repeated, audioKind: current.ai_audio_kind });
    if (raw.usage) cost = estimateCostUsd(raw.usage, prices);
    await pool.query('UPDATE look_backfill_attempts SET cost_usd=$1 WHERE id=$2', [cost, attemptId]);
    const update = await pool.transaction(async db => {
      const update = await db.query(`UPDATE posts SET sort_status=$1,content_type=$2,ai_suggested_type=$3,
        ai_lipsync_verdict=$4,ai_lipsync_confidence=$5,ai_lipsync_evidence=$6,ai_lipsync_checked_at=$7,
        lipsync_repeat_of=$8,ai_transcript=$9,ai_cost_usd=COALESCE(ai_cost_usd,0)+$10,ai_error=NULL,
        ai_classified_at=$11 WHERE id=$12 AND ${checkable}`,
      [decision.sortStatus, decision.contentType || current.content_type, decision.suggestedType || null,
        raw.verdict, raw.confidence, JSON.stringify(raw.evidence), new Date().toISOString(), repeated?.matchId ?? null,
        decision.contentType === 'lipsync' && raw.words !== null ? raw.words : current.ai_transcript,
        cost, new Date().toISOString(), post.id]);
      await db.query('UPDATE look_backfill_attempts SET cost_usd=$1 WHERE id=$2', [update.rowCount ? 0 : cost, attemptId]);
      return update;
    });
    return { updated: !!update.rowCount, decision, detected: true };
  } catch (error) {
    await pool.query(`UPDATE posts SET ai_error=$1 WHERE id=$2 AND ${checkable}`, [error.message, post.id]);
    throw error;
  } finally {
    if (attemptId !== undefined) console.log(`[Lip sync] reel=${post.id} estimated_usd=${cost.toFixed(6)}`);
  }
}

function lipSyncDetector(cfg) {
  let client;
  return input => detectLipSync(input, {
    client: client || (client = makeGeminiClient(process.env.GEMINI_API_KEY)),
    model: process.env.LIPSYNC_MODEL || 'gemini-3.5-flash',
  });
}

async function runLipSyncRecheck({ pool = require('./db'), detect, cfg = sortConfig(), videoDir, limit, modelId } = {}) {
  const result = { rechecked: 0, auto: 0, needsLook: 0, errored: 0, skippedCap: 0 };
  if (!cfg.enabled) return result;
  const { attemptsToday, withSortLock } = require('./sort-runner');
  return withSortLock(async () => {
    const available = Math.max(0, cfg.dailyMax - await attemptsToday(pool));
    const { count } = await lipSyncRecheckEstimate(pool, cfg);
    const requested = Math.max(0, Math.min(limit ?? count, count));
    result.skippedCap = Math.max(0, requested - available);
    const order = `${modelId === undefined ? '' : `CASE WHEN ${priority} THEN 0 ELSE 1 END,`}posted_at DESC,id DESC`;
    // Snapshot all requested candidates so missing cache files cannot starve
    // healthy rows behind them while the daily cap still has room.
    const posts = (await pool.query(`SELECT * FROM posts WHERE ${eligible} ORDER BY ${order}
      LIMIT $${modelId === undefined ? 1 : 2}`, modelId === undefined ? [requested] : [modelId, requested])).rows;
    const pending = new Set(posts.map(post => post.id));
    let repeats = await repeatedAudio(pool);
    await refreshRepeatedAudio(pool, repeats, pending);
    detect ||= lipSyncDetector(cfg);
    let failures = 0;
    for (const post of posts) {
      if (await attemptsToday(pool) >= cfg.dailyMax) break;
      try {
        const checked = await checkTalkingPost({ pool, post, detect, cfg, videoDir, repeated: repeats.get(post.id) });
        if (checked.detected) failures = 0;
        if (checked.updated) {
          result.rechecked++;
          result[checked.decision.sortStatus === 'auto' ? 'auto' : 'needsLook']++;
        }
      } catch (error) {
        result.errored++;
        console.error(`[Lip sync] reel=${post.id}:`, error.message);
        if (error.lipSyncDetectorFailure && ++failures >= 3) {
          result.stoppedOnDescribeErrors = true;
          break;
        }
      }
      pending.delete(post.id);
      repeats = await repeatedAudio(pool);
      await refreshRepeatedAudio(pool, repeats, pending);
    }
    // Free evidence still applies to candidates left behind by a paid-call cap
    // or outage; a stored confident live verdict sends a conflict to review.
    await refreshRepeatedAudio(pool, await repeatedAudio(pool));
    return result;
  });
}

module.exports = { runLipSyncRecheck, lipSyncRecheckEstimate, repeatedAudio, refreshRepeatedAudio, checkTalkingPost, lipSyncDetector };
