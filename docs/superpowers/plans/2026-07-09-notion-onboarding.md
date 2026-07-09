# Notion-Driven Model Onboarding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Onboard a model by importing their **Approved** Notion persona — InstaScraper AI-derives the niche(s) + character context (admin confirms), auto-fills the model, and seeds the feed only when the mapped niche is thin.

**Architecture:** One isolated server module (`server/notion-sync.js`) with pure mapping functions + two mockable I/O boundaries (Notion read, Claude derivation). Thin admin routes wrap testable orchestration functions. Read-only on Notion. Reuses the existing model-credential writer, Reel Radar seeding, and the idea agent.

**Tech Stack:** Node + Express, `pg`/`better-sqlite3` (dual-mode via `server/db.js`), `@notionhq/client` (new), `@anthropic-ai/sdk` (existing), `bcryptjs`, React 18 (CRA), `node --test`.

## Global Constraints

- **Source DB:** the **Creator Personas** database (`NOTION_PERSONAS_DB_ID`), NOT Character Sheets.
- **Import gate:** only personas with `Persona Status = Approved` are eligible (env `NOTION_IMPORT_GATE`, default `Approved`).
- **Read-only on Notion:** never write back to Notion.
- **Match key:** persona `Model Name` ↔ `models.name`; link stored as `models.notion_page_id`.
- **Feature is env-gated:** if `NOTION_API_KEY` or `NOTION_PERSONAS_DB_ID` is unset, endpoints return `{ enabled: false }` and the UI hides the controls — never crash.
- **Niche vocabulary** = the `content_types.value` list (the taxonomy the feed is scoped by). AI must choose niches from this list; `rankNiches` validates against it.
- **SQLite adapter placeholder rule (CRITICAL):** `server/db.js` rewrites `$N` → `?` by appearance order. In every SQL string, `$N` must appear in ascending order with no gaps and each used exactly once. Build multi-column writes only via the `model-credentials.js` builders.
- **Budget:** day-one seeding must go through the existing Reel Radar path, which already stops on `BudgetExceededError`. Never add a new scraping path.
- **Credentials stay manual:** admin supplies `email`/`password` at import; imported models are created with `login_enabled = 1`.
- **TDD:** every task writes a failing `node --test` test first (except the frontend task, which is manually verified). Run the full server suite before each commit: `cd server && npm test`.

---

### Task 1: Schema + credential-writer allowlist

**Files:**
- Modify: `server/db.js` (SQLITE_MIGRATIONS ~line 31; PG migrations ~line 380; index block ~line 401)
- Modify: `server/model-credentials.js:6` and `:76`
- Test: `server/model-credentials.test.js`

**Interfaces:**
- Produces: `MODEL_NOTION_FIELDS = ['notion_page_id', 'character_context', 'persona_statement', 'comfort_ceiling']` (exported from `model-credentials.js`); four new nullable `models` columns; unique partial index `models_notion_page_uk`.

- [ ] **Step 1: Write the failing test**

Add to `server/model-credentials.test.js`:

```javascript
const { buildModelInsert, MODEL_WRITE_FIELDS, MODEL_NOTION_FIELDS } = require('./model-credentials');
const Database = require('better-sqlite3');

test('MODEL_NOTION_FIELDS are the four persona-sync columns', () => {
  assert.deepStrictEqual(MODEL_NOTION_FIELDS,
    ['notion_page_id', 'character_context', 'persona_statement', 'comfort_ceiling']);
});

test('buildModelInsert with notion fields: sequential placeholders + real sqlite round-trip', () => {
  const s = new Database(':memory:');
  s.exec(`CREATE TABLE models (id INTEGER PRIMARY KEY, name TEXT, primary_niche TEXT,
    secondary_niches TEXT, email TEXT, login_enabled INTEGER, password_hash TEXT,
    notion_page_id TEXT, character_context TEXT, persona_statement TEXT, comfort_ceiling TEXT)`);
  const merged = {
    name: 'Jayden', primary_niche: 'talking', secondary_niches: 'dance',
    email: 'j@x.com', login_enabled: 1, password_hash: 'h',
    notion_page_id: 'pg1', character_context: 'ctx', persona_statement: 'ps', comfort_ceiling: 'Full nude',
  };
  const fields = ['name', 'primary_niche', 'secondary_niches', ...MODEL_WRITE_FIELDS, ...MODEL_NOTION_FIELDS];
  const { sql, params } = buildModelInsert(merged, fields);
  // placeholders must be $1..$N ascending, no gaps
  const nums = [...sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1]));
  assert.deepStrictEqual(nums, params.map((_, i) => i + 1));
  s.prepare(sql.replace(/\$\d+/g, '?')).run(...params);
  const row = s.prepare('SELECT * FROM models WHERE notion_page_id = ?').get('pg1');
  assert.strictEqual(row.name, 'Jayden');
  assert.strictEqual(row.character_context, 'ctx');
  assert.strictEqual(row.comfort_ceiling, 'Full nude');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test model-credentials.test.js`
Expected: FAIL — `MODEL_NOTION_FIELDS` is `undefined`.

- [ ] **Step 3: Add the columns to both migration arrays**

In `server/db.js`, append to `SQLITE_MIGRATIONS` (after line 31, before the closing `];`):

```javascript
  `ALTER TABLE models ADD COLUMN notion_page_id TEXT`,
  `ALTER TABLE models ADD COLUMN character_context TEXT`,
  `ALTER TABLE models ADD COLUMN persona_statement TEXT`,
  `ALTER TABLE models ADD COLUMN comfort_ceiling TEXT`,
```

Append to the PG `migrations` array (after line 380, before the closing `];`):

```javascript
      `ALTER TABLE models ADD COLUMN IF NOT EXISTS notion_page_id TEXT`,
      `ALTER TABLE models ADD COLUMN IF NOT EXISTS character_context TEXT`,
      `ALTER TABLE models ADD COLUMN IF NOT EXISTS persona_statement TEXT`,
      `ALTER TABLE models ADD COLUMN IF NOT EXISTS comfort_ceiling TEXT`,
```

- [ ] **Step 4: Add the unique partial index**

In `server/db.js`, immediately after the `models_email_lower_uk` block (after line 401), add:

```javascript
  try {
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS models_notion_page_uk
      ON models (notion_page_id) WHERE notion_page_id IS NOT NULL AND notion_page_id <> ''`);
  } catch (e) {
    console.error('[db] models_notion_page_uk could not be created:', e.message);
  }
```

- [ ] **Step 5: Add and export `MODEL_NOTION_FIELDS`**

In `server/model-credentials.js`, after line 6 (`const MODEL_WRITE_FIELDS = [...]`):

```javascript
// Persona-sync columns written only by the Notion import/resync path (never by generic
// POST /models). Appended to the write allowlist by the import route.
const MODEL_NOTION_FIELDS = ['notion_page_id', 'character_context', 'persona_statement', 'comfort_ceiling'];
```

Update the exports on line 76 to include it:

```javascript
module.exports = { buildCredentialFields, MODEL_WRITE_FIELDS, MODEL_NOTION_FIELDS, buildModelWriteColumns, buildModelInsert, buildModelUpdate, isDuplicateEmailError };
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd server && node --test model-credentials.test.js`
Expected: PASS (both new tests).

- [ ] **Step 7: Commit**

```bash
git add server/db.js server/model-credentials.js server/model-credentials.test.js
git commit -m "feat(notion): add models persona-sync columns + credential allowlist"
```

---

### Task 2: `notion-sync.js` pure core (config + mapping)

**Files:**
- Create: `server/notion-sync.js`
- Test: `server/notion-sync.test.js`

**Interfaces:**
- Produces:
  - `notionConfig(env) → { enabled, apiKey, personasDbId, seedMinReels, importGate }`
  - `normalizePersona(page) → { pageId, name, personaStatement, comfortCeiling, tensions, personaStatus, status }`
  - `rankNiches(aiNiches, availableNiches) → { primary, secondary, unmatched }`
  - `buildModelPatch(persona, confirmed) → { name, primary_niche, secondary_niches, notion_page_id, character_context, persona_statement, comfort_ceiling }`

- [ ] **Step 1: Write the failing test**

Create `server/notion-sync.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const { notionConfig, normalizePersona, rankNiches, buildModelPatch } = require('./notion-sync');

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test notion-sync.test.js`
Expected: FAIL — `Cannot find module './notion-sync'`.

- [ ] **Step 3: Write the minimal implementation**

Create `server/notion-sync.js`:

```javascript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && node --test notion-sync.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/notion-sync.js server/notion-sync.test.js
git commit -m "feat(notion): pure config + persona mapping core"
```

---

### Task 3: Notion fetch + Claude derivation (I/O boundaries, mockable)

**Files:**
- Modify: `server/notion-sync.js`
- Test: `server/notion-sync.test.js`

**Interfaces:**
- Consumes: `normalizePersona` (Task 2).
- Produces:
  - `fetchApprovedPersonas(client, cfg) → Promise<persona[]>`
  - `fetchPersonaById(client, pageId) → Promise<persona>`
  - `deriveProfile(persona, availableNiches, claude) → Promise<{ proposedPrimary, proposedSecondary, characterContext, seedKeywords }>`
  - `DERIVE_SCHEMA` (exported for reference)
- `client` is a `@notionhq/client` `Client` (or a mock with `.databases.query` / `.pages.retrieve`). `claude` is an `@anthropic-ai/sdk` client (or a mock with `.messages.create`).

- [ ] **Step 1: Write the failing test**

Add to `server/notion-sync.test.js`:

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test notion-sync.test.js`
Expected: FAIL — `fetchApprovedPersonas is not a function`.

- [ ] **Step 3: Write the implementation**

Add to `server/notion-sync.js` (above `module.exports`):

```javascript
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
```

Update the exports line:

```javascript
module.exports = { notionConfig, normalizePersona, rankNiches, buildModelPatch, fetchApprovedPersonas, fetchPersonaById, deriveProfile, DERIVE_SCHEMA };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && node --test notion-sync.test.js`
Expected: PASS (all Task 2 + Task 3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/notion-sync.js server/notion-sync.test.js
git commit -m "feat(notion): persona fetch + Claude niche/context derivation"
```

---

### Task 4: Day-one seeding (`seedNicheIfThin`)

**Files:**
- Modify: `server/notion-sync.js`
- Test: `server/notion-sync.test.js`

**Interfaces:**
- Produces: `seedNicheIfThin(deps, niche, keywords, cfg) → Promise<{ seeded, freshCount, threshold, keywords, reason }>` where `deps = { pool, scraper, radar }`.
- Consumes: `radar.runRadar(scraper)` (fire-and-forget, budget-guarded); `pool.query`.

- [ ] **Step 1: Write the failing test**

Add to `server/notion-sync.test.js`:

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test notion-sync.test.js`
Expected: FAIL — `seedNicheIfThin is not a function`.

- [ ] **Step 3: Write the implementation**

Add to `server/notion-sync.js` (above `module.exports`):

```javascript
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
```

Update the exports line to add `seedNicheIfThin`:

```javascript
module.exports = { notionConfig, normalizePersona, rankNiches, buildModelPatch, fetchApprovedPersonas, fetchPersonaById, deriveProfile, seedNicheIfThin, DERIVE_SCHEMA };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && node --test notion-sync.test.js`
Expected: PASS (all notion-sync tests).

- [ ] **Step 5: Commit**

```bash
git add server/notion-sync.js server/notion-sync.test.js
git commit -m "feat(notion): seed thin niche via budget-guarded Reel Radar"
```

---

### Task 5: Orchestration functions + admin routes + dependency

**Files:**
- Modify: `server/notion-sync.js` (add `previewPersona`, `importPersona`, `resyncModel`)
- Modify: `server/index.js` (mount client + routes)
- Modify: `server/package.json` (add `@notionhq/client`)
- Test: `server/notion-sync.test.js`

**Interfaces:**
- Consumes: everything from Tasks 2-4; `buildModelPatch`, `buildCredentialFields`, `buildModelInsert`, `MODEL_NOTION_FIELDS`, `isDuplicateEmailError` from `model-credentials.js`; `buildModelUpdate`.
- Produces (all take a `deps` bag so they're mockable):
  - `previewPersona(deps, pageId) → { name, proposedPrimary, proposedSecondary, characterContext, seedKeywords, comfortCeiling, personaStatement, unmatchedNiches, personaStatus }`
  - `importPersona(deps, pageId, confirmed) → { id, seeded, name }` (`confirmed = { primary_niche, secondary_niches, character_context, email, password, seedKeywords }`)
  - `resyncModel(deps, model, { confirm }) → { diff } | { applied: true }`
  - `deps = { notionClient, claude, pool, scraper, radar, cfg, availableNiches }`

- [ ] **Step 1: Write the failing test**

Add to `server/notion-sync.test.js` (uses a real in-memory sqlite for the model write):

```javascript
const { previewPersona, importPersona } = require('./notion-sync');
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
  return {
    sqlite: s,
    query: async (sql, params = []) => {
      const stmt = s.prepare(sql.replace(/\$\d+/g, '?'));
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test notion-sync.test.js`
Expected: FAIL — `previewPersona is not a function`.

- [ ] **Step 3: Write the orchestration functions**

Add to `server/notion-sync.js` (above `module.exports`):

```javascript
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
```

Update the exports line:

```javascript
module.exports = { notionConfig, normalizePersona, rankNiches, buildModelPatch, fetchApprovedPersonas, fetchPersonaById, deriveProfile, seedNicheIfThin, previewPersona, importPersona, resyncModel, DERIVE_SCHEMA };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && node --test notion-sync.test.js`
Expected: PASS (all notion-sync tests, including the 3 orchestration tests).

- [ ] **Step 5: Add the dependency**

```bash
cd server && npm install @notionhq/client@^2.2.15
```
Expected: `package.json` + `package-lock.json` updated; `@notionhq/client` under `dependencies`.

- [ ] **Step 6: Wire the routes in `server/index.js`**

Near the other requires (after `const radar = require('./radar');`, line 15):

```javascript
const notionSync = require('./notion-sync');
const { Client: NotionClient } = require('@notionhq/client');
const Anthropic = require('@anthropic-ai/sdk');
```

After the scraper/ideaAgent construction (after line 173):

```javascript
const notionCfg = notionSync.notionConfig(process.env);
const notionClient = notionCfg.enabled ? new NotionClient({ auth: notionCfg.apiKey }) : null;
const notionClaude = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

async function availableNiches() {
  const r = await pool.query('SELECT value FROM content_types ORDER BY sort_order, label');
  const vals = r.rows.map((x) => x.value);
  if (vals.length) return vals;
  const d = await pool.query('SELECT DISTINCT content_type FROM creator_types WHERE content_type IS NOT NULL ORDER BY content_type');
  return d.rows.map((x) => x.content_type);
}
function notionDeps(niches) {
  return { notionClient, claude: notionClaude, pool, scraper, radar, cfg: notionCfg, availableNiches: niches };
}
```

Add the auth guard next to the others (after line 164, `app.use('/admin', requireAdmin);`):

```javascript
app.use('/notion', requireAdmin);
```

Add the routes (place them right before the Reel Radar routes at line 567, `// ─── Reel Radar Routes`):

```javascript
// ─── Notion Onboarding Routes ──────────────────────────────────
app.get('/notion/personas', asyncHandler(async (req, res) => {
  if (!notionClient) return res.json({ enabled: false, personas: [] });
  const personas = await notionSync.fetchApprovedPersonas(notionClient, notionCfg);
  const linked = await pool.query("SELECT notion_page_id FROM models WHERE notion_page_id IS NOT NULL AND notion_page_id <> ''");
  const linkedIds = new Set(linked.rows.map((r) => r.notion_page_id));
  res.json({ enabled: true, personas: personas.map((p) => ({ pageId: p.pageId, name: p.name, status: p.status, linked: linkedIds.has(p.pageId) })) });
}));

app.post('/notion/personas/:pageId/preview', asyncHandler(async (req, res) => {
  if (!notionClient) return res.status(400).json({ error: 'Notion not configured' });
  if (!notionClaude) return res.status(400).json({ error: 'ANTHROPIC_API_KEY not configured' });
  const preview = await notionSync.previewPersona(notionDeps(await availableNiches()), req.params.pageId);
  res.json(preview);
}));

app.post('/notion/personas/:pageId/import', asyncHandler(async (req, res) => {
  if (!notionClient) return res.status(400).json({ error: 'Notion not configured' });
  const { primary_niche, secondary_niches, character_context, email, password, seedKeywords } = req.body || {};
  if (!primary_niche || !email || !password) return res.status(400).json({ error: 'primary_niche, email, password required' });
  try {
    const out = await notionSync.importPersona(notionDeps(await availableNiches()), req.params.pageId, { primary_niche, secondary_niches, character_context, email, password, seedKeywords });
    res.json({ success: true, ...out });
  } catch (err) {
    if (isDuplicateEmailError(err)) return res.status(409).json({ error: 'Email already in use' });
    if (/already|UNIQUE|notion_page/i.test(String(err.message))) return res.status(409).json({ error: 'This persona is already linked to a model' });
    res.status(400).json({ error: err.message });
  }
}));

app.post('/models/:id/resync-notion', asyncHandler(async (req, res) => {
  if (!notionClient) return res.status(400).json({ error: 'Notion not configured' });
  const m = await pool.query('SELECT id, name, primary_niche, secondary_niches, status, notion_page_id FROM models WHERE id = $1', [Number(req.params.id)]);
  const model = m.rows[0];
  if (!model || !model.notion_page_id) return res.status(404).json({ error: 'Model not linked to a Notion persona' });
  const out = await notionSync.resyncModel(notionDeps(await availableNiches()), model, { confirm: Boolean(req.body && req.body.confirm) });
  res.json(out);
}));
```

> `isDuplicateEmailError` is already imported in index.js via `model-credentials` — confirm it's in scope; if not, add it to that require.

- [ ] **Step 7: Run the full server suite**

Run: `cd server && npm test`
Expected: PASS — all prior tests + new notion-sync tests. (Routes are thin wrappers over tested functions; no new route-level test framework needed.)

- [ ] **Step 8: Commit**

```bash
git add server/notion-sync.js server/notion-sync.test.js server/index.js server/package.json server/package-lock.json
git commit -m "feat(notion): preview/import/resync orchestration + admin routes"
```

---

### Task 6: Feed the character context into the idea agent

**Files:**
- Modify: `server/ai-agent.js` (`_callClaude`, ~line 187; module export)
- Test: `server/ai-agent.test.js`

**Interfaces:**
- Produces: `ContentIdeaAgent.personaBlock(model) → string` (empty string when no `character_context`).
- Behavior: when `model.character_context` is non-empty, the idea-generation user prompt includes a "Creator persona" block.

- [ ] **Step 1: Write the failing test**

Add to `server/ai-agent.test.js`:

```javascript
const ContentIdeaAgent = require('./ai-agent');

test('personaBlock: empty when no character_context', () => {
  assert.strictEqual(ContentIdeaAgent.personaBlock({ name: 'X' }), '');
  assert.strictEqual(ContentIdeaAgent.personaBlock({ name: 'X', character_context: '' }), '');
});

test('personaBlock: includes the context when present', () => {
  const out = ContentIdeaAgent.personaBlock({ character_context: 'Flirty AZ party girl; never crude.' });
  assert.ok(out.includes('Flirty AZ party girl'));
  assert.match(out, /persona/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test ai-agent.test.js`
Expected: FAIL — `ContentIdeaAgent.personaBlock is not a function`.

- [ ] **Step 3: Add `personaBlock` and inject it**

In `server/ai-agent.js`, add a module-level function above `class ContentIdeaAgent`:

```javascript
function personaBlock(model) {
  const ctx = model && model.character_context;
  if (!ctx || !String(ctx).trim()) return '';
  return `\nCreator persona (honor this — match the voice/tone and respect the hard boundaries):\n${String(ctx).trim()}\n`;
}
```

In `_callClaude`, change the `userPrompt` opening (line 187) from:

```javascript
    const userPrompt = `Generate 3-5 content ideas for ${model.name}, who creates "${model.primary_niche}" content${secondaryText}.
```

to:

```javascript
    const userPrompt = `Generate 3-5 content ideas for ${model.name}, who creates "${model.primary_niche}" content${secondaryText}.
${personaBlock(model)}
```

At the bottom of the file, after `module.exports = ContentIdeaAgent;`, attach the helper:

```javascript
ContentIdeaAgent.personaBlock = personaBlock;
```

(If the file currently exports via `module.exports = ContentIdeaAgent;`, keep that line and add the attach line after it.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && node --test ai-agent.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/ai-agent.js server/ai-agent.test.js
git commit -m "feat(notion): idea agent honors imported character context"
```

---

### Task 7: Admin UI — Import from Notion + Re-sync

**Files:**
- Modify: `client/src/api.js` (after line 71)
- Modify: `client/src/pages/ModelsTab.js`

**Interfaces:**
- Consumes: `GET /notion/personas`, `POST /notion/personas/:id/preview`, `POST /notion/personas/:id/import`, `POST /models/:id/resync-notion`.

- [ ] **Step 1: Add API helpers**

In `client/src/api.js`, after line 71 (`export const getAvailableNiches = ...`):

```javascript
export const getNotionPersonas = () => api.get('/notion/personas');
export const previewNotionPersona = (pageId) => api.post(`/notion/personas/${pageId}/preview`);
export const importNotionPersona = (pageId, data) => api.post(`/notion/personas/${pageId}/import`, data);
export const resyncNotion = (id, confirm) => api.post(`/models/${id}/resync-notion`, { confirm });
```

- [ ] **Step 2: Add the import flow to `ModelsTab.js`**

Add to the imports on line 2:

```javascript
import { getNotionPersonas, previewNotionPersona, importNotionPersona, resyncNotion } from '../api';
```

Add state inside `ModelsTab` (after line 29, `const [form, setForm] = ...`):

```javascript
  const [notion, setNotion] = useState({ open: false, enabled: null, personas: [], loading: false });
  const [importForm, setImportForm] = useState(null); // { pageId, name, preview, primary_niche, secondary_niches, email, password }

  const openNotion = async () => {
    setNotion((n) => ({ ...n, open: true, loading: true }));
    try {
      const { data } = await getNotionPersonas();
      setNotion({ open: true, enabled: data.enabled, personas: data.personas || [], loading: false });
    } catch (err) { setNotion({ open: true, enabled: false, personas: [], loading: false }); }
  };

  const startImport = async (p) => {
    try {
      const { data } = await previewNotionPersona(p.pageId);
      setImportForm({
        pageId: p.pageId, name: data.name, preview: data,
        primary_niche: data.proposedPrimary || '', secondary_niches: (data.proposedSecondary || []).join(','),
        email: '', password: '',
      });
    } catch (err) { alert('Preview failed: ' + (err.response?.data?.error || err.message)); }
  };

  const submitImport = async () => {
    try {
      await importNotionPersona(importForm.pageId, {
        primary_niche: importForm.primary_niche,
        secondary_niches: importForm.secondary_niches,
        character_context: importForm.preview.characterContext,
        email: importForm.email, password: importForm.password,
        seedKeywords: importForm.preview.seedKeywords,
      });
      setImportForm(null);
      setNotion((n) => ({ ...n, open: false }));
      loadModels();
    } catch (err) { alert('Import failed: ' + (err.response?.data?.error || err.message)); }
  };

  const doResync = async (model) => {
    try {
      const { data } = await resyncNotion(model.id, false);
      const d = data.diff;
      const msg = `Re-sync "${model.name}" from Notion?\n\nniche: ${d.current.primary_niche} → ${d.proposed.primary_niche}\nstatus: ${d.current.status} → ${d.proposed.status}`;
      if (window.confirm(msg)) { await resyncNotion(model.id, true); loadModels(); }
    } catch (err) { alert('Re-sync failed: ' + (err.response?.data?.error || err.message)); }
  };
```

Add an "Import from Notion" button next to the existing "Add Model" control (find the header button row in the render and add):

```jsx
        <button onClick={openNotion} className="px-3 py-2 rounded bg-gold text-gray-950 font-medium">Import from Notion</button>
```

Add the Notion picker + import modal near the end of the returned JSX (before the closing container tag):

```jsx
      {notion.open && !importForm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setNotion((n) => ({ ...n, open: false }))}>
          <div className="bg-gray-900 p-5 rounded-lg w-[min(560px,92vw)] max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold mb-3">Import model from Notion</h3>
            {notion.loading && <p className="text-gray-400">Loading personas…</p>}
            {notion.enabled === false && <p className="text-gray-400">Notion isn't configured (set NOTION_API_KEY + NOTION_PERSONAS_DB_ID).</p>}
            {notion.enabled && notion.personas.length === 0 && <p className="text-gray-400">No Approved personas found.</p>}
            {notion.personas.map((p) => (
              <div key={p.pageId} className="flex items-center justify-between py-2 border-b border-gray-800">
                <span>{p.name} <span className="text-xs text-gray-500">({p.status})</span></span>
                {p.linked
                  ? <span className="text-xs text-gray-500">already imported</span>
                  : <button onClick={() => startImport(p)} className="px-2 py-1 text-sm rounded bg-gold text-gray-950">Import</button>}
              </div>
            ))}
          </div>
        </div>
      )}

      {importForm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-900 p-5 rounded-lg w-[min(560px,92vw)] max-h-[85vh] overflow-y-auto">
            <h3 className="text-lg font-semibold mb-1">Import {importForm.name}</h3>
            <p className="text-xs text-gray-400 mb-3">{importForm.preview.personaStatement}</p>
            <label className="block text-sm mb-1">Primary niche</label>
            <select value={importForm.primary_niche} onChange={(e) => setImportForm({ ...importForm, primary_niche: e.target.value })} className="w-full mb-3 bg-gray-800 rounded p-2">
              <option value="">— pick —</option>
              {niches.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <label className="block text-sm mb-1">Secondary niches (comma-separated)</label>
            <input value={importForm.secondary_niches} onChange={(e) => setImportForm({ ...importForm, secondary_niches: e.target.value })} className="w-full mb-3 bg-gray-800 rounded p-2" />
            {importForm.preview.unmatchedNiches?.length > 0 && <p className="text-xs text-yellow-500 mb-3">No InstaScraper niche for: {importForm.preview.unmatchedNiches.join(', ')}</p>}
            <label className="block text-sm mb-1">Login email</label>
            <input value={importForm.email} onChange={(e) => setImportForm({ ...importForm, email: e.target.value })} className="w-full mb-3 bg-gray-800 rounded p-2" />
            <label className="block text-sm mb-1">Password</label>
            <input type="password" value={importForm.password} onChange={(e) => setImportForm({ ...importForm, password: e.target.value })} className="w-full mb-4 bg-gray-800 rounded p-2" />
            <details className="mb-4"><summary className="text-sm text-gray-400 cursor-pointer">Character context (AI)</summary><pre className="text-xs whitespace-pre-wrap text-gray-300 mt-2">{importForm.preview.characterContext}</pre></details>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setImportForm(null)} className="px-3 py-2 rounded bg-gray-700">Cancel</button>
              <button onClick={submitImport} disabled={!importForm.primary_niche || !importForm.email || !importForm.password} className="px-3 py-2 rounded bg-gold text-gray-950 disabled:opacity-50">Create model</button>
            </div>
          </div>
        </div>
      )}
```

Add a "Re-sync" button in each model's row/card action area (next to Edit), shown only when the model is Notion-linked (`model.notion_page_id`):

```jsx
      {model.notion_page_id && <button onClick={() => doResync(model)} className="px-2 py-1 text-sm rounded bg-gray-700">Re-sync</button>}
```

> `/models` GET already returns named columns and does NOT include `notion_page_id` (index.js line 752). Add `notion_page_id` to that SELECT list so the Re-sync button can render.

- [ ] **Step 3: Add `notion_page_id` to the models list query**

In `server/index.js` line 752, add `notion_page_id` to the SELECT:

```javascript
    `SELECT id, name, primary_niche, secondary_niches, delivery_method, delivery_contact, delivery_day, status, email, role, login_enabled, notion_page_id, created_at, updated_at
     FROM models WHERE status = 'active' ORDER BY created_at DESC`
```

- [ ] **Step 4: Build the client to verify it compiles**

Run: `cd client && npm run build`
Expected: build succeeds (no syntax/lint errors).

- [ ] **Step 5: Manual verification**

With `NOTION_API_KEY` + `NOTION_PERSONAS_DB_ID` set and the server running:
1. Open the **Models** tab → click **Import from Notion** → the Approved personas list loads.
2. Click **Import** on one → preview shows the derived primary/secondary niche + character context.
3. Adjust niche if needed, enter email + password → **Create model** → the model appears in the list, `login_enabled` on.
4. The new model shows a **Re-sync** button; clicking it shows the niche/status diff and applies on confirm.
5. With the env vars unset, the button shows "Notion isn't configured" and nothing crashes.

- [ ] **Step 6: Commit**

```bash
git add client/src/api.js client/src/pages/ModelsTab.js server/index.js
git commit -m "feat(notion): admin Import-from-Notion + Re-sync UI"
```

---

## Verification (end-to-end)

1. `cd server && npm test` — full suite green (Tasks 1-6 add ~18 unit tests).
2. `cd client && npm run build` — client compiles.
3. One-time Notion setup (documented in the spec): create an internal integration, share the Creator Personas DB with it, set `NOTION_API_KEY` + `NOTION_PERSONAS_DB_ID` (+ optional `NOTION_SEED_MIN_REELS`) on Railway.
4. Import an Approved persona; confirm the model is created, curated (feed non-empty for the mapped niche), and — if the niche was thin — a `[Metric] notion_seed` line appears and a Reel Radar run fires (budget permitting).
5. Generate ideas for the imported model; confirm the character context shapes the output (voice/boundaries honored).

## Out of scope (deferred)
- Reading the persona page **body** (trait matrix/topic list) — properties only in v1.
- Character Sheets DB, automatic nightly sync, write-back to Notion.
- C (model-health dashboard), D (persona-driven feed re-ranking), E (taste feedback loop).
