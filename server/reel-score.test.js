const { test } = require('node:test');
const assert = require('node:assert');
const { scoreReels, scoreConfig } = require('./scraper');

const CFG = scoreConfig({}); // defaults: floor 1000, target 1e6, reach 60, erTarget 6, er 40

test('scoreReels: no reels -> 0', () => {
  assert.strictEqual(scoreReels([], CFG), 0);
  assert.strictEqual(scoreReels(null, CFG), 0);
  assert.strictEqual(scoreReels(undefined, CFG), 0);
});

test('scoreReels: 1M views + 6% ER -> 100 (both maxed)', () => {
  // 6% view-ER = (likes+comments)/views*100 => 60000/1e6*100 = 6
  assert.strictEqual(scoreReels([{ viewCount: 1_000_000, likeCount: 60_000, commentCount: 0 }], CFG), 100);
});

test('scoreReels: 100K views + 3% ER -> ~60 (40 reach + 20 er)', () => {
  assert.strictEqual(scoreReels([{ viewCount: 100_000, likeCount: 3_000, commentCount: 0 }], CFG), 60);
});

test('scoreReels: reach-only (1M views, 0 engagement) -> 60', () => {
  assert.strictEqual(scoreReels([{ viewCount: 1_000_000, likeCount: 0, commentCount: 0 }], CFG), 60);
});

test('scoreReels: engagement-only (floor views, 10% ER) -> 40 (reach 0, er capped)', () => {
  // 1000 views = floor => reach 0; ER 10% > target 6 => er capped at 40
  assert.strictEqual(scoreReels([{ viewCount: 1_000, likeCount: 100, commentCount: 0 }], CFG), 40);
});

test('scoreReels: views at/above target are capped at full reach', () => {
  assert.strictEqual(scoreReels([{ viewCount: 50_000_000, likeCount: 0, commentCount: 0 }], CFG), 60);
});

test('scoreReels: a reel with 0 views contributes 0 ER, not a crash', () => {
  assert.strictEqual(scoreReels([{ viewCount: 0, likeCount: 5, commentCount: 5 }], CFG), 0);
});

test('scoreReels: averages across reels', () => {
  // avgViews = (1e6 + 1e4)/2 = 505000 -> log10~5.70 -> (5.70-3)/3=0.90*60=54.1
  // avgER = (6% + 0%)/2 = 3% -> 3/6*40 = 20 ; total ~= round(54.1+20)=74
  const s = scoreReels([
    { viewCount: 1_000_000, likeCount: 60_000, commentCount: 0 },
    { viewCount: 10_000, likeCount: 0, commentCount: 0 },
  ], CFG);
  assert.ok(s >= 72 && s <= 76, `expected ~74, got ${s}`);
});

test('scoreConfig: defaults + env override + non-numeric fallback', () => {
  const d = scoreConfig({});
  assert.deepStrictEqual(d, { viewFloor: 1000, viewTarget: 1000000, reachWeight: 60, erTarget: 6, erWeight: 40 });
  const e = scoreConfig({ SUGGEST_REACH_WEIGHT: '70', SUGGEST_ER_WEIGHT: 'nope' });
  assert.strictEqual(e.reachWeight, 70);
  assert.strictEqual(e.erWeight, 40); // bad value -> default
});
