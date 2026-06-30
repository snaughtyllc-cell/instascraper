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

module.exports = { radarConfig, selectWatchTerms, passesFloors, dedupeReels, excludeAuthors, scoreReel, normalizeHashtagItem, harvestHashtag, authorMedianFromReels, enrichAuthors };
