const cron = require('node-cron');
const pool = require('./db');

const ContentIdeaAgent = require('./ai-agent');
const { deliverBatch } = require('./delivery');

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
    const result = await pool.query("SELECT username FROM tracked_accounts WHERE status = 'active'");
    if (result.rows.length === 0) { jobStatus.autoScrape.message = 'No active accounts'; jobStatus.autoScrape.status = 'idle'; return; }
    let scraped = 0;
    for (const account of result.rows) {
      try {
        await scraperInstance.startScrapeJob({ query: account.username, queryType: 'username', minLikes: null, minViews: null, startDate: null, endDate: null, source: 'auto' });
        scraped++;
        if (scraped < result.rows.length) await new Promise(r => setTimeout(r, 30000));
      } catch (err) { console.error(`[Scheduler] Failed to scrape @${account.username}:`, err.message); }
    }
    jobStatus.autoScrape.message = `Scraped ${scraped}/${result.rows.length} accounts`;
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
    const trackedResult = await pool.query("SELECT username FROM tracked_accounts WHERE status = 'active'");
    const suggestedResult = await pool.query("SELECT username FROM suggested_accounts");
    const existing = new Set([...trackedResult.rows.map(a => a.username), ...suggestedResult.rows.map(a => a.username)]);
    let candidates = [];
    for (const account of trackedResult.rows.slice(0, 5)) {
      try {
        const related = await scraperInstance.discoverRelated(account.username);
        for (const profile of related) { if (!existing.has(profile.username)) { existing.add(profile.username); candidates.push(profile); } }
      } catch (err) { console.error(`[Discovery] Failed for @${account.username}:`, err.message); }
      await new Promise(r => setTimeout(r, 10000));
    }
    console.log(`[Scheduler] Discovery found ${candidates.length} total candidates`);
    let added = 0;
    for (const item of candidates.slice(0, 30)) {
      const relevancePts = Math.min(((item.relevanceScore || 25) / 40) * 50, 50);
      const erPts = Math.min((item.avgEr || 0) / 6, 1) * 30;
      const freqPts = Math.min((item.postsPerWeek || 0) / 5, 1) * 20;
      const totalScore = Math.round(relevancePts + erPts + freqPts);
      try {
        await pool.query(`INSERT INTO suggested_accounts (username, source, followers, avg_er, posts_per_week, bio, content_breakdown, top_hashtags, relevance_reason, suggestion_score) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (username) DO NOTHING`, [item.username, item.source || 'discovery', item.followers || 0, item.avgEr || 0, item.postsPerWeek || 0, item.bio || '', item.contentBreakdown || '', item.topHashtags || '', item.relevanceReason || '', totalScore]);
        added++;
      } catch (e) { /* skip */ }
    }
    jobStatus.discovery.message = `Found ${candidates.length} candidates, added ${added}`;
    jobStatus.discovery.status = 'idle';
    console.log(`[Scheduler] Discovery done: ${added} new suggestions`);
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

function startScheduler(scraper) {
  scraperInstance = scraper;
  cron.schedule('0 3 */3 * *', () => runAutoScrape());
  cron.schedule('0 0 * * 0', () => runEngagementRollup());
  cron.schedule('0 2 * * *', () => runAutoCleanup());
  cron.schedule('0 4 * * 1', () => runDiscovery());
  cron.schedule('0 8 * * *', () => runIdeaGeneration()); // Daily 8am, checks delivery_day
  console.log('[Scheduler] All cron jobs registered');
}

function getSchedulerStatus() { return jobStatus; }

module.exports = { startScheduler, getSchedulerStatus, runAutoScrape, runEngagementRollup, runAutoCleanup, runDiscovery, runIdeaGeneration };
