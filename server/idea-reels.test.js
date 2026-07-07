const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSourceShortcodes } = require('./idea-reels');

test('parseSourceShortcodes: extracts shortcodes from a comma-separated URL list', () => {
  const input = 'https://www.instagram.com/reel/ABC123/,https://www.instagram.com/p/XYZ_9/';
  assert.deepEqual(parseSourceShortcodes(input), ['ABC123', 'XYZ_9']);
});

test('parseSourceShortcodes: handles /reels/ (plural) URLs', () => {
  const input = 'https://www.instagram.com/reels/PLURAL1/';
  assert.deepEqual(parseSourceShortcodes(input), ['PLURAL1']);
});

test('parseSourceShortcodes: a bare shortcode (no URL) passes through', () => {
  assert.deepEqual(parseSourceShortcodes('ABC123'), ['ABC123']);
});

test('parseSourceShortcodes: dedupes repeated shortcodes', () => {
  const input = 'https://www.instagram.com/reel/ABC123/,https://www.instagram.com/reel/ABC123/';
  assert.deepEqual(parseSourceShortcodes(input), ['ABC123']);
});

test('parseSourceShortcodes: drops empty items from stray commas/whitespace', () => {
  const input = ' https://www.instagram.com/reel/ABC123/ ,, ,https://www.instagram.com/p/XYZ_9/,';
  assert.deepEqual(parseSourceShortcodes(input), ['ABC123', 'XYZ_9']);
});

test('parseSourceShortcodes: empty string input returns an empty array', () => {
  assert.deepEqual(parseSourceShortcodes(''), []);
});

test('parseSourceShortcodes: null/undefined input returns an empty array', () => {
  assert.deepEqual(parseSourceShortcodes(null), []);
  assert.deepEqual(parseSourceShortcodes(undefined), []);
});

test('parseSourceShortcodes: mixed list of URLs and a bare shortcode, with dupes', () => {
  const input = 'https://www.instagram.com/reel/ABC123/,BAREBARE,https://www.instagram.com/p/XYZ_9/,ABC123';
  assert.deepEqual(parseSourceShortcodes(input), ['ABC123', 'BAREBARE', 'XYZ_9']);
});
