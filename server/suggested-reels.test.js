const { test } = require('node:test');
const assert = require('node:assert');
const { pickTopReels } = require('./scraper');

const reel = (shortCode, views, extra = {}) => ({
  type: 'Video', shortCode, videoPlayCount: views, videoUrl: `https://x/${shortCode}.mp4`,
  displayUrl: `https://x/${shortCode}.jpg`, url: `https://www.instagram.com/reel/${shortCode}/`,
  likesCount: 10, commentsCount: 2, ...extra,
});

test('pickTopReels: keeps videos, sorts by views desc, caps at n, ranks 1..n', () => {
  const items = [reel('a', 100), reel('b', 900), reel('c', 500), reel('d', 700)];
  const out = pickTopReels(items, 3);
  assert.deepStrictEqual(out.map(r => r.shortcode), ['b', 'd', 'c']);
  assert.deepStrictEqual(out.map(r => r.rank), [1, 2, 3]);
  assert.strictEqual(out[0].viewCount, 900);
  assert.strictEqual(out[0].thumbnailUrl, 'https://x/b.jpg');
  assert.strictEqual(out[0].videoUrl, 'https://x/b.mp4');
});

test('pickTopReels: drops non-videos (images/carousels)', () => {
  const items = [reel('v', 300), { type: 'Image', shortCode: 'img', displayUrl: 'x' }, { type: 'Sidecar', shortCode: 'car' }];
  assert.deepStrictEqual(pickTopReels(items, 3).map(r => r.shortcode), ['v']);
});

test('pickTopReels: fewer than n reels returns what exists', () => {
  assert.strictEqual(pickTopReels([reel('a', 5)], 3).length, 1);
});

test('pickTopReels: missing views treated as 0 (sorts last)', () => {
  const items = [{ type: 'Video', shortCode: 'noview', videoUrl: 'x' }, reel('has', 50)];
  assert.deepStrictEqual(pickTopReels(items, 3).map(r => r.shortcode), ['has', 'noview']);
});

test('pickTopReels: permalink falls back to /reel/<shortcode>/ when url missing', () => {
  const [r] = pickTopReels([{ type: 'Video', shortCode: 'zz', videoUrl: 'x', videoPlayCount: 1 }], 1);
  assert.strictEqual(r.permalink, 'https://www.instagram.com/reel/zz/');
});

test('pickTopReels: drops items with no shortcode (cannot be stored)', () => {
  const items = [{ type: 'Video', videoUrl: 'x', videoPlayCount: 999 }, reel('ok', 1)];
  assert.deepStrictEqual(pickTopReels(items, 3).map(r => r.shortcode), ['ok']);
});

test('pickTopReels: error-stub / non-array input returns []', () => {
  assert.deepStrictEqual(pickTopReels([{ requestErrorMessages: ['BLOCKED'] }], 3), []);
  assert.deepStrictEqual(pickTopReels(null, 3), []);
});

const { attachTopReels } = require('./scraper');

test('attachTopReels: groups reels by username, ordered by rank; empty when none', () => {
  const accounts = [{ username: 'alice' }, { username: 'bob' }];
  const reels = [
    { id: 2, username: 'alice', rank: 2, shortcode: 'a2' },
    { id: 1, username: 'alice', rank: 1, shortcode: 'a1' },
    { id: 9, username: 'carol', rank: 1, shortcode: 'c1' },
  ];
  const out = attachTopReels(accounts, reels);
  assert.deepStrictEqual(out[0].top_reels.map(r => r.shortcode), ['a1', 'a2']); // rank order
  assert.deepStrictEqual(out[1].top_reels, []); // bob has none
});
