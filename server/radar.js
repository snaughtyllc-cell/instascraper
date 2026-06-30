const pool = require('./db');
const { median } = require('./engagement-metrics');

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

module.exports = { radarConfig, selectWatchTerms };
