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

async function fetchApprovedPersonas(client, cfg) {
  const out = [];
  let cursor;
  do {
    const res = await client.databases.query({
      database_id: cfg.personasDbId,
      filter: { property: 'Persona Status', select: { equals: cfg.importGate } },
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    for (const page of res.results || []) out.push(normalizePersona(page));
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  return out;
}

async function fetchPersonaById(client, pageId) {
  const page = await client.pages.retrieve({ page_id: pageId });
  return normalizePersona(page);
}

const DERIVE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['proposedPrimary', 'proposedSecondary', 'characterContext', 'seedKeywords'],
  properties: {
    proposedPrimary: { type: 'string' },
    proposedSecondary: { type: 'array', items: { type: 'string' } },
    characterContext: { type: 'string' },
    seedKeywords: { type: 'array', items: { type: 'string' } },
  },
};

async function deriveProfile(persona, availableNiches, claude) {
  if (!claude) throw new Error('ANTHROPIC_API_KEY not configured — cannot derive persona profile');
  const nicheList = (availableNiches || []).join(', ');
  const system = `You map an OnlyFans/Instagram creator persona onto a fixed content-niche taxonomy and write a tight creative brief. Choose niches ONLY from the provided list. Be specific and grounded in the persona; never invent niches outside the list.`;
  const userPrompt = `Available niches (choose ONLY from these exact values): ${nicheList}

Persona: ${persona.name}
Persona statement: ${persona.personaStatement || '(none)'}
Comfort ceiling: ${persona.comfortCeiling || '(unspecified)'}
Tensions / nuances: ${persona.tensions || '(none)'}

Return:
- proposedPrimary: the single best-fit niche from the list.
- proposedSecondary: 0-2 more niches from the list (never repeat the primary).
- characterContext: a <=30-line brief the content AI will read every time — voice, tone, formats that fit, and hard boundaries/brand don'ts implied by the persona and comfort ceiling.
- seedKeywords: 1-2 short Instagram search keywords (e.g. "blonde", "party girl") to discover fresh creators in this lane.`;

  const response = await claude.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 4000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high', format: { type: 'json_schema', schema: DERIVE_SCHEMA } },
    system,
    messages: [{ role: 'user', content: userPrompt }],
  });
  if (response.stop_reason === 'refusal') throw new Error('Persona derivation was declined this run — try again.');
  const textBlock = (response.content || []).find((b) => b.type === 'text');
  if (!textBlock || !textBlock.text) throw new Error('Persona derivation returned no content');
  const parsed = JSON.parse(textBlock.text);
  return {
    proposedPrimary: parsed.proposedPrimary || '',
    proposedSecondary: Array.isArray(parsed.proposedSecondary) ? parsed.proposedSecondary : [],
    characterContext: parsed.characterContext || '',
    seedKeywords: Array.isArray(parsed.seedKeywords) ? parsed.seedKeywords.slice(0, 2) : [],
  };
}

// Count "fresh" (cached, live, non-deleted) reels in a niche — mirrors me-feed's PLAYABLE
// definition (video_cache_status = 'cached'). Niche matches posts.content_type OR the
// creator's default (creator_types.content_type), same COALESCE the feed/idea-agent use.
async function countFreshNicheReels(pool, niche) {
  const res = await pool.query(
    `SELECT COUNT(*) AS cnt FROM posts p
     LEFT JOIN creator_types ct ON p.account_handle = ct.account_handle
     WHERE COALESCE(p.content_type, ct.content_type) = $1
       AND p.video_cache_status = 'cached'
       AND (p.soft_deleted = 0 OR p.soft_deleted IS NULL)
       AND (p.archived = 0 OR p.archived IS NULL)`,
    [niche]
  );
  return Number(res.rows[0] && res.rows[0].cnt) || 0;
}

async function seedNicheIfThin(deps, niche, keywords, cfg) {
  const { pool, scraper, radar } = deps;
  const kws = (keywords || []).map((k) => String(k).trim()).filter(Boolean);
  const freshCount = await countFreshNicheReels(pool, niche);
  const threshold = cfg.seedMinReels;
  if (freshCount >= threshold) return { seeded: false, freshCount, threshold, keywords: kws, reason: 'stocked' };
  if (kws.length === 0) return { seeded: false, freshCount, threshold, keywords: kws, reason: 'no_keywords' };

  for (const term of kws) {
    await pool.query(
      `INSERT INTO watch_terms (term, kind, source, status) VALUES ($1,'keyword','notion','active')
       ON CONFLICT (term, kind) DO UPDATE SET status = 'active'`,
      [term]
    );
  }
  // Fire-and-forget; runRadar is internally budget-guarded (stops on BudgetExceededError).
  if (scraper && scraper.apiKey && !(radar.getRadarStatus && radar.getRadarStatus().running)) {
    Promise.resolve(radar.runRadar(scraper)).catch((e) => console.error('[Notion] seed radar failed:', e.message));
    console.log(`[Metric] notion_seed niche=${niche} fresh=${freshCount} terms=${kws.length}`);
  }
  return { seeded: true, freshCount, threshold, keywords: kws, reason: 'seeded' };
}

// buildModelPatch, rankNiches, deriveProfile, fetchPersonaById, seedNicheIfThin are all
// defined above in this same file — do not re-import or shadow them.
const { buildCredentialFields, buildModelInsert, buildModelUpdate, MODEL_NOTION_FIELDS } = require('./model-credentials');

const IMPORT_WRITE_FIELDS = [
  'name', 'primary_niche', 'secondary_niches', 'email', 'login_enabled', 'password_hash', ...MODEL_NOTION_FIELDS,
];

async function previewPersona(deps, pageId) {
  const persona = await fetchPersonaById(deps.notionClient, pageId);
  const derived = await deriveProfile(persona, deps.availableNiches, deps.claude);
  const ranked = rankNiches([derived.proposedPrimary, ...derived.proposedSecondary], deps.availableNiches);
  return {
    name: persona.name,
    personaStatus: persona.personaStatus,
    comfortCeiling: persona.comfortCeiling,
    personaStatement: persona.personaStatement,
    proposedPrimary: ranked.primary,
    proposedSecondary: ranked.secondary,
    unmatchedNiches: ranked.unmatched,
    characterContext: derived.characterContext,
    seedKeywords: derived.seedKeywords,
  };
}

async function importPersona(deps, pageId, confirmed) {
  const persona = await fetchPersonaById(deps.notionClient, pageId);
  if (persona.personaStatus !== deps.cfg.importGate) {
    throw new Error(`Persona is "${persona.personaStatus}", not ${deps.cfg.importGate} — cannot import.`);
  }
  const merged = {
    ...buildModelPatch(persona, confirmed),
    ...buildCredentialFields({ email: confirmed.email, password: confirmed.password, login_enabled: true }),
  };
  const { sql, params } = buildModelInsert(merged, IMPORT_WRITE_FIELDS);
  await deps.pool.query(sql, params);
  const idRow = await deps.pool.query('SELECT id FROM models WHERE notion_page_id = $1', [pageId]);
  const id = idRow.rows[0] && idRow.rows[0].id;
  const seed = await seedNicheIfThin(
    { pool: deps.pool, scraper: deps.scraper, radar: deps.radar },
    confirmed.primary_niche, confirmed.seedKeywords || [], deps.cfg
  );
  return { id, name: persona.name, seeded: seed.seeded, seedReason: seed.reason };
}

async function resyncModel(deps, model, { confirm } = {}) {
  const persona = await fetchPersonaById(deps.notionClient, model.notion_page_id);
  const derived = await deriveProfile(persona, deps.availableNiches, deps.claude);
  const ranked = rankNiches([derived.proposedPrimary, ...derived.proposedSecondary], deps.availableNiches);
  const offboarded = persona.status === 'Offboarded';
  const proposed = {
    primary_niche: ranked.primary || model.primary_niche,
    secondary_niches: ranked.secondary.join(','),
    character_context: derived.characterContext,
    status: offboarded ? 'inactive' : model.status,
  };
  if (!confirm) {
    return { diff: { current: { primary_niche: model.primary_niche, secondary_niches: model.secondary_niches, status: model.status }, proposed, personaStatus: persona.personaStatus } };
  }
  const merged = {
    name: model.name, primary_niche: proposed.primary_niche, secondary_niches: proposed.secondary_niches,
    character_context: proposed.character_context, persona_statement: persona.personaStatement || '',
    comfort_ceiling: persona.comfortCeiling || '',
    ...(offboarded ? { login_enabled: 0 } : {}),
  };
  const fields = ['name', 'primary_niche', 'secondary_niches', ...(offboarded ? ['login_enabled'] : []), ...MODEL_NOTION_FIELDS];
  const { sql, params } = buildModelUpdate(merged, fields, model.id);
  await deps.pool.query(sql, params);
  if (offboarded) await deps.pool.query("UPDATE models SET status = 'inactive' WHERE id = $1", [model.id]);
  return { applied: true, offboarded };
}

module.exports = { notionConfig, normalizePersona, rankNiches, buildModelPatch, fetchApprovedPersonas, fetchPersonaById, deriveProfile, seedNicheIfThin, previewPersona, importPersona, resyncModel, DERIVE_SCHEMA };
