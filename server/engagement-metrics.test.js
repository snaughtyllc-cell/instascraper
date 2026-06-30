const test = require('node:test');
const assert = require('node:assert/strict');
const { calcViewER, enrichViewsVsMedian, median } = require('./engagement-metrics');

test('calcViewER uses views as the denominator', () => {
  assert.deepEqual(calcViewER(90, 10, 1000), { er_percent: 10, er_label: 'Viral' });
  assert.deepEqual(calcViewER(50, 0, 1000), { er_percent: 5, er_label: 'Good' });
  assert.deepEqual(calcViewER(20, 0, 1000), { er_percent: 2, er_label: 'Average' });
  assert.deepEqual(calcViewER(10, 0, 1000), { er_percent: 1, er_label: 'Low' });
  assert.deepEqual(calcViewER(10, 0, 0), { er_percent: 0, er_label: null });
});

test('median handles odd, even, and empty view lists', () => {
  assert.equal(median([100, 300, 200]), 200);
  assert.equal(median([100, 400, 200, 300]), 250);
  assert.equal(median([0, null, undefined]), null);
});

test('enrichViewsVsMedian adds per-account lift scores', () => {
  const posts = [
    { id: 1, account_handle: 'a', view_count: 1800 },
    { id: 2, account_handle: 'b', view_count: 500 },
  ];
  assert.deepEqual(enrichViewsVsMedian(posts, { a: 1000, b: null }), [
    { id: 1, account_handle: 'a', view_count: 1800, account_median_views: 1000, views_vs_median: 1.8 },
    { id: 2, account_handle: 'b', view_count: 500, account_median_views: null, views_vs_median: null },
  ]);
});
