const pool = require('./db');

const DEFAULT_ACTOR_ID = 'data-slayer~instagram-search-reels';

function radarConfig(env = process.env) {
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
  return {
    termsPerCycle: Math.floor(num(env.RADAR_TERMS_PER_CYCLE, 10)),
    maxPages: Math.floor(num(env.RADAR_MAX_PAGES, 1)),
    authorsMax: Math.floor(num(env.RADAR_AUTHORS_MAX, 30)),
    minViews: num(env.RADAR_MIN_VIEWS, 20000),
    maxAgeDays: num(env.RADAR_MAX_AGE_DAYS, 30),
    actorId: env.RADAR_ACTOR_ID || DEFAULT_ACTOR_ID,
  };
}

// PURE. Map a data-slayer/instagram-search-reels item to our author-centric shape.
// Returns null when the item lacks a shortcode or a creator handle (caller filters).
function normalizeSearchReel(item, term) {
  if (!item) return null;
  const shortcode = item.code;
  const ownerUsername = item.user && item.user.username;
  if (!shortcode || !ownerUsername) return null;
  // views: null (unknown) stays null — never coerce to a fake 0.
  let viewCount = null;
  if (item.ig_play_count != null) {
    const v = Number(item.ig_play_count);
    viewCount = Number.isFinite(v) ? v : null;
  }
  // taken_at_date tolerates an ISO string OR epoch-seconds number OR null.
  let postedAt = null;
  const ta = item.taken_at_date;
  if (typeof ta === 'number' && Number.isFinite(ta)) {
    postedAt = new Date(ta * 1000).toISOString();
  } else if (typeof ta === 'string' && ta) {
    const t = Date.parse(ta);
    postedAt = Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  return {
    shortcode,
    ownerUsername: String(ownerUsername),
    viewCount,
    likeCount: Number(item.like_count) || 0,
    commentCount: Number(item.comment_count) || 0,
    caption: (item.caption && item.caption.text) || '',
    postedAt,
    permalink: `https://www.instagram.com/reel/${shortcode}/`,
    term,
  };
}

// PURE. Min-views floor + age window; future-dated reels are rejected.
function passesFloors(reel, cfg, nowMs = Date.now()) {
  const v = Number(reel.viewCount);
  if (!Number.isFinite(v) || v < cfg.minViews) return false;
  const t = reel.postedAt ? Date.parse(reel.postedAt) : NaN;
  if (!Number.isFinite(t)) return false;
  const ageDays = (nowMs - t) / (24 * 60 * 60 * 1000);
  return ageDays >= 0 && ageDays <= cfg.maxAgeDays;
}

// PURE. Active terms, oldest-run first (never-run first), excluded twin suppressed, capped.
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

// PURE. Drop falsy/known/repeat shortcodes (order-preserving).
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

// PURE. Drop reels whose author (lowercased) is blocked.
function excludeAuthors(reels, { blockedHandles = new Set() } = {}) {
  return (reels || []).filter(r => !blockedHandles.has(String(r.ownerUsername || '').toLowerCase()));
}

// PURE. Collapse surviving reels to distinct authors; the highest-view reel
// wins the term + reason. Sort by best views desc, then username; cap authorsMax.
function selectRollupAuthors(reels, cfg) {
  const byAuthor = new Map();
  for (const r of reels || []) {
    const u = r.ownerUsername;
    if (!u) continue;
    const key = u.toLowerCase();
    const views = Number(r.viewCount) || 0;
    const cur = byAuthor.get(key);
    if (!cur) {
      byAuthor.set(key, { username: u, term: r.term, bestViews: views });
    } else if (views > cur.bestViews) {
      cur.bestViews = views;
      cur.term = r.term;
    }
  }
  return [...byAuthor.values()]
    .sort((a, b) => (b.bestViews - a.bestViews) || String(a.username).localeCompare(String(b.username)))
    .slice(0, Math.max(0, cfg.authorsMax | 0))
    .map(a => ({
      username: a.username,
      term: a.term,
      source: `radar:${a.term}`,
      reason: `found via '${a.term}' — ${a.bestViews.toLocaleString('en-US')} view reel`,
    }));
}

module.exports = { radarConfig, normalizeSearchReel, passesFloors, selectWatchTerms, dedupeReels, excludeAuthors, selectRollupAuthors };
