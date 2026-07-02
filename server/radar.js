const pool = require('./db');
const { isErrorStubResponse } = require('./scraper');

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

// Apify glue: run the keyword-search actor for one term. Returns raw items.
async function harvestKeyword(scraper, term, cfg) {
  const run = await scraper._startApifyRun(
    cfg.actorId,
    { query: term, maxPages: cfg.maxPages },
    { purpose: 'radar', query: term }
  );
  const items = await scraper._waitForRun(run.id, 20); // ~60s cap; keyword search is fast
  return items || [];
}

const radarState = { running: false, lastRun: null, message: '' };
function __setRunning(v) { radarState.running = v; }   // test hook
function getRadarStatus() { return radarState; }

// Orchestrator (mirrors runDiscovery): keyword → harvest → normalize → floors/dedupe/
// exclude → distinct authors → gender-drop-males → INSERT suggested_accounts →
// captureTopReels (budget-guarded). Emits one [Metric] line.
async function runRadar(scraper, { env = process.env } = {}) {
  if (radarState.running) return { started: false, reason: 'already_running' };
  if (!scraper || !scraper.apiKey) return { started: false, reason: 'no_api_key' };
  radarState.running = true;
  radarState.lastRun = new Date().toISOString();
  const cfg = radarConfig(env);
  const now = Date.now();
  const stats = { started: true, terms: 0, authors: 0, added: 0, reels: 0 };
  try {
    const termsRes = await pool.query('SELECT id, term, kind, source, status, last_run_at FROM watch_terms');
    const chosen = selectWatchTerms(termsRes.rows, cfg.termsPerCycle);
    stats.terms = chosen.length;

    // Skip authors already tracked or already suggested (any status).
    const trackedRes = await pool.query('SELECT username FROM tracked_accounts');
    const suggestedRes = await pool.query('SELECT username FROM suggested_accounts');
    const blocked = new Set(
      [...trackedRes.rows, ...suggestedRes.rows].map(x => String(x.username).toLowerCase())
    );

    const known = new Set();   // intra-cycle shortcode dedupe
    const surviving = [];
    for (const term of chosen) {
      let raw = [];
      try {
        raw = await harvestKeyword(scraper, term.term, cfg);
      } catch (e) {
        if (e && e.name === 'BudgetExceededError') { console.log(`[Metric] radar_budget_stop term=${term.term}`); break; }
        console.error(`[Radar] harvest failed for '${term.term}':`, e.message);
      }
      // Stamp last_run_at best-effort (dual-mode NOW()).
      try {
        await pool.query(`UPDATE watch_terms SET last_run_at = TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') WHERE id = $1`, [term.id]);
      } catch (e) {}
      // Third-party actor safety: an all-error-stub response means IG blocked us — skip.
      if (isErrorStubResponse(raw)) { console.log(`[Radar] '${term.term}' harvest was all error-stubs — skipped`); continue; }

      let reels = raw.map(it => normalizeSearchReel(it, term.term)).filter(Boolean);
      reels = reels.filter(r => passesFloors(r, cfg, now));
      reels = dedupeReels(reels, { knownShortcodes: known });
      reels = excludeAuthors(reels, { blockedHandles: blocked });
      reels.forEach(r => known.add(r.shortcode));
      surviving.push(...reels);
    }

    const authors = selectRollupAuthors(surviving, cfg); // distinct, capped authorsMax

    // Gender-classify once; drop males (mirror discovery). On failure: treat all as unknown.
    let verdicts = {};
    try {
      verdicts = await scraper._classifyGenderBatch(
        authors.map(a => ({ username: a.username, bio: '', captionSnippet: '', taggedBy: a.source }))
      ) || {};
    } catch (e) { console.error('[Radar] gender classify failed:', e.message); verdicts = {}; }
    const kept = [];
    for (const a of authors) {
      const gender = verdicts[a.username.toLowerCase()] || 'unknown';
      if (gender === 'male') { console.log(`[Radar] Filtered out @${a.username} (male)`); continue; }
      a.gender = gender;
      kept.push(a);
    }
    stats.authors = kept.length;

    let budgetStop = false;
    for (const a of kept) {
      try {
        const ins = await pool.query(
          `INSERT INTO suggested_accounts (username, source, relevance_reason, gender)
           VALUES ($1,$2,$3,$4) ON CONFLICT (username) DO NOTHING`,
          [a.username, a.source, a.reason, a.gender || 'unknown']
        );
        if (ins.rowCount > 0) {
          stats.added++;
          if (!budgetStop) {
            try {
              await scraper.captureTopReels(a.username); // sets suggestion_score + reel previews
              stats.reels++;
            } catch (e) {
              if (e && e.name === 'BudgetExceededError') { budgetStop = true; console.log(`[Radar] reel capture stopped at budget (captured ${stats.reels})`); }
              else console.error(`[Radar] reel capture failed for @${a.username}:`, e.message);
            }
          }
        }
      } catch (e) { console.error(`[Radar] insert failed for @${a.username}:`, e.message); }
    }

    console.log(`[Metric] radar terms=${stats.terms} authors=${stats.authors} added=${stats.added} reels=${stats.reels}`);
    radarState.message = `Terms ${stats.terms}, authors +${stats.added}, reels ${stats.reels}`;
  } catch (err) {
    radarState.message = err.message;
    console.error('[Radar] run failed:', err.message);
  } finally {
    radarState.running = false;
  }
  return stats;
}

module.exports = { radarConfig, normalizeSearchReel, passesFloors, selectWatchTerms, dedupeReels, excludeAuthors, selectRollupAuthors, harvestKeyword, runRadar, getRadarStatus, __setRunning };
