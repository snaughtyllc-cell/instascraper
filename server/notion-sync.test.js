const { test } = require('node:test');
const assert = require('node:assert');
const { notionConfig, normalizePersona, rankNiches, buildModelPatch } = require('./notion-sync');
const { fetchApprovedPersonas, fetchPersonaById, deriveProfile } = require('./notion-sync');

function mockNotion(pages) {
  return {
    calls: [],
    databases: {
      query: async (args) => {
        // one page of results, no pagination
        return { results: pages, has_more: false, next_cursor: null, _args: args };
      },
    },
    pages: { retrieve: async ({ page_id }) => pages.find((p) => p.id === page_id) },
  };
}

// Minimal Notion API page shape (query result / pages.retrieve share this).
function personaPage(over = {}) {
  return {
    id: 'page-123',
    properties: {
      'Model Name': { type: 'title', title: [{ plain_text: 'Jayden' }] },
      'Persona Statement': { type: 'rich_text', rich_text: [{ plain_text: 'Half-Mexican Tempe party girl.' }] },
      'Comfort Ceiling': { type: 'select', select: { name: 'Full nude' } },
      'Auto-Draft Tensions': { type: 'rich_text', rich_text: [{ plain_text: 'innocent vs. wild' }] },
      'Persona Status': { type: 'select', select: { name: 'Approved' } },
      'Status': { type: 'select', select: { name: 'Onboarding' } },
      ...over,
    },
  };
}

test('notionConfig: enabled only when both creds present; defaults applied', () => {
  assert.strictEqual(notionConfig({}).enabled, false);
  assert.strictEqual(notionConfig({ NOTION_API_KEY: 'k' }).enabled, false);
  const c = notionConfig({ NOTION_API_KEY: 'k', NOTION_PERSONAS_DB_ID: 'db' });
  assert.strictEqual(c.enabled, true);
  assert.strictEqual(c.seedMinReels, 15);
  assert.strictEqual(c.importGate, 'Approved');
  assert.strictEqual(notionConfig({ NOTION_API_KEY: 'k', NOTION_PERSONAS_DB_ID: 'db', NOTION_SEED_MIN_REELS: '5' }).seedMinReels, 5);
});

test('normalizePersona: maps Notion properties; tolerates missing props', () => {
  const p = normalizePersona(personaPage());
  assert.deepStrictEqual(p, {
    pageId: 'page-123', name: 'Jayden', personaStatement: 'Half-Mexican Tempe party girl.',
    comfortCeiling: 'Full nude', tensions: 'innocent vs. wild', personaStatus: 'Approved', status: 'Onboarding',
  });
  const bare = normalizePersona({ id: 'x', properties: { 'Model Name': { type: 'title', title: [] } } });
  assert.strictEqual(bare.name, '');
  assert.strictEqual(bare.comfortCeiling, null);
  assert.strictEqual(bare.personaStatement, '');
});

test('rankNiches: keeps only known niches (case-insensitive), primary=first, dedups, reports unmatched', () => {
  const r = rankNiches(['Talking', 'dance', 'talking', 'cosplay'], ['talking', 'dance', 'skit']);
  assert.strictEqual(r.primary, 'talking');
  assert.deepStrictEqual(r.secondary, ['dance']);
  assert.deepStrictEqual(r.unmatched, ['cosplay']);
});

test('rankNiches: no valid niche → primary null', () => {
  const r = rankNiches(['cosplay'], ['talking']);
  assert.strictEqual(r.primary, null);
  assert.deepStrictEqual(r.secondary, []);
  assert.deepStrictEqual(r.unmatched, ['cosplay']);
});

test('buildModelPatch: assembles persona-derived columns (no credential fields)', () => {
  const persona = { pageId: 'pg1', name: 'Jayden', personaStatement: 'ps', comfortCeiling: 'Full nude' };
  const confirmed = { primary_niche: 'talking', secondary_niches: 'dance', character_context: 'ctx' };
  assert.deepStrictEqual(buildModelPatch(persona, confirmed), {
    name: 'Jayden', primary_niche: 'talking', secondary_niches: 'dance',
    notion_page_id: 'pg1', character_context: 'ctx', persona_statement: 'ps', comfort_ceiling: 'Full nude',
  });
});

test('fetchApprovedPersonas: filters by importGate and normalizes rows', async () => {
  let received;
  const client = {
    databases: { query: async (args) => { received = args; return { results: [personaPage()], has_more: false }; } },
  };
  const rows = await fetchApprovedPersonas(client, { personasDbId: 'db1', importGate: 'Approved' });
  assert.strictEqual(received.database_id, 'db1');
  assert.deepStrictEqual(received.filter, { property: 'Persona Status', select: { equals: 'Approved' } });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].name, 'Jayden');
});

test('fetchApprovedPersonas: follows pagination', async () => {
  let page = 0;
  const client = {
    databases: {
      query: async () => {
        page += 1;
        if (page === 1) return { results: [personaPage()], has_more: true, next_cursor: 'c2' };
        return { results: [personaPage({ 'Model Name': { type: 'title', title: [{ plain_text: 'Izi' }] } })], has_more: false };
      },
    },
  };
  const rows = await fetchApprovedPersonas(client, { personasDbId: 'db1', importGate: 'Approved' });
  assert.deepStrictEqual(rows.map((r) => r.name), ['Jayden', 'Izi']);
});

test('fetchPersonaById: retrieves + normalizes', async () => {
  const client = mockNotion([personaPage()]);
  const p = await fetchPersonaById(client, 'page-123');
  assert.strictEqual(p.name, 'Jayden');
});

test('deriveProfile: sends niches to Claude and returns parsed proposal', async () => {
  let sent;
  const claude = {
    messages: {
      create: async (args) => {
        sent = args;
        return {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: JSON.stringify({
            proposedPrimary: 'talking', proposedSecondary: ['skit'],
            characterContext: 'Flirty AZ party girl; keep sweet, never crude.', seedKeywords: ['party girl', 'glam'],
          }) }],
        };
      },
    },
  };
  const persona = { name: 'Jayden', personaStatement: 'party girl', comfortCeiling: 'Full nude', tensions: 't' };
  const out = await deriveProfile(persona, ['talking', 'skit', 'dance'], claude);
  assert.ok(sent.system && String(sent.messages[0].content).includes('talking'), 'niche list in prompt');
  assert.strictEqual(out.proposedPrimary, 'talking');
  assert.deepStrictEqual(out.seedKeywords, ['party girl', 'glam']);
});

test('deriveProfile: throws when claude is null', async () => {
  await assert.rejects(() => deriveProfile({ name: 'x' }, ['talking'], null), /ANTHROPIC/);
});

const { seedNicheIfThin } = require('./notion-sync');

function fakePool(freshCount) {
  const q = [];
  return {
    queries: q,
    query: async (sql, params) => {
      q.push({ sql, params });
      if (/COUNT\(\*\)/i.test(sql)) return { rows: [{ cnt: freshCount }] };
      return { rows: [] };
    },
  };
}

test('seedNicheIfThin: thin niche → inserts watch_terms + fires radar', async () => {
  const pool = fakePool(3);
  let ran = 0;
  const radar = { runRadar: async () => { ran += 1; } };
  const out = await seedNicheIfThin({ pool, scraper: { apiKey: 'k' }, radar }, 'talking', ['party girl', 'glam'], { seedMinReels: 15 });
  assert.strictEqual(out.seeded, true);
  assert.strictEqual(out.freshCount, 3);
  const inserts = pool.queries.filter((x) => /INSERT INTO watch_terms/i.test(x.sql));
  assert.strictEqual(inserts.length, 2);
  assert.strictEqual(ran, 1);
});

test('seedNicheIfThin: stocked niche → no-op', async () => {
  const pool = fakePool(40);
  let ran = 0;
  const radar = { runRadar: async () => { ran += 1; } };
  const out = await seedNicheIfThin({ pool, scraper: { apiKey: 'k' }, radar }, 'talking', ['x'], { seedMinReels: 15 });
  assert.strictEqual(out.seeded, false);
  assert.strictEqual(out.reason, 'stocked');
  assert.strictEqual(pool.queries.filter((x) => /INSERT INTO watch_terms/i.test(x.sql)).length, 0);
  assert.strictEqual(ran, 0);
});

test('seedNicheIfThin: thin but no keywords → adds nothing, no radar', async () => {
  const pool = fakePool(1);
  let ran = 0;
  const out = await seedNicheIfThin({ pool, scraper: { apiKey: 'k' }, radar: { runRadar: async () => { ran += 1; } } }, 'talking', [], { seedMinReels: 15 });
  assert.strictEqual(out.seeded, false);
  assert.strictEqual(out.reason, 'no_keywords');
  assert.strictEqual(ran, 0);
});

test('seedNicheIfThin: no scraper api key → adds terms but skips radar run', async () => {
  const pool = fakePool(1);
  let ran = 0;
  const out = await seedNicheIfThin({ pool, scraper: { apiKey: '' }, radar: { runRadar: async () => { ran += 1; } } }, 'talking', ['x'], { seedMinReels: 15 });
  assert.strictEqual(out.seeded, true);
  assert.strictEqual(ran, 0, 'no scrape fired without an api key');
});

const { previewPersona, importPersona, resyncModel } = require('./notion-sync');
const Database = require('better-sqlite3');

function sqlitePool() {
  const s = new Database(':memory:');
  s.exec(`CREATE TABLE models (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, primary_niche TEXT,
    secondary_niches TEXT, delivery_method TEXT, delivery_contact TEXT, delivery_day TEXT,
    status TEXT DEFAULT 'active', email TEXT, role TEXT, login_enabled INTEGER, password_hash TEXT,
    notion_page_id TEXT, character_context TEXT, persona_statement TEXT, comfort_ceiling TEXT,
    created_at TEXT, updated_at TEXT)`);
  s.exec(`CREATE TABLE posts (id INTEGER, account_handle TEXT, content_type TEXT, video_cache_status TEXT, soft_deleted INTEGER, archived INTEGER)`);
  s.exec(`CREATE TABLE creator_types (account_handle TEXT, content_type TEXT)`);
  s.exec(`CREATE TABLE watch_terms (id INTEGER PRIMARY KEY AUTOINCREMENT, term TEXT, kind TEXT, source TEXT, status TEXT, UNIQUE(term, kind))`);
  // Adapter must route writes to .run() — better-sqlite3 .all() throws on INSERT/UPDATE.
  // buildModelUpdate() always appends a literal TO_CHAR(NOW(), '...') for updated_at
  // (Postgres syntax) — mirror db.js's dev/test conversion so UPDATE SQL runs on raw sqlite.
  return {
    sqlite: s,
    query: async (sql, params = []) => {
      const converted = sql
        .replace(/TO_CHAR\(NOW\(\),\s*'[^']*'\)/gi, "datetime('now')")
        .replace(/\$\d+/g, '?');
      const stmt = s.prepare(converted);
      if (/^\s*SELECT/i.test(sql) || /RETURNING/i.test(sql)) return { rows: stmt.all(...params) };
      const info = stmt.run(...params);
      return { rows: [], rowCount: info.changes, lastID: info.lastInsertRowid };
    },
  };
}

const derivedClaude = () => ({ messages: { create: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ proposedPrimary: 'talking', proposedSecondary: ['skit'], characterContext: 'ctx', seedKeywords: ['party girl'] }) }] }) } });

test('previewPersona: derives + ranks, writes nothing', async () => {
  const notionClient = { pages: { retrieve: async () => personaPage() } };
  const deps = { notionClient, claude: derivedClaude(), availableNiches: ['talking', 'skit', 'dance'], cfg: notionConfig({ NOTION_API_KEY: 'k', NOTION_PERSONAS_DB_ID: 'd' }) };
  const out = await previewPersona(deps, 'page-123');
  assert.strictEqual(out.name, 'Jayden');
  assert.strictEqual(out.proposedPrimary, 'talking');
  assert.deepStrictEqual(out.proposedSecondary, ['skit']);
  assert.deepStrictEqual(out.seedKeywords, ['party girl']);
});

test('importPersona: creates the model row + stamps notion_page_id + seeds thin niche', async () => {
  const pool = sqlitePool();
  let ran = 0;
  const deps = {
    notionClient: { pages: { retrieve: async () => personaPage() } },
    claude: derivedClaude(), pool, scraper: { apiKey: 'k' },
    radar: { runRadar: async () => { ran += 1; }, getRadarStatus: () => ({ running: false }) },
    availableNiches: ['talking', 'skit'], cfg: notionConfig({ NOTION_API_KEY: 'k', NOTION_PERSONAS_DB_ID: 'd' }),
  };
  const out = await importPersona(deps, 'page-123', {
    primary_niche: 'talking', secondary_niches: 'skit', character_context: 'ctx',
    email: 'j@x.com', password: 'strongpass123', seedKeywords: ['party girl'],
  });
  assert.ok(out.id > 0);
  assert.strictEqual(out.seeded, true);
  const row = pool.sqlite.prepare('SELECT * FROM models WHERE id = ?').get(out.id);
  assert.strictEqual(row.name, 'Jayden');
  assert.strictEqual(row.notion_page_id, 'page-123');
  assert.strictEqual(row.login_enabled, 1);
  assert.ok(row.password_hash && row.password_hash !== 'strongpass123', 'password hashed');
  assert.strictEqual(ran, 1);
});

test('importPersona: rejects a non-Approved persona', async () => {
  const pool = sqlitePool();
  const deps = {
    notionClient: { pages: { retrieve: async () => personaPage({ 'Persona Status': { type: 'select', select: { name: 'Draft' } } }) } },
    claude: derivedClaude(), pool, scraper: { apiKey: 'k' }, radar: { runRadar: async () => {}, getRadarStatus: () => ({ running: false }) },
    availableNiches: ['talking'], cfg: notionConfig({ NOTION_API_KEY: 'k', NOTION_PERSONAS_DB_ID: 'd' }),
  };
  await assert.rejects(() => importPersona(deps, 'page-123', { primary_niche: 'talking', email: 'a@b.com', password: 'strongpass123' }), /Approved/);
});

test('resyncModel: confirm path applies the confirmed proposal WITHOUT re-deriving [review fix]', async () => {
  const pool = sqlitePool();
  pool.sqlite.prepare(
    `INSERT INTO models (id, name, primary_niche, secondary_niches, status, notion_page_id)
     VALUES (1, 'Jayden', 'dance', '', 'active', 'page-123')`
  ).run();
  const model = { id: 1, name: 'Jayden', primary_niche: 'dance', secondary_niches: '', status: 'active', notion_page_id: 'page-123' };
  const confirmed = { primary_niche: 'talking', secondary_niches: 'skit', character_context: 'confirmed brief — admin already saw this' };
  const deps = {
    notionClient: { pages: { retrieve: async () => personaPage() } },
    // If resyncModel re-derives on the confirm path, this throws — the test would fail loudly.
    claude: { messages: { create: () => { throw new Error('should not derive on confirm'); } } },
    pool, availableNiches: ['talking', 'skit', 'dance'],
  };
  const out = await resyncModel(deps, model, { confirm: true, confirmed });
  assert.strictEqual(out.applied, true);
  assert.strictEqual(out.offboarded, false);
  const row = pool.sqlite.prepare('SELECT * FROM models WHERE id = ?').get(1);
  assert.strictEqual(row.primary_niche, confirmed.primary_niche);
  assert.strictEqual(row.secondary_niches, confirmed.secondary_niches);
  assert.strictEqual(row.character_context, confirmed.character_context);
  // Deterministic Notion properties (persona statement / comfort ceiling) still refresh
  // from the persona fetch — only the derived niche/context must come from `confirmed`.
  assert.strictEqual(row.persona_statement, 'Half-Mexican Tempe party girl.');
  assert.strictEqual(row.comfort_ceiling, 'Full nude');
});

test('resyncModel: confirm path on an Offboarded persona disables login + sets status inactive', async () => {
  const pool = sqlitePool();
  pool.sqlite.prepare(
    `INSERT INTO models (id, name, primary_niche, secondary_niches, status, notion_page_id, login_enabled)
     VALUES (1, 'Jayden', 'dance', '', 'active', 'page-123', 1)`
  ).run();
  const model = { id: 1, name: 'Jayden', primary_niche: 'dance', secondary_niches: '', status: 'active', notion_page_id: 'page-123' };
  const confirmed = { primary_niche: 'talking', secondary_niches: '', character_context: 'ctx' };
  const deps = {
    notionClient: { pages: { retrieve: async () => personaPage({ 'Status': { type: 'select', select: { name: 'Offboarded' } } }) } },
    claude: { messages: { create: () => { throw new Error('should not derive on confirm'); } } },
    pool, availableNiches: ['talking', 'dance'],
  };
  const out = await resyncModel(deps, model, { confirm: true, confirmed });
  assert.strictEqual(out.offboarded, true);
  const row = pool.sqlite.prepare('SELECT * FROM models WHERE id = ?').get(1);
  assert.strictEqual(row.login_enabled, 0);
  assert.strictEqual(row.status, 'inactive');
});
