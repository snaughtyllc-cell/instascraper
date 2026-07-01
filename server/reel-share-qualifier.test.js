const { test } = require('node:test');
const assert = require('node:assert');
const { qualifiesByReelShare, discoveryConfig } = require('./scheduler');

// Pure predicate gating Suggested accounts by reel-share. It's a reels tool:
// accounts primarily posting reels qualify, non-reel-primary are noise.
// Unknown share is parked (kept) like unknown gender — fail-open, never guess-drop.

test('qualifiesByReelShare: at or above threshold qualifies', () => {
  assert.strictEqual(qualifiesByReelShare(0.83, 0.60), true);
  assert.strictEqual(qualifiesByReelShare(1, 0.60), true);
});

test('qualifiesByReelShare: below threshold is excluded', () => {
  assert.strictEqual(qualifiesByReelShare(0.30, 0.60), false);
  assert.strictEqual(qualifiesByReelShare(0, 0.60), false);
});

test('qualifiesByReelShare: boundary — exactly at threshold qualifies', () => {
  assert.strictEqual(qualifiesByReelShare(0.60, 0.60), true);
});

test('qualifiesByReelShare: unknown share is kept (parked, fail-open)', () => {
  assert.strictEqual(qualifiesByReelShare(null, 0.60), true);
  assert.strictEqual(qualifiesByReelShare(undefined, 0.60), true);
  assert.strictEqual(qualifiesByReelShare(NaN, 0.60), true);
});

test('discoveryConfig: minReelShare default + env override, non-numeric falls back', () => {
  assert.strictEqual(discoveryConfig({}).minReelShare, 0.60);
  assert.strictEqual(discoveryConfig({ DISCOVERY_MIN_REEL_SHARE: '0.75' }).minReelShare, 0.75);
  assert.strictEqual(discoveryConfig({ DISCOVERY_MIN_REEL_SHARE: 'nope' }).minReelShare, 0.60);
});
