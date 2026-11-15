const fs = require('node:fs/promises');
const path = require('node:path');
const { parseNiches } = require('./me-feed');
const { sortConfig } = require('./sort-status');
const { describeReel, estimateCostUsd, makeGeminiClient, cleanAiLookTags } = require('./gemini-sort');
const { downloadVideo, tempVideoPath, DEFAULT_VIDEO_DIR } = require('./videos');
const { attemptsToday, withSortLock } = require('./sort-runner');

function sortedReels(reels) {
  return reels.filter(reel => !reel.ai_error && (reel.ai_classified_at || Number.isFinite(reel.ai_confidence)));
}

function computeFit({ reels, niches, minConfidence, sourceOwned, boost }) {
  const sorted = sortedReels(reels);
  if (sorted.length < 2) return null;
  const matching = sorted.filter(reel => niches.includes(reel.ai_type) &&
    Number.isFinite(reel.ai_confidence) && reel.ai_confidence >= minConfidence).length;
  return Math.min(1, matching / sorted.length + (sourceOwned ? boost : 0));
}

async function downloadCandidate(download, reel, videoDir) {
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await download(reel, { videoDir });
      if (result.status !== 'cached') throw new Error(result.error || `Download ${result.status}`);
      return;
    } catch (error) {
      const status = Number(error.status || error.response?.status) || Number(/HTTP (\d{3})/.exec(error.message)?.[1]);
      if (attempt >= 2 || !(status === 429 || (status >= 500 && status <= 599))) throw error;
      await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }
}

async function routeCandidate(username, {
  pool = require('./db'), describe, download = downloadVideo, cfg = sortConfig(), videoDir = DEFAULT_VIDEO_DIR,
} = {}) {
  const result = { sorted: 0, routed: [] };
  if (!cfg.enabled) return result;
  const handle = String(username).trim().replace(/^@/, '').toLowerCase();
  return withSortLock(async () => {
    const available = Math.max(0, cfg.dailyMax - await attemptsToday(pool));
    const candidates = (await pool.query(`SELECT * FROM suggested_reels
      WHERE LOWER(username)=$1 AND ai_classified_at IS NULL ORDER BY rank,id LIMIT $2`,
    [handle, Math.min(3, available)])).rows;
    const types = (await pool.query('SELECT value,label FROM content_types ORDER BY sort_order,label')).rows;
    const lookTags = (await pool.query("SELECT value,label,category FROM look_tags WHERE category <> 'custom' ORDER BY category,sort_order,label")).rows;
    for (const reel of candidates) {
      // A unique candidate key cannot collide with posts.id in the shared cache.
      const filePath = `${tempVideoPath(`candidate-${reel.id}`, videoDir)}.mp4`;
      const downloadPost = { ...reel, id: path.basename(filePath, '.mp4') };
      try {
        await downloadCandidate(download, downloadPost, videoDir);
        if (!describe) {
          const client = makeGeminiClient(process.env.GEMINI_API_KEY);
          describe = input => describeReel(input, { client, model: cfg.model });
        }
        const ai = await describe({ filePath, caption: reel.caption || '', handle, types, lookTags });
        const cost = estimateCostUsd(ai.usage || {}, cfg);
        await pool.query(`UPDATE suggested_reels SET ai_type=$1, ai_confidence=$2, ai_error=NULL,
          ai_classified_at=$3, ai_cost_usd=$4, ai_look_tags=$5 WHERE id=$6`,
        [ai.type, ai.confidence, new Date().toISOString(), cost, JSON.stringify(cleanAiLookTags(ai.lookTags, lookTags)), reel.id]);
        result.sorted++;
        console.log(`[Route] @${handle} reel=${reel.id} estimated_usd=${cost.toFixed(6)}`);
      } catch (error) {
        await pool.query(`UPDATE suggested_reels SET ai_error=$1, ai_classified_at=$2, ai_cost_usd=0 WHERE id=$3`,
          [error.message, new Date().toISOString(), reel.id]);
        console.error(`[Route] @${handle} reel=${reel.id}:`, error.message);
      } finally {
        try { await fs.unlink(filePath); }
        catch (error) { if (error.code !== 'ENOENT') console.error('[Route] Temp cleanup failed:', error.message); }
      }
    }

    const reels = (await pool.query(`SELECT * FROM suggested_reels WHERE LOWER(username)=$1
      AND ai_classified_at IS NOT NULL ORDER BY rank,id LIMIT 3`, [handle])).rows;
    if (sortedReels(reels).length < 2) return result;
    const models = (await pool.query("SELECT * FROM models WHERE status='active' ORDER BY id")).rows;
    const creators = (await pool.query('SELECT model_id,username FROM model_creators')).rows;
    const sources = (await pool.query('SELECT source FROM suggested_accounts WHERE LOWER(username)=$1', [handle])).rows
      .flatMap(row => String(row.source || '').split(','))
      .map(source => source.trim().replace(/^@/, '').toLowerCase()).filter(Boolean);
    const boost = cfg.suggestSourceBoost ?? Number(process.env.SUGGEST_SOURCE_BOOST || 0.25);
    const minFit = cfg.suggestMinFit ?? Number(process.env.SUGGEST_MIN_FIT || 0.34);
    for (const model of models) {
      const niches = parseNiches(model);
      const source = sources.find(token => creators.some(creator => Number(creator.model_id) === Number(model.id) &&
        String(creator.username).toLowerCase() === token));
      const fit = computeFit({ reels, niches, minConfidence: cfg.minConfidence, sourceOwned: !!source, boost });
      if (fit === null || fit < minFit) continue;
      const sorted = sortedReels(reels);
      const matching = sorted.filter(reel => niches.includes(reel.ai_type) && reel.ai_confidence >= cfg.minConfidence).length;
      const labels = niches.map(niche => types.find(type => type.value === niche)?.label || niche).join(' / ');
      const reason = `${matching} of ${sorted.length} reels ${labels}` +
        (source ? ` · found via @${source} (${model.name}'s creator)` : '');
      await pool.query(`INSERT INTO model_suggestions(model_id,username,fit,reason,created_at)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(model_id,username) DO UPDATE SET fit=excluded.fit,reason=excluded.reason`,
      [model.id, handle, fit, reason, new Date().toISOString()]);
      result.routed.push(model.id);
    }
    return result;
  });
}

module.exports = { computeFit, routeCandidate };
