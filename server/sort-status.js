function effectiveNicheExpr(p = 'posts', ct = 'ct') {
  return `CASE WHEN ${p}.sort_status IN ('auto','manual') THEN ${p}.content_type ELSE NULL END`;
}

function decideSort({ ai, typeValues, threshold }) {
  if (typeValues.includes(ai?.type) && Number.isFinite(ai.confidence) && ai.confidence >= threshold) {
    return { sortStatus: 'auto', contentType: ai.type };
  }
  return { sortStatus: 'needs_look', contentType: null };
}

function sortConfig(env = process.env) {
  const number = (value, fallback) => {
    if (value === undefined || String(value).trim() === '') return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const count = (value, fallback) => Math.max(1, Math.floor(number(value, fallback)));
  return {
    minConfidence: Math.max(0, Math.min(1, number(env.AUTO_SORT_MIN_CONFIDENCE, 0.8))),
    batch: count(env.AUTO_SORT_BATCH, 50),
    dailyMax: count(env.AUTO_SORT_DAILY_MAX, 1000),
    maxAttempts: count(env.AUTO_SORT_MAX_ATTEMPTS, 3),
    model: env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
    priceInPerM: Math.max(0, number(env.GEMINI_PRICE_IN_PER_M, 0.30)),
    priceOutPerM: Math.max(0, number(env.GEMINI_PRICE_OUT_PER_M, 2.50)),
    enabled: !!env.GEMINI_API_KEY?.trim(),
  };
}

module.exports = { effectiveNicheExpr, decideSort, sortConfig };
