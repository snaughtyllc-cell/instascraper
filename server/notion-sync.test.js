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
