function transcriptWords(text) {
  if (typeof text !== 'string') return [];
  return text.toLowerCase().replace(/[^\p{L}\s]/gu, '').trim().split(/\s+/u).filter(Boolean);
}

function transcriptShingles(text, n = 5) {
  if (!Number.isInteger(n) || n < 1) return new Set();
  const words = transcriptWords(text);
  const shingles = new Set();
  for (let i = 0; i <= words.length - n; i++) shingles.add(words.slice(i, i + n).join(' '));
  return shingles;
}

function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const value of a) if (b.has(value)) shared++;
  return shared / Math.min(a.size, b.size);
}

function confidenceSetting(value, fallback) {
  if (value === undefined || String(value).trim() === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
}

function findRepeatedAudio(rows, { minOverlap = confidenceSetting(process.env.LIPSYNC_REPEAT_MIN, 0.6) } = {}) {
  const candidates = rows.filter(row => transcriptWords(row.ai_transcript).length >= 12)
    .map(row => ({ id: row.id, shingles: transcriptShingles(row.ai_transcript) }));
  const matches = new Map();
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i];
      const b = candidates[j];
      if (a.id === b.id) continue;
      const score = overlap(a.shingles, b.shingles);
      if (score < minOverlap) continue;
      if (!matches.has(a.id) || score > matches.get(a.id).score) matches.set(a.id, { matchId: b.id, score });
      if (!matches.has(b.id) || score > matches.get(b.id).score) matches.set(b.id, { matchId: a.id, score });
    }
  }
  return matches;
}

function decideTalkingVsLipSync({ detector, repeated, audioKind, sortStatus,
  minConfidence = confidenceSetting(process.env.LIPSYNC_MIN_CONFIDENCE, 0.7) } = {}) {
  if (sortStatus === 'manual') return null;
  // The first sort's audio kind can be fooled by reuploaded audio. Only the
  // dedicated detector and repeated words settle this second decision.
  const confident = Number.isFinite(detector?.confidence) && detector.confidence >= minConfidence;
  if (confident && detector.verdict === 'live_speech') {
    if (!repeated) return { sortStatus: 'auto', contentType: 'talking' };
  } else if (repeated || (confident && detector.verdict === 'lip_sync')) {
    return { sortStatus: 'auto', contentType: 'lipsync' };
  }
  return { sortStatus: 'needs_look', contentType: null, suggestedType: 'lipsync' };
}

module.exports = { transcriptShingles, overlap, findRepeatedAudio, decideTalkingVsLipSync };
