const { slugifyTypeLabel, validateTypeLabel } = require('./content-types');
const { decideSort, sortConfig } = require('./sort-status');
const { redecideFromDescription, makeGeminiClient, estimateCostUsd, cleanAiLookTags } = require('./gemini-sort');
const { withSortLock, attemptsToday } = require('./sort-runner');

const LIVE = '(soft_deleted = 0 OR soft_deleted IS NULL) AND (archived = 0 OR archived IS NULL)';
const redecideQueues = new WeakMap();

function groupSuggestions(rows) {
  const groups = new Map();
  for (const row of rows) {
    const label = String(row.ai_suggested_type || '').trim();
    const value = slugifyTypeLabel(label);
    if (!value) continue;
    const group = groups.get(value) || { value, label, count: 0 };
    group.count += 1;
    groups.set(value, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function redecideNeedsLook({ pool, redecide, cfg = sortConfig() }) {
  if (!cfg.enabled) return Promise.resolve({ redecided: 0, promoted: 0 });
  const active = redecideQueues.get(pool);
  if (active) {
    // A new content type can arrive while an older vocabulary is being used.
    // Schedule another pass so that final vocabulary is never lost.
    active.pending = true;
    active.redecide = redecide || active.redecide;
    active.cfg = cfg;
    return active.promise;
  }
  const state = { pending: true, redecide, cfg, promise: null };
  redecideQueues.set(pool, state);
  state.promise = withSortLock(async () => {
    let client;
    const totals = { redecided: 0, promoted: 0 };
    while (state.pending) {
      state.pending = false;
      const currentCfg = state.cfg;
      const available = Math.max(0, currentCfg.dailyMax - await attemptsToday(pool));
      if (!available) break;
      const types = (await pool.query('SELECT value, label FROM content_types ORDER BY sort_order, label')).rows;
      const lookTags = (await pool.query("SELECT value,label,category FROM look_tags WHERE category <> 'custom' ORDER BY category,sort_order,label")).rows;
      const rows = (await pool.query(`SELECT id, caption, ai_description FROM posts
        WHERE sort_status = 'needs_look' AND ai_description IS NOT NULL AND ai_description <> '' AND ${LIVE}
        ORDER BY id LIMIT $1`, [available])).rows;
      for (const row of rows) {
        let attemptId;
        let cost = estimateCostUsd({ inTokens: 1000, outTokens: 100 }, currentCfg);
        try {
          const input = { description: row.ai_description, caption: row.caption || '', types, lookTags };
          const attempt = await pool.query(`INSERT INTO look_backfill_attempts(post_id,attempted_at,cost_usd)
            VALUES($1,$2,$3) RETURNING id`, [row.id, new Date().toISOString(), cost]);
          attemptId = attempt.rows[0].id;
          const ai = state.redecide
            ? await state.redecide(input, { model: currentCfg.model })
            : await redecideFromDescription(input, { client: client || (client = makeGeminiClient(process.env.GEMINI_API_KEY)), model: currentCfg.model });
          const decision = decideSort({ ai, typeValues: types.map((type) => type.value), threshold: currentCfg.minConfidence });
          cost = ai.usage ? estimateCostUsd(ai.usage, currentCfg) : cost;
          const update = await pool.transaction(async db => {
            const update = await db.query(`UPDATE posts SET content_type = $1, sort_status = $2,
              ai_type = $3, ai_confidence = $4, ai_description = $5, ai_suggested_type = $6,
              ai_model = $7, ai_classified_at = $8, ai_error = NULL,
              ai_cost_usd = COALESCE(ai_cost_usd, 0) + $9,
              ai_look_tags = COALESCE($10, ai_look_tags)
              WHERE id = $11 AND sort_status = 'needs_look' AND ${LIVE}`,
            [decision.contentType, decision.sortStatus, ai.type, ai.confidence, ai.description,
              ai.suggestedType || null, currentCfg.model, new Date().toISOString(), cost,
              Array.isArray(ai.lookTags) ? JSON.stringify(cleanAiLookTags(ai.lookTags, lookTags)) : null, row.id]);
            // The post already accumulates successful text-call spend; the ledger
            // retains cost only when a concurrent human edit prevented that update.
            const rowCount = update.rowCount;
            await db.query('UPDATE look_backfill_attempts SET cost_usd=$1 WHERE id=$2', [rowCount ? 0 : cost, attemptId]);
            return { rowCount };
          });
          if (update.rowCount > 0) {
            totals.redecided += 1;
            if (decision.sortStatus === 'auto') totals.promoted += 1;
          }
        } catch (error) {
          console.error(`[Sort] redecide reel ${row.id}:`, error.message);
        } finally {
          if (attemptId !== undefined) console.log(`[Sort] redecide reel=${row.id} estimated_usd=${cost.toFixed(6)}`);
        }
      }
    }
    // Release synchronously with completing the loop. A trigger in the next
    // microtask must start fresh rather than mark an already-finished pass pending.
    redecideQueues.delete(pool);
    return totals;
  }).finally(() => {
    if (redecideQueues.get(pool) === state) redecideQueues.delete(pool);
  });
  return state.promise;
}

function registerSortRoutes(app, { pool, runAutoSort, runLookBackfill, redecide, cfg = sortConfig() }) {
  const route = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
  const backgroundRedecide = () => {
    redecideNeedsLook({ pool, redecide, cfg }).catch((error) => console.error('[Sort] redecide:', error.message));
  };

  app.get('/sort/needs-look', route(async (req, res) => {
    const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
    const limit = Math.min(100, Math.max(1, Math.floor(Number(req.query.limit) || 24)));
    const where = `sort_status = 'needs_look' AND ${LIVE}`;
    const total = Number((await pool.query(`SELECT COUNT(*) AS count FROM posts WHERE ${where}`)).rows[0].count);
    const suggestions = groupSuggestions((await pool.query(`SELECT ai_suggested_type FROM posts WHERE ${where}`)).rows);
    const posts = (await pool.query(`SELECT * FROM posts WHERE ${where}
      ORDER BY ai_classified_at DESC, id DESC LIMIT $1 OFFSET $2`, [limit, (page - 1) * limit])).rows;
    res.json({ suggestions, posts, total });
  }));

  app.post('/sort/suggested-types/:value/create', route(async (req, res) => {
    const value = String(req.params.value || '');
    const rows = (await pool.query(`SELECT id, ai_suggested_type FROM posts WHERE sort_status = 'needs_look' AND ${LIVE}`)).rows;
    const matching = rows.filter((row) => slugifyTypeLabel(row.ai_suggested_type) === value);
    if (!matching.length) return res.status(404).json({ error: 'Suggestion not found' });
    const valid = validateTypeLabel(matching[0].ai_suggested_type);
    if (!valid.ok) return res.status(400).json({ error: valid.error });
    const result = await pool.transaction(async (db) => {
      const types = (await db.query('SELECT value, label FROM content_types ORDER BY sort_order, label')).rows;
      let type = types.find((type) => type.value === value || slugifyTypeLabel(type.label) === value);
      if (!type) {
        const next = Number((await db.query('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM content_types')).rows[0].next);
        await db.query('INSERT INTO content_types (value, label, sort_order, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (value) DO NOTHING',
          [valid.value, valid.label, next, new Date().toISOString()]);
        type = (await db.query('SELECT value, label FROM content_types WHERE value = $1', [valid.value])).rows[0];
      }
      const ids = matching.map((row) => row.id);
      const placeholders = ids.map((_, i) => `$${i + 2}`).join(',');
      const update = await db.query(`UPDATE posts SET content_type = $1, sort_status = 'manual'
        WHERE id IN (${placeholders}) AND sort_status = 'needs_look' AND ${LIVE}`, [type.value, ...ids]);
      return { type: { value: type.value, label: type.label }, assigned: update.rowCount };
    });
    res.json(result);
    backgroundRedecide();
  }));

  app.get('/sort/backfill/estimate', route(async (req, res) => {
    res.json(await require('./sort-runner').backfillEstimate(pool, cfg));
  }));

  let backfillRunning = false;
  app.post('/sort/backfill', route(async (req, res) => {
    res.json({ started: true });
    if (backfillRunning) return;
    backfillRunning = true;
    Promise.resolve().then(async () => {
      while (true) {
        const result = await (runAutoSort || require('./sort-runner').runAutoSort)({ pool, cfg, waitForIdle: true });
        if (result.skippedCap || result.stoppedOnDescribeErrors || !(result.classified || result.errored)) break;
      }
    }).catch((error) => console.error('[Sort] backfill:', error.message))
      .finally(() => { backfillRunning = false; });
  }));

  app.get('/admin/sort-usage', route(async (req, res) => {
    res.json(await require('./sort-runner').sortUsage(pool, cfg));
  }));

  app.get('/sort/look-backfill/estimate', route(async (req, res) => {
    res.json(await require('./look-backfill').lookBackfillEstimate(pool, cfg));
  }));

  let lookBackfillRunning = false;
  app.post('/sort/look-backfill', route(async (req, res) => {
    res.json({ started: true });
    if (lookBackfillRunning) return;
    lookBackfillRunning = true;
    Promise.resolve().then(async () => {
      while (true) {
        const result = await (runLookBackfill || require('./look-backfill').runLookBackfill)({ pool, cfg });
        if (result.skippedCap || !(result.tagged || result.errored)) break;
      }
    }).catch(error => console.error('[Look] backfill:', error.message))
      .finally(() => { lookBackfillRunning = false; });
  }));

  app.get('/sort/start-fresh/preview', route(async (req, res) => {
    const count = Number((await pool.query('SELECT COUNT(*) AS count FROM posts WHERE soft_deleted = 0 OR soft_deleted IS NULL')).rows[0].count);
    res.json({ count });
  }));

  app.post('/sort/start-fresh', route(async (req, res) => {
    if (req.body?.confirm !== true) return res.status(400).json({ error: 'Confirmation required' });
    const hidden = await pool.transaction(async (db) => {
      await db.query(`INSERT INTO deletion_log (post_id, shortcode, account_handle, reason)
        SELECT id, shortcode, account_handle, 'manual:start_fresh' FROM posts
        WHERE (soft_deleted = 0 OR soft_deleted IS NULL)`);
      const updated = await db.query(`UPDATE posts SET soft_deleted = 1, soft_deleted_at = $1
        WHERE (soft_deleted = 0 OR soft_deleted IS NULL)`, [new Date().toISOString()]);
      return updated.rowCount;
    });
    res.json({ hidden });
  }));
}

module.exports = { registerSortRoutes, groupSuggestions, redecideNeedsLook };
