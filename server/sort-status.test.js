const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { decideSort, effectiveNicheExpr, sortConfig, lipSyncConfig } = require('./sort-status');

const typeValues = ['dance', 'talking'];
test('confident known type → auto', () => {
  assert.deepStrictEqual(decideSort({ ai: { type: 'dance', confidence: 0.9 }, typeValues, threshold: 0.8 }),
    { sortStatus: 'auto', contentType: 'dance' });
});
for (const [name, ai] of [
  ['below threshold', { type: 'dance', confidence: 0.79 }],
  ['type not in list', { type: 'lifestyle', confidence: 0.95 }],
  ['null type', { type: null, confidence: 1 }],
]) {
  test(`${name} → needs_look, null type`, () => {
    assert.deepStrictEqual(decideSort({ ai, typeValues, threshold: 0.8 }), { sortStatus: 'needs_look', contentType: null });
  });
}

for (const audioKind of ['music_or_trending_audio', 'other_voice']) {
  test(`talking with ${audioKind} becomes lipsync at the same confidence threshold`, () => {
    const ai = { type: 'talking', confidence: 0.8, audioKind };
    const input = { ai, typeValues: [...typeValues, 'lipsync'], threshold: 0.8 };
    assert.deepStrictEqual(decideSort(input), { sortStatus: 'auto', contentType: 'lipsync' });
    assert.deepStrictEqual(decideSort({ ...input, threshold: 0.81 }), { sortStatus: 'needs_look', contentType: null });
    assert.strictEqual(ai.confidence, 0.8);
    assert.deepStrictEqual(decideSort({ ...input, typeValues }), { sortStatus: 'needs_look', contentType: null });
  });
}

test('talking without verified own speech needs a look even when lipsync exists', () => {
  for (const audioKind of ['none', null, undefined, 'unknown']) {
    assert.deepStrictEqual(decideSort({ ai: { type: 'talking', confidence: 1, audioKind }, typeValues: [...typeValues, 'lipsync'], threshold: 0.8 }),
      { sortStatus: 'needs_look', contentType: null });
  }
});

test('talking with own speech stays talking', () => {
  assert.deepStrictEqual(decideSort({ ai: { type: 'talking', confidence: 0.9, audioKind: 'own_speech' }, typeValues, threshold: 0.8 }),
    { sortStatus: 'auto', contentType: 'talking' });
});

test('effectiveNicheExpr returns only sorted post types, never creator labels', () => {
  const sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE posts (id INTEGER PRIMARY KEY, account_handle TEXT, content_type TEXT, sort_status TEXT);
    CREATE TABLE creator_types (account_handle TEXT, content_type TEXT);
    INSERT INTO creator_types VALUES ('creator', 'talking');
    INSERT INTO posts VALUES (1, 'creator', 'dance', 'unsorted'), (2, 'creator', 'dance', 'needs_look'),
      (3, 'creator', 'dance', 'auto'), (4, 'creator', NULL, 'manual')`);
  assert.strictEqual(effectiveNicheExpr('p', 'creator'), "CASE WHEN p.sort_status IN ('auto','manual') THEN p.content_type ELSE NULL END");
  const rows = sqlite.prepare(`SELECT ${effectiveNicheExpr('p', 'ct')} AS niche FROM posts p
    LEFT JOIN creator_types ct ON p.account_handle = ct.account_handle ORDER BY p.id`).all();
  assert.deepStrictEqual(rows.map((row) => row.niche), [null, null, 'dance', null]);
});

test('sortConfig defaults and enabled key', () => {
  assert.deepStrictEqual(sortConfig({}), {
    minConfidence: 0.8, batch: 50, dailyMax: 1000, maxAttempts: 3, model: 'gemini-3.5-flash-lite',
    priceInPerM: 0.30, priceOutPerM: 2.50, enabled: false,
  });
  assert.strictEqual(sortConfig({ GEMINI_API_KEY: 'fake-key' }).enabled, true);
});

test('lipSyncConfig uses dedicated detector prices', () => {
  assert.deepStrictEqual(lipSyncConfig({}), { priceInPerM: 0.50, priceOutPerM: 3.00 });
  assert.deepStrictEqual(lipSyncConfig({
    GEMINI_PRICE_IN_PER_M: '99', GEMINI_PRICE_OUT_PER_M: '99',
  }), { priceInPerM: 0.50, priceOutPerM: 3.00 });
  assert.deepStrictEqual(lipSyncConfig({
    LIPSYNC_PRICE_IN_PER_M: '1.25', LIPSYNC_PRICE_OUT_PER_M: '4.5',
  }), { priceInPerM: 1.25, priceOutPerM: 4.5 });
  assert.deepStrictEqual(lipSyncConfig({
    LIPSYNC_PRICE_IN_PER_M: '0', LIPSYNC_PRICE_OUT_PER_M: '0',
  }), { priceInPerM: 0, priceOutPerM: 0 });
});

test('lipSyncConfig falls back for blank, invalid, nonfinite, and negative prices', () => {
  for (const value of ['', ' ', 'invalid', 'Infinity', '-1']) {
    assert.deepStrictEqual(lipSyncConfig({
      LIPSYNC_PRICE_IN_PER_M: value, LIPSYNC_PRICE_OUT_PER_M: value,
    }), { priceInPerM: 0.50, priceOutPerM: 3.00 });
  }
});
