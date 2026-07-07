// server/content-types.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { DEFAULT_CONTENT_TYPES, slugifyTypeLabel, validateTypeLabel } = require('./content-types');

test('DEFAULT_CONTENT_TYPES holds the current six in order', () => {
  assert.deepStrictEqual(
    DEFAULT_CONTENT_TYPES.map(t => t.value),
    ['talking', 'dance', 'skit', 'snapchat', 'omegle', 'osc']
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
