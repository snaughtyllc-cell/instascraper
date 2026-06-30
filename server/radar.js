const pool = require('./db');
const { median } = require('./engagement-metrics');
const { extractViews } = require('./scraper');

const GENERIC_ACTOR_ID = 'apify~instagram-scraper';

function radarConfig(env = process.env) {
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
  return {
    termsPerCycle: Math.floor(num(env.RADAR_TERMS_PER_CYCLE, 10)),
    resultsPerTerm: Math.floor(num(env.RADAR_RESULTS_PER_TERM, 50)),
    authorsEnrichMax: Math.floor(num(env.RADAR_AUTHORS_ENRICH_MAX, 20)),
    minViews: num(env.RADAR_MIN_VIEWS, 50000),
    minLikes: num(env.RADAR_MIN_LIKES, 1000),
    maxAgeDays: num(env.RADAR_MAX_AGE_DAYS, 14),
    viewFloor: num(env.RADAR_VIEW_FLOOR, 1000),
    breakoutCap: num(env.RADAR_BREAKOUT_CAP, 50),
    rollupMinBreakouts: Math.floor(num(env.RADAR_ROLLUP_MIN_BREAKOUTS, 2)),
    rollupSoloBreakout: num(env.RADAR_ROLLUP_SOLO_BREAKOUT, 10),
    wBreakout: num(env.RADAR_W_BREAKOUT, 0.7),
    wNiche: num(env.RADAR_W_NICHE, 0.3),
  };
}

function selectWatchTerms(terms, max) {
  const excluded = new Set((terms || []).filter(t => t.status === 'excluded').map(t => t.term));
  const ms = (iso) => { const t = iso ? new Date(iso).getTime() : NaN; return Number.isFinite(t) ? t : -1; };
  return (terms || [])
    .filter(t => t.status === 'active' && !excluded.has(t.term))
    .sort((a, b) => {
      const d = ms(a.last_run_at) - ms(b.last_run_at);
      if (d !== 0) return d;
      return String(a.term).localeCompare(String(b.term));
    })
    .slice(0, Math.max(0, max | 0));
}

function passesFloors(reel, cfg, nowMs = Date.now()) {
  const v = Number(reel.view_count);
  const l = Number(reel.like_count) || 0;
  if (!Number.isFinite(v) || v < cfg.minViews) return false;
  if (l < cfg.minLikes) return false;
  const t = reel.posted_at ? Date.parse(reel.posted_at) : NaN;
  if (!Number.isFinite(t)) return false;
  const ageDays = (nowMs - t) / (24 * 60 * 60 * 1000);
  return ageDays <= cfg.maxAgeDays;
}

function dedupeReels(reels, { knownShortcodes = new Set() } = {}) {
  const seen = new Set();
  const out = [];
  for (const r of reels || []) {
    if (!r.shortcode || knownShortcodes.has(r.shortcode) || seen.has(r.shortcode)) continue;
    seen.add(r.shortcode);
    out.push(r);
  }
  return out;
}

function excludeAuthors(reels, { blockedHandles = new Set() } = {}) {
  return (reels || []).filter(r => !blockedHandles.has((r.account_handle || '').toLowerCase()));
}

const round2 = (n) => Math.round(n * 100) / 100;

function scoreReel(reel, author, cfg) {
  const views = Number(reel.view_count) || 0;
  const med = author && Number(author.median_views) > 0 ? Number(author.median_views) : 0;
  const denom = med > 0 ? Math.max(med, cfg.viewFloor) : cfg.minViews;
  const breakout = Math.min(views / denom, cfg.breakoutCap);
  const overlap = Math.min(Number(reel._hashtagOverlap) || 0, 5);
  const nicheFit = 1 + 0.1 * overlap;
  const total = cfg.wBreakout * breakout + cfg.wNiche * nicheFit;
  return { breakout_score: round2(breakout), niche_fit_score: round2(nicheFit), total_score: round2(total) };
}

function normalizeHashtagItem(item, term) {
  if (!item) return null;
  const isVideo = item.type === 'Video' || item.productType === 'clips';
  if (!isVideo) return null;
  const shortcode = item.shortCode || item.shortcode;
  if (!shortcode) return null;
  const caption = item.caption || '';
  const hashtags = (caption.match(/#([a-zA-Z0-9_]+)/g) || []).map(h => h.toLowerCase());
  return {
    shortcode,
    account_handle: String(item.ownerUsername || '').toLowerCase(),
    video_url: item.videoUrl || item.url || null,
    thumbnail_url: item.displayUrl || item.thumbnailUrl || null,
    caption,
    like_count: Number(item.likesCount) || 0,
    comment_count: Number(item.commentsCount) || 0,
    view_count: extractViews(item),
    posted_at: item.timestamp || null,
    post_url: item.url || (shortcode ? `https://www.instagram.com/reel/${shortcode}/` : null),
    discovered_via: term,
    _hashtags: hashtags,
  };
}

// Apify hashtag input shape NOT yet live-verified — run the Task A5 spike (needs APIFY_API_KEY) before trusting harvest; falls back to search+searchType:'hashtag' if directUrls returns nothing.
async function harvestHashtag(scraper, term, cfg) {
  const run = await scraper._startApifyRun(GENERIC_ACTOR_ID, {
    directUrls: [`https://www.instagram.com/explore/tags/${term}/`],
    resultsType: 'posts',
    resultsLimit: cfg.resultsPerTerm,
  }, { purpose: 'radar', query: `#${term}` });
  const items = await scraper._waitForRun(run.id, 30);
  if (!items) return [];
  return items.map(it => normalizeHashtagItem(it, term)).filter(Boolean);
}

function authorMedianFromReels(views) {
  return median(views || []);
}

// One Apify "details" run per author (capped) → median of recent reel views.
async function enrichAuthors(scraper, handles, cfg) {
  const out = new Map();
  const unique = [...new Set((handles || []).filter(Boolean))].slice(0, cfg.authorsEnrichMax);
  for (const handle of unique) {
    try {
      const run = await scraper._startApifyRun(GENERIC_ACTOR_ID, {
        directUrls: [`https://www.instagram.com/${handle}/`],
        resultsType: 'details', resultsLimit: 1,
      }, { purpose: 'radar-enrich', query: handle });
      const items = await scraper._waitForRun(run.id, 12);
      const profile = items && items[0];
      if (!profile) { out.set(handle, { median_views: null, followers: 0 }); continue; }
      const followers = profile.followersCount || profile.followedByCount || 0;
      const views = (profile.latestPosts || [])
        .filter(p => p.type === 'Video' || p.productType === 'clips')
        .map(p => extractViews(p)).filter(v => Number.isFinite(v));
      out.set(handle, { median_views: authorMedianFromReels(views), followers });
    } catch (e) {
      if (e && e.name === 'BudgetExceededError') throw e;
      out.set(handle, { median_views: null, followers: 0 });
    }
  }
  return out;
}

function selectRolloupAuthors(scoredReels, cfg) {
  const byAuthor = new Map();
  for (const r of scoredReels || []) {
    const h = (r.account_handle || '').toLowerCase();
    if (!h) continue;
    const cur = byAuthor.get(h) || { username: h, count: 0, bestBreakout: 0, term: r.discovered_via };
    cur.count += 1;
    if (r.breakout_score > cur.bestBreakout) { cur.bestBreakout = r.breakout_score; cur.term = r.discovered_via; }
    byAuthor.set(h, cur);
  }
  return [...byAuthor.values()].filter(a =>
    a.count >= cfg.rollupMinBreakouts || a.bestBreakout >= cfg.rollupSoloBreakout
  ).map(a => ({
    username: a.username, bestBreakout: a.bestBreakout, count: a.count,
    source: `radar:${a.term}`,
    reason: `${a.count} breakout reel${a.count > 1 ? 's' : ''} via #${a.term} (best ${a.bestBreakout}× median)`,
  }));
}

async function rollupAuthors(pool, authors) {
  let added = 0, bumped = 0;
  for (const a of authors || []) {
    try {
      const ins = await pool.query(
        `INSERT INTO suggested_accounts (username, source, relevance_reason, suggestion_score, gender)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (username) DO NOTHING`,
        [a.username, a.source, a.reason, a.bestBreakout, 'unknown']);
      if (ins.rowCount > 0) { added++; continue; }
      const upd = await pool.query(
        `UPDATE suggested_accounts
           SET suggestion_score = CASE WHEN $1 > suggestion_score THEN $2 ELSE suggestion_score END,
               source = CASE WHEN (',' || source || ',') LIKE ('%,' || $3 || ',%') THEN source ELSE source || ',' || $4 END,
               relevance_reason = $5
         WHERE username = $6 AND status = 'pending'`,
        [a.bestBreakout, a.bestBreakout, a.source, a.source, a.reason, a.username]);
      if (upd.rowCount > 0) bumped++;
    } catch (e) { console.error(`[Radar] rollup failed for @${a.username}:`, e.message); }
  }
  return { added, bumped };
}

const radarState = { running: false, lastRun: null, message: '' };
function __setRunning(v) { radarState.running = v; }       // test hook
function getRadarStatus() { return radarState; }

async function runRadar(scraper, { env = process.env } = {}) {
  if (radarState.running) return { started: false, reason: 'already_running' };
  if (!scraper || !scraper.apiKey) return { started: false, reason: 'no_api_key' };
  radarState.running = true; radarState.lastRun = new Date().toISOString();
  const cfg = radarConfig(env);
  const now = Date.now();
  const stats = { terms: 0, harvested: 0, survivors: 0, enriched: 0, reels: 0, authors: 0, started: true };
  try {
    const termsRes = await pool.query("SELECT id, term, kind, source, status, last_run_at FROM watch_terms");
    const chosen = selectWatchTerms(termsRes.rows, cfg.termsPerCycle);
    stats.terms = chosen.length;

    // dedup context
    const known = new Set();
    for (const t of ['posts', 'radar_reels']) {
      const r = await pool.query(`SELECT shortcode FROM ${t}`);
      r.rows.forEach(x => known.add(x.shortcode));
    }
    const trackedRes = await pool.query("SELECT username FROM tracked_accounts");
    const reviewedRes = await pool.query("SELECT username FROM suggested_accounts WHERE status IN ('approved','dismissed')");
    const blocked = new Set([...trackedRes.rows, ...reviewedRes.rows].map(x => x.username.toLowerCase()));

    let allScored = [];
    for (const term of chosen) {
      let harvested = [];
      try { harvested = await harvestHashtag(scraper, term.term, cfg); }
      catch (e) { if (e.name === 'BudgetExceededError') { console.log(`[Metric] radar_budget_stop term=${term.term}`); break; }
                  console.error(`[Radar] harvest failed for #${term.term}:`, e.message); }
      stats.harvested += harvested.length;
      // stamp last_run_at best-effort
      try { await pool.query(`UPDATE watch_terms SET last_run_at = TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') WHERE id = $1`, [term.id]); } catch (e) {}

      let survivors = harvested.filter(r => passesFloors(r, cfg, now));
      survivors = excludeAuthors(dedupeReels(survivors, { knownShortcodes: known }), { blockedHandles: blocked });
      survivors.forEach(r => known.add(r.shortcode)); // avoid intra-cycle dupes across terms
      stats.survivors += survivors.length;
      if (survivors.length === 0) continue;

      const authorsMap = await enrichAuthors(scraper, survivors.map(r => r.account_handle), cfg);
      stats.enriched += authorsMap.size;
      for (const r of survivors) {
        const author = authorsMap.get(r.account_handle) || null;
        r._hashtagOverlap = (r._hashtags || []).filter(h => h !== `#${term.term}`).length;
        const s = scoreReel(r, author, cfg);
        Object.assign(r, s, {
          author_followers: author ? author.followers : null,
          author_median_views: author ? author.median_views : null,
        });
        await persistRadarReel(pool, r);
        stats.reels++;
        allScored.push(r);
      }
    }
    const rollup = selectRolloupAuthors(allScored, cfg);
    const { added, bumped } = await rollupAuthors(pool, rollup);
    stats.authors = added + bumped;
    console.log(`[Metric] radar terms=${stats.terms} harvested=${stats.harvested} survivors=${stats.survivors} reels=${stats.reels} authors=${stats.authors}`);
    radarState.message = `Reels ${stats.reels}, authors +${added}/~${bumped}`;
  } catch (err) {
    radarState.message = err.message; console.error('[Radar] run failed:', err.message);
  } finally { radarState.running = false; }
  return stats;
}

async function persistRadarReel(pool, r) {
  await pool.query(
    `INSERT INTO radar_reels (shortcode, account_handle, video_url, thumbnail_url, caption,
       like_count, comment_count, view_count, posted_at, post_url, discovered_via,
       author_followers, author_median_views, breakout_score, niche_fit_score, total_score)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (shortcode) DO NOTHING`,
    [r.shortcode, r.account_handle, r.video_url, r.thumbnail_url, r.caption,
     r.like_count, r.comment_count, r.view_count, r.posted_at, r.post_url, r.discovered_via,
     r.author_followers, r.author_median_views, r.breakout_score, r.niche_fit_score, r.total_score]);
}

module.exports = { radarConfig, selectWatchTerms, passesFloors, dedupeReels, excludeAuthors, scoreReel, normalizeHashtagItem, harvestHashtag, authorMedianFromReels, enrichAuthors, selectRolloupAuthors, rollupAuthors, runRadar, getRadarStatus, __setRunning, persistRadarReel };
