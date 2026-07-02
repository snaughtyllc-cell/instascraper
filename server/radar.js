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

module.exports = { radarConfig, normalizeSearchReel, passesFloors };
