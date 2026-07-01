const cron = require('node-cron');
const pool = require('./db');
const { BudgetExceededError, aggregateCandidates, scoreCandidate } = require('./scraper');

const ContentIdeaAgent = require('./ai-agent');
const { deliverBatch } = require('./delivery');

function cadenceConfig(env = process.env) {
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
  return {
    maxPerCycle: num(env.SCRAPE_MAX_PER_CYCLE, 10),
    activePpw: num(env.CADENCE_ACTIVE_PPW, 4),
    moderatePpw: num(env.CADENCE_MODERATE_PPW, 1),
    intervalActive: num(env.CADENCE_INTERVAL_ACTIVE, 2),
    intervalModerate: num(env.CADENCE_INTERVAL_MODERATE, 4),
    intervalQuiet: num(env.CADENCE_INTERVAL_QUIET, 8),
    freqWindowDays: Math.floor(num(env.CADENCE_FREQ_WINDOW_DAYS, 28)),
    backoffBase: num(env.CADENCE_BACKOFF_BASE, 1),
    backoffMax: num(env.CADENCE_BACKOFF_MAX, 14),
  };
}

function computeInterval(postsPerWeek, cfg = cadenceConfig()) {
  const ppw = Number(postsPerWeek) || 0;
  if (ppw >= cfg.activePpw) return cfg.intervalActive;
  if (ppw >= cfg.moderatePpw) return cfg.intervalModerate;
  return cfg.intervalQuiet;
}

function backoffDays(consecutiveFailures, cfg = cadenceConfig()) {
  const f = Number(consecutiveFailures) || 0;
  if (f <= 0) return 0;
  return Math.min(cfg.backoffBase * Math.pow(2, f - 1), cfg.backoffMax);
}

function daysSince(iso, nowMs) {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return Infinity; // malformed → very old → fail-open to due
  return (nowMs - t) / (24 * 60 * 60 * 1000);
}

function isDue(acct, nowMs, cfg = cadenceConfig()) {
  const interval = computeInterval(acct.postsPerWeek || 0, cfg);
  if (daysSince(acct.last_scraped_at, nowMs) < interval) return false;
  const cooldown = backoffDays(acct.consecutive_failures, cfg);
  if (cooldown > 0 && daysSince(acct.last_attempt_at, nowMs) < cooldown) return false;
  return true;
}

function selectDueAccounts(accounts, nowMs, cfg = cadenceConfig()) {
  return accounts
    .filter(a => isDue(a, nowMs, cfg))
    .sort((a, b) => daysSince(b.last_scraped_at, nowMs) - daysSince(a.last_scraped_at, nowMs))
    .slice(0, cfg.maxPerCycle);
}

function discoveryConfig(env = process.env) {
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
  return {
    maxSources: Math.floor(num(env.DISCOVERY_MAX_SOURCES, 5)),
    enrichMax: Math.floor(num(env.DISCOVERY_ENRICH_MAX, 8)),
    minReelShare: num(env.DISCOVERY_MIN_REEL_SHARE, 0.60),
  };
}

// Reels-tool qualifier: keep only accounts primarily posting reels. Pure — unit-tested.
// Unknown share (null/undefined/non-finite) is PARKED (kept), mirroring unknown gender —
// we never guess-drop a candidate we couldn't measure.
function qualifiesByReelShare(reelShare, minReelShare) {
  if (typeof reelShare !== 'number' || !Number.isFinite(reelShare)) return true;
  return reelShare >= minReelShare;
}

// Rotation: least-recently-discovered first (never-discovered = highest priority),
// deterministic tie-break by username, capped at `max`. Pure — unit-tested.
function selectDiscoverySources(accounts, max) {
  // never-discovered / malformed → -1 sentinel (sorts before any real epoch-ms timestamp,
  // and -1 - -1 = 0 so the username tie-break still fires; -Infinity would yield NaN here).
  const ms = (iso) => { const t = iso ? new Date(iso).getTime() : NaN; return Number.isFinite(t) ? t : -1; };
  return (accounts || [])
    .slice()
    .sort((a, b) => {
      const d = ms(a.last_discovery_at) - ms(b.last_discovery_at);
      if (d !== 0) return d;
      return String(a.username).localeCompare(String(b.username));
    })
    .slice(0, Math.max(0, max | 0));
}

function buildCadenceAccounts(accountRows, freqRows, cfg = cadenceConfig()) {
  const weeks = (cfg.freqWindowDays || 28) / 7;
  const freq = new Map((freqRows || []).map(r => [r.username, Number(r.recent_post_count) || 0]));
  return (accountRows || []).map(a => ({
    username: a.username,
    last_scraped_at: a.last_scraped_at || null,
    last_attempt_at: a.last_attempt_at || null,
    consecutive_failures: Number(a.consecutive_failures) || 0,
    postsPerWeek: weeks > 0 ? (freq.get(a.username) || 0) / weeks : 0,
  }));
}

let scraperInstance = null;
const jobStatus = {
  autoScrape: { lastRun: null, nextRun: null, status: 'idle', message: '' },
  rollup: { lastRun: null, nextRun: null, status: 'idle', message: '' },
  cleanup: { lastRun: null, nextRun: null, status: 'idle', message: '' },
  discovery: { lastRun: null, nextRun: null, status: 'idle', message: '' },
  ideaGeneration: { lastRun: null, nextRun: null, status: 'idle', message: '' },
};

async function runAutoScrape() {
  jobStatus.autoScrape.status = 'running';
  jobStatus.autoScrape.lastRun = new Date().toISOString();
  console.log('[Scheduler] Auto-scrape starting...');
  try {
    const cfg = cadenceConfig();
    const accountsRes = await pool.query("SELECT username, last_scraped_at, last_attempt_at, consecutive_failures FROM tracked_accounts WHERE status = 'active'");
    if (accountsRes.rows.length === 0) { jobStatus.autoScrape.message = 'No active accounts'; jobStatus.autoScrape.status = 'idle'; return; }

    // posts.account_handle is raw-case (from the scraped owner username); tracked_accounts.username
    // is canonically lowercased — fold to lowercase so the frequency join matches.
    const freqRes = await pool.query(
      `SELECT LOWER(account_handle) AS username, COUNT(*) AS recent_post_count FROM posts
       WHERE posted_at >= TO_CHAR(NOW() - INTERVAL '${cfg.freqWindowDays} days', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
         AND (soft_deleted = 0 OR soft_deleted IS NULL)
       GROUP BY LOWER(account_handle)`
    );

    const now = Date.now();
    const accounts = buildCadenceAccounts(accountsRes.rows, freqRes.rows, cfg);
    const due = selectDueAccounts(accounts, now, cfg);
    const totalDue = accounts.filter(a => isDue(a, now, cfg)).length;
    const capped = Math.max(0, totalDue - due.length);
    const backedOff = accounts.filter(a => !isDue(a, now, cfg) && daysSince(a.last_scraped_at, now) >= computeInterval(a.postsPerWeek, cfg)).length;

    let scraped = 0;
    for (const account of due) {
      try {
        await pool.query(`UPDATE tracked_accounts SET last_attempt_at = TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') WHERE username = $1`, [account.username]);
        await scraperInstance.startScrapeJob({ query: account.username, queryType: 'username', minLikes: null, minViews: null, startDate: null, endDate: null, source: 'auto' });
        scraped++;
        if (scraped < due.length) await new Promise(r => setTimeout(r, 30000));
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          console.log(`[Metric] auto_scrape_budget_stop scraped=${scraped} due=${due.length} msg="${err.message}"`);
          jobStatus.autoScrape.message = `Stopped at ${scraped}/${due.length} due — ${err.message}`;
          jobStatus.autoScrape.status = 'idle';
          return;
        }
        console.error(`[Scheduler] Failed to scrape @${account.username}:`, err.message);
      }
    }
    console.log(`[Metric] cadence due=${due.length} scraped=${scraped} capped=${capped} backed_off=${backedOff}`);
    jobStatus.autoScrape.message = `Scraped ${scraped} of ${due.length} due (cap ${cfg.maxPerCycle}), ${capped} capped, ${backedOff} backed off`;
    jobStatus.autoScrape.status = 'idle';
  } catch (err) { jobStatus.autoScrape.status = 'error'; jobStatus.autoScrape.message = err.message; }
}

async function runEngagementRollup() {
  jobStatus.rollup.status = 'running';
  jobStatus.rollup.lastRun = new Date().toISOString();
  try {
    const result = await pool.query("SELECT username FROM tracked_accounts WHERE status = 'active'");
    const now = new Date();
    const dayOfWeek = now.getDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const weekStart = new Date(now); weekStart.setDate(now.getDate() + mondayOffset); weekStart.setHours(0,0,0,0);
    const weekEnd = new Date(weekStart); weekEnd.setDate(weekStart.getDate() + 6); weekEnd.setHours(23,59,59,999);
    const weekStartStr = weekStart.toISOString().split('T')[0];
    const weekEndStr = weekEnd.toISOString().split('T')[0];
    let count = 0;
    for (const account of result.rows) {
      const stats = await pool.query(`SELECT COUNT(*) as post_count, ROUND(AVG(er_percent)::numeric, 2) as avg_er, MAX(er_percent) as max_er, SUM(like_count) as total_likes, SUM(comment_count) as total_comments, SUM(view_count) as total_views, MAX(followers_at_scrape) as followers FROM posts WHERE account_handle = $1 AND posted_at >= $2 AND posted_at <= $3 AND (soft_deleted = 0 OR soft_deleted IS NULL)`, [account.username, weekStartStr, weekEndStr + 'T23:59:59']);
      const s = stats.rows[0];
      if (s && parseInt(s.post_count) > 0) {
        await pool.query(`INSERT INTO engagement_rollups (username, week_start, week_end, post_count, avg_er, max_er, total_likes, total_comments, total_views, followers_snapshot) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (username, week_start) DO UPDATE SET post_count=$4, avg_er=$5, max_er=$6, total_likes=$7, total_comments=$8, total_views=$9, followers_snapshot=$10, computed_at=TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`, [account.username, weekStartStr, weekEndStr, s.post_count, s.avg_er||0, s.max_er||0, s.total_likes||0, s.total_comments||0, s.total_views||0, s.followers||0]);
        count++;
      }
      const overallEr = await pool.query(`SELECT ROUND(AVG(er_percent)::numeric, 2) as avg_er FROM posts WHERE account_handle = $1 AND (soft_deleted = 0 OR soft_deleted IS NULL)`, [account.username]);
      if (overallEr.rows[0]) await pool.query(`UPDATE tracked_accounts SET avg_er = $1, updated_at = TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') WHERE username = $2`, [overallEr.rows[0].avg_er || 0, account.username]);
    }
    jobStatus.rollup.message = `Rolled up ${count} accounts for week ${weekStartStr}`;
    jobStatus.rollup.status = 'idle';
  } catch (err) { jobStatus.rollup.status = 'error'; jobStatus.rollup.message = err.message; }
}

async function runAutoCleanup() {
  jobStatus.cleanup.status = 'running';
  jobStatus.cleanup.lastRun = new Date().toISOString();
  try {
    const activeResult = await pool.query("SELECT username FROM tracked_accounts WHERE status = 'active'");
    const activeHandles = activeResult.rows.map(a => a.username);
    let notInClause = '';
    const params = [];
    if (activeHandles.length > 0) {
      const placeholders = activeHandles.map((_, i) => `$${i + 1}`).join(',');
      notInClause = `AND account_handle NOT IN (${placeholders})`;
      params.push(...activeHandles);
    }
    const candidates = await pool.query(`SELECT id, shortcode, account_handle FROM posts WHERE tag IS NULL AND (soft_deleted = 0 OR soft_deleted IS NULL) AND scraped_at < TO_CHAR(NOW() - INTERVAL '30 days', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') ${notInClause}`, params);
    if (candidates.rows.length === 0) { jobStatus.cleanup.message = 'No posts to clean up'; jobStatus.cleanup.status = 'idle'; return; }
    for (const post of candidates.rows) {
      await pool.query(`UPDATE posts SET soft_deleted = 1, soft_deleted_at = TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') WHERE id = $1`, [post.id]);
      await pool.query(`INSERT INTO deletion_log (post_id, shortcode, account_handle, reason) VALUES ($1, $2, $3, 'auto:unreferenced_30d')`, [post.id, post.shortcode, post.account_handle]);
    }
    jobStatus.cleanup.message = `Soft-deleted ${candidates.rows.length} unreferenced posts`;
    jobStatus.cleanup.status = 'idle';
  } catch (err) { jobStatus.cleanup.status = 'error'; jobStatus.cleanup.message = err.message; }
}

async function runDiscovery() {
  jobStatus.discovery.status = 'running';
  jobStatus.discovery.lastRun = new Date().toISOString();
  console.log('[Scheduler] Discovery starting...');
  try {
    if (!scraperInstance || !scraperInstance.apiKey) { jobStatus.discovery.message = 'No Apify API key'; jobStatus.discovery.status = 'idle'; return; }
    const dcfg = discoveryConfig();
    const trackedResult = await pool.query("SELECT username, last_discovery_at FROM tracked_accounts WHERE status = 'active'");
    const suggestedResult = await pool.query("SELECT username FROM suggested_accounts");
    const trackedSet = new Set(trackedResult.rows.map(a => a.username));
    const suggestedSet = new Set(suggestedResult.rows.map(a => a.username));

    // Reach: rotate through all active accounts (least-recently-discovered first), capped per cycle.
    const sources = selectDiscoverySources(trackedResult.rows, dcfg.maxSources);
    let raw = [];
    for (const account of sources) {
      try {
        // Harvest only — enrich once, globally, after dedup (cheaper than per-source).
        const related = await scraperInstance.discoverRelated(account.username, { enrich: false });
        for (const profile of related) {
          // Skip already-tracked; let already-suggested through for cross-cycle accumulation.
          if (!trackedSet.has(profile.username)) {
            raw.push({ ...profile, sourceAccount: profile.sourceAccount || account.username });
          }
        }
      } catch (err) { console.error(`[Discovery] Failed for @${account.username}:`, err.message); }
      // Advance the rotation cursor best-effort even on failure, so a bad source can't wedge the queue.
      try { await pool.query(`UPDATE tracked_accounts SET last_discovery_at = TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') WHERE username = $1`, [account.username]); } catch (e) {}
      await new Promise(r => setTimeout(r, 10000));
    }

    // Cross-source dedup (collabStrength = distinct sources this cycle).
    const aggregated = aggregateCandidates(raw);
    aggregated.sort((a, b) => (b.collabStrength || 0) - (a.collabStrength || 0));

    // Cheaper enrichment: enrich only NEW candidates once (already-suggested keep stored data),
    // globally capped — replaces the old per-source 4-each enrichment.
    const freshCandidates = aggregated.filter(c => !suggestedSet.has(c.username));
    await scraperInstance.enrichCandidates(freshCandidates, { apifyMax: dcfg.enrichMax, dbMax: freshCandidates.length });

    // Gender-classify the new candidates once; drop males (already-suggested keep stored gender).
    const fresh = freshCandidates.filter(c => (c.followers || 0) <= 500000);
    const verdicts = await scraperInstance._classifyGenderBatch(
      fresh.map(c => ({ username: c.username, bio: c.bio || '', captionSnippet: c.captionSnippet, taggedBy: c.sourceAccount }))
    );
    let female = 0;
    const freshKept = [];
    for (const c of fresh) {
      const gender = verdicts[c.username.toLowerCase()] || 'unknown';
      if (gender === 'male') { console.log(`[Discovery] Filtered out @${c.username} (male)`); continue; }
      // Reels tool: hard-drop accounts that aren't primarily reels. Unknown share is parked
      // (kept) like unknown gender — c.reelShare is a finite number only when qualification fails.
      if (!qualifiesByReelShare(c.reelShare, dcfg.minReelShare)) {
        console.log(`[Discovery] Filtered out @${c.username} (reel_share ${Math.round(c.reelShare * 100)}%)`);
        continue;
      }
      c.gender = gender;
      if (gender === 'female') female++;
      freshKept.push(c);
    }

    const repeats = aggregated.filter(c => suggestedSet.has(c.username) && !trackedSet.has(c.username));

    let added = 0, bumped = 0;
    for (const item of freshKept.slice(0, 50)) {
      const totalScore = scoreCandidate({ collabStrength: item.collabStrength, avgEr: item.avgEr, postsPerWeek: item.postsPerWeek });
      try {
        const ins = await pool.query(
          `INSERT INTO suggested_accounts (username, source, followers, avg_er, posts_per_week, bio, content_breakdown, top_hashtags, relevance_reason, suggestion_score, gender, reel_share)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (username) DO NOTHING`,
          [item.username, item.source || 'discovery', item.followers || 0, item.avgEr || 0, item.postsPerWeek || 0,
           item.bio || '', item.contentBreakdown || '', item.topHashtags || '', item.relevanceReason || '', totalScore, item.gender || 'unknown', item.reelShare ?? null]
        );
        if (ins.rowCount > 0) added++;
      } catch (e) { console.error(`[Discovery] insert failed for @${item.username}:`, e.message); }
    }

    // Accumulate onto still-pending suggestions re-surfaced by a new source this cycle:
    // merge the source token, bump score (monotonic — never demotes), refresh the reason.
    for (const item of repeats) {
      const totalScore = scoreCandidate({ collabStrength: item.collabStrength, avgEr: item.avgEr, postsPerWeek: item.postsPerWeek });
      const token = item.sourceAccount || item.source || 'discovery';
      try {
        // Placeholders must appear once, in ascending textual order: the dual-mode
        // shim strips $n → ? positionally, so duplicated/out-of-order $n break sqlite.
        const upd = await pool.query(
          `UPDATE suggested_accounts
             SET suggestion_score = CASE WHEN $1 > suggestion_score THEN $2 ELSE suggestion_score END,
                 source = CASE WHEN (',' || source || ',') LIKE ('%,' || $3 || ',%') THEN source ELSE source || ',' || $4 END,
                 relevance_reason = $5
           WHERE username = $6 AND status = 'pending'`,
          [totalScore, totalScore, token, token, item.relevanceReason || '', item.username]
        );
        if (upd.rowCount > 0) bumped++;
      } catch (e) { console.error(`[Discovery] accumulate failed for @${item.username}:`, e.message); }
    }

    console.log(`[Metric] discovery sources=${sources.length} candidates=${aggregated.length} enriched=${freshCandidates.length} female=${female} added=${added} bumped=${bumped}`);
    jobStatus.discovery.message = `Sources ${sources.length}, ${aggregated.length} candidates — added ${added}, bumped ${bumped}`;
    jobStatus.discovery.status = 'idle';
    console.log(`[Scheduler] Discovery done: ${added} new, ${bumped} bumped`);
  } catch (err) { jobStatus.discovery.status = 'error'; jobStatus.discovery.message = err.message; }
}

async function runIdeaGeneration() {
  jobStatus.ideaGeneration.status = 'running';
  jobStatus.ideaGeneration.lastRun = new Date().toISOString();
  console.log('[Scheduler] Idea generation starting...');
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) { jobStatus.ideaGeneration.message = 'No ANTHROPIC_API_KEY'; jobStatus.ideaGeneration.status = 'idle'; return; }
    const agent = new ContentIdeaAgent(apiKey);
    const dayName = new Date().toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
    const models = await pool.query("SELECT * FROM models WHERE status = 'active' AND LOWER(delivery_day) = $1", [dayName]);
    if (models.rows.length === 0) { jobStatus.ideaGeneration.message = `No models scheduled for ${dayName}`; jobStatus.ideaGeneration.status = 'idle'; return; }
    let generated = 0;
    let delivered = 0;
    for (const model of models.rows) {
      try {
        const result = await agent.generateIdeasForModel(model.id);
        generated++;
        if (result.batchId && result.ideaCount > 0 && model.delivery_contact) {
          try {
            await deliverBatch(model.id, result.batchId);
            delivered++;
          } catch (delErr) { console.error(`[Scheduler] Delivery failed for ${model.name}:`, delErr.message); }
        }
      } catch (err) { console.error(`[Scheduler] Idea gen failed for ${model.name}:`, err.message); }
    }
    jobStatus.ideaGeneration.message = `Generated for ${generated}/${models.rows.length} models, delivered ${delivered}`;
    jobStatus.ideaGeneration.status = 'idle';
    console.log(`[Scheduler] Idea generation done: ${generated} generated, ${delivered} delivered`);
  } catch (err) { jobStatus.ideaGeneration.status = 'error'; jobStatus.ideaGeneration.message = err.message; }
}

async function runThumbnailSweep() {
  const { sweepThumbnails } = require('./thumbnails');
  jobStatus.thumbnailSweep = jobStatus.thumbnailSweep || {};
  jobStatus.thumbnailSweep.status = 'running';
  try {
    const t = await sweepThumbnails({ maxAgeDays: 14, batchLimit: 200 });
    jobStatus.thumbnailSweep.message = `Swept: ${t.cached} cached, ${t.expired} expired, ${t.errored} errored`;
  } catch (err) {
    jobStatus.thumbnailSweep.message = `Failed: ${err.message}`;
  }
  jobStatus.thumbnailSweep.status = 'idle';
}

function startScheduler(scraper) {
  scraperInstance = scraper;
  cron.schedule('0 3 * * *', () => runAutoScrape()); // daily; cadence interval + per-cycle cap control actual spend
  cron.schedule('0 0 * * 0', () => runEngagementRollup());
  cron.schedule('0 2 * * *', () => runAutoCleanup());
  cron.schedule('0 4 * * 1', () => runDiscovery());
  cron.schedule('0 8 * * *', () => runIdeaGeneration()); // Daily 8am, checks delivery_day
  cron.schedule('0 5 * * *', () => runThumbnailSweep());
  console.log('[Scheduler] All cron jobs registered');
}

function getSchedulerStatus() { return jobStatus; }

module.exports = { startScheduler, getSchedulerStatus, runAutoScrape, runEngagementRollup, runAutoCleanup, runDiscovery, runIdeaGeneration, runThumbnailSweep, cadenceConfig, computeInterval, backoffDays, daysSince, isDue, selectDueAccounts, buildCadenceAccounts, discoveryConfig, selectDiscoverySources, qualifiesByReelShare };
