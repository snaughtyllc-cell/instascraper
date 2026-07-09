// Notion → InstaScraper onboarding sync. Read-only. Source: Creator Personas DB.
// Pure mapping functions here; I/O boundaries (fetch, derive, seed) added in later tasks.

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

function notionConfig(env = process.env) {
  const apiKey = env.NOTION_API_KEY || '';
  const personasDbId = env.NOTION_PERSONAS_DB_ID || '';
  return {
    enabled: Boolean(apiKey && personasDbId),
    apiKey,
    personasDbId,
    seedMinReels: Math.max(0, Math.floor(num(env.NOTION_SEED_MIN_REELS, 15))),
    importGate: env.NOTION_IMPORT_GATE || 'Approved',
  };
}

const plain = (rich) => (Array.isArray(rich) ? rich.map((t) => t.plain_text || '').join('') : '');
const sel = (prop) => (prop && prop.select ? prop.select.name : null);

function normalizePersona(page) {
  const p = (page && page.properties) || {};
  return {
    pageId: page.id,
    name: plain(p['Model Name'] && p['Model Name'].title),
    personaStatement: plain(p['Persona Statement'] && p['Persona Statement'].rich_text),
    comfortCeiling: sel(p['Comfort Ceiling']),
    tensions: plain(p['Auto-Draft Tensions'] && p['Auto-Draft Tensions'].rich_text),
    personaStatus: sel(p['Persona Status']),
    status: sel(p['Status']),
  };
}

function rankNiches(aiNiches, availableNiches) {
  const avail = new Map((availableNiches || []).map((n) => [String(n).toLowerCase(), String(n)]));
  const valid = [];
  const unmatched = [];
  const seen = new Set();
  for (const raw of aiNiches || []) {
    const key = String(raw).toLowerCase();
    if (avail.has(key)) {
      const canon = avail.get(key);
      if (!seen.has(canon)) { seen.add(canon); valid.push(canon); }
    } else if (!unmatched.includes(String(raw))) {
      unmatched.push(String(raw));
    }
  }
  return { primary: valid[0] || null, secondary: valid.slice(1), unmatched };
}

function buildModelPatch(persona, confirmed) {
  return {
    name: persona.name,
    primary_niche: confirmed.primary_niche,
    secondary_niches: confirmed.secondary_niches || '',
    notion_page_id: persona.pageId,
    character_context: confirmed.character_context || '',
    persona_statement: persona.personaStatement || '',
    comfort_ceiling: persona.comfortCeiling || '',
  };
}

module.exports = { notionConfig, normalizePersona, rankNiches, buildModelPatch };
