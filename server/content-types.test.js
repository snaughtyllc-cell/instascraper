// server/content-types.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { DEFAULT_CONTENT_TYPES, slugifyTypeLabel, validateTypeLabel, validateContentTypeInput } = require('./content-types');

test('DEFAULT_CONTENT_TYPES preserves the current six and includes lip sync and reveal', () => {
  assert.deepStrictEqual(
    DEFAULT_CONTENT_TYPES.map(t => t.value),
    ['talking', 'dance', 'skit', 'snapchat', 'omegle', 'osc', 'lipsync', 'reveal']
  );
});

test('slugifyTypeLabel lowercases, trims, hyphenates', () => {
  assert.strictEqual(slugifyTypeLabel('  Get Ready With Me '), 'get-ready-with-me');
  assert.strictEqual(slugifyTypeLabel('POV / Skit!!'), 'pov-skit');
  assert.strictEqual(slugifyTypeLabel('OSC'), 'osc');
});

test('validateTypeLabel accepts a normal label', () => {
  assert.deepStrictEqual(validateTypeLabel('Get Ready'), { ok: true, value: 'get-ready', label: 'Get Ready' });
});

test('validateTypeLabel rejects empty / whitespace / symbol-only', () => {
  assert.strictEqual(validateTypeLabel('   ').ok, false);
  assert.strictEqual(validateTypeLabel('!!!').ok, false);
});

test('validateTypeLabel rejects labels over 40 chars', () => {
  assert.strictEqual(validateTypeLabel('x'.repeat(41)).ok, false);
});

test('content-type input distinguishes omitted, null and empty descriptions', () => {
  assert.deepStrictEqual(validateContentTypeInput({ label: 'New Type' }), { ok: true, value: 'new-type', label: 'New Type', description: null });
  assert.deepStrictEqual(validateContentTypeInput({ label: 'Renamed' }, { partial: true }), { ok: true, label: 'Renamed' });
  assert.deepStrictEqual(validateContentTypeInput({ description: null }, { partial: true }), { ok: true, description: null });
  assert.deepStrictEqual(validateContentTypeInput({ description: '  ' }, { partial: true }), { ok: true, description: '' });
  assert.strictEqual(validateContentTypeInput({}, { partial: true }).ok, false);
  for (const description of [{ text: 'bad' }, [], 5, true]) {
    assert.strictEqual(validateContentTypeInput({ label: 'New Type', description }).ok, false);
  }
});
